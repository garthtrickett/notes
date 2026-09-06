import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getAll, openDb } from "./idb.ts";
import { boot, type Deps, type Loop } from "./loop.ts";
import { err, ok } from "./result.ts";
import type { Github, SyncError } from "./github.ts";
import { conflictPath, pull } from "./actions.ts";
import type { Note } from "./model.ts";

// A GitHub that lives in a Map. Everything about sync is then testable with no
// network and no timing.
const fakeGithub = () => {
  const files = new Map<string, { body: string; sha: string }>();
  let nextSha = 1;
  let failWith: SyncError | null = null;
  const calls: string[] = [];

  const github: Github = {
    manifest: async () => {
      calls.push("manifest");
      if (failWith) return err(failWith);
      return ok([...files.entries()].map(([path, f]) => ({ path, sha: f.sha })));
    },
    read: async (path, _encoding) => {
      calls.push(`read ${path}`);
      if (failWith) return err(failWith);
      const f = files.get(path);
      return f ? ok(f.body) : err({ kind: "notFound" });
    },
    write: async (path, body, baseSha, _encoding) => {
      calls.push(`write ${path}`);
      if (failWith) return err(failWith);
      const existing = files.get(path);
      // The compare-and-swap, which is the whole conflict mechanism.
      const current = existing?.sha ?? null;
      if (current !== baseSha) return err({ kind: "conflict", remoteSha: current });
      const sha = `sha-${nextSha++}`;
      files.set(path, { body, sha });
      return ok(sha);
    },
    remove: async (path, baseSha) => {
      calls.push(`remove ${path}`);
      if (failWith) return err(failWith);
      const existing = files.get(path);
      if (existing && existing.sha !== baseSha) {
        return err({ kind: "conflict", remoteSha: existing.sha });
      }
      files.delete(path);
      return ok(undefined);
    },
  };

  return {
    github,
    files,
    calls,
    put: (path: string, body: string) => {
      files.set(path, { body, sha: `sha-${nextSha++}` });
    },
    fail: (e: SyncError | null) => {
      failWith = e;
    },
  };
};

let db: IDBDatabase | undefined;
let root: HTMLElement;
let remote: ReturnType<typeof fakeGithub>;
let clock = 1_700_000_000_000;
const scheduled: (() => void)[] = [];

const deps = (): Deps => ({
  db: db as IDBDatabase,
  github: remote.github,
  shrink: async () => new ArrayBuffer(0),
  now: () => clock,
  // Timers are captured rather than run, so a cooldown is inspected instead of
  // waited for.
  schedule: (_ms, fire) => void scheduled.push(fire),
});

const settle = async (loop: Loop) => {
  await loop.flush();
  await new Promise<void>((r) => queueMicrotask(() => r()));
};

beforeEach(async () => {
  db?.close();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("notes");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
  db = await openDb();
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app") as HTMLElement;
  remote = fakeGithub();
  clock = 1_700_000_000_000;
  scheduled.length = 0;
});

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("pull", () => {
  it("brings down notes that only exist remotely", async () => {
    remote.put("inbox/a.md", "from github");
    const loop = await boot(deps(), root);
    await settle(loop);

    expect(loop.model.notes.get("inbox/a.md")?.body).toBe("from github");
    expect(loop.model.notes.get("inbox/a.md")?.pending).toBe(false);
    expect(loop.model.notes.get("inbox/a.md")?.baseSha).not.toBeNull();
  });

  it("does not refetch a note whose sha has not moved", async () => {
    remote.put("a.md", "v1");
    const first = await boot(deps(), root);
    await settle(first);

    remote.calls.length = 0;
    const second = await boot(deps(), root);
    await settle(second);

    expect(remote.calls.filter((c) => c.startsWith("read"))).toEqual([]);
  });

  it("leaves a note with unpushed edits alone, so the push owns the conflict", async () => {
    remote.put("a.md", "theirs");
    remote.put("b.md", "also theirs");

    const local = new Map<string, Note>([
      [
        "a.md",
        {
          path: "a.md",
          body: "mine",
          baseSha: "sha-old",
          pending: true,
          deleted: false,
          dirty: false,
          encoding: "utf8",
        },
      ],
    ]);

    const proposal = await pull(remote.github, local);
    if (proposal.kind !== "pulled") throw new Error("expected a pull");

    // b.md comes down; a.md is skipped entirely because it is pending. Deciding
    // that collision is the push's job, which keeps conflict handling in one
    // place.
    expect(proposal.notes.map((n) => n.path)).toEqual(["b.md"]);
    expect(remote.calls).not.toContain("read a.md");
  });

  it("hands a local create colliding with an existing remote file to the conflict path", async () => {
    remote.put("a.md", "theirs");
    const loop = await boot(deps(), root);
    loop.propose({ kind: "created", path: "a.md" });
    loop.propose({ kind: "edited", path: "a.md", body: "mine" });
    await settle(loop);

    // Two people made the same path independently. Neither side is discarded.
    expect(loop.model.notes.get("a (conflict 2023-11-14).md")?.body).toBe("mine");
    expect(loop.model.notes.get("a.md")?.body).toBe("theirs");
  });

  it("removes a note deleted on GitHub", async () => {
    remote.put("a.md", "v1");
    const first = await boot(deps(), root);
    await settle(first);
    expect(first.model.notes.has("a.md")).toBe(true);

    remote.files.delete("a.md");
    const second = await boot(deps(), root);
    await settle(second);
    expect(second.model.notes.has("a.md")).toBe(false);
  });

  it("keeps a locally edited note that was deleted on GitHub", async () => {
    remote.put("a.md", "v1");
    const first = await boot(deps(), root);
    await settle(first);

    remote.files.delete("a.md");
    const second = await boot(deps(), root);
    second.propose({ kind: "edited", path: "a.md", body: "still want this" });
    await settle(second);

    expect(second.model.notes.get("a.md")?.body).toBe("still want this");
  });
});

describe("a stale manifest", () => {
  it("does not delete a note the manifest has not caught up with yet", async () => {
    remote.put("a.md", "v1");
    const first = await boot(deps(), root);
    await settle(first);
    expect(first.model.notes.get("a.md")?.baseSha).not.toBeNull();

    // The Trees API lags behind a write, so the file is missing from the
    // manifest while still readable. This is what happens moments after
    // creating a note, and it must not look like a deletion.
    const entry = remote.files.get("a.md");
    remote.files.delete("a.md");
    const stale: typeof remote.github = {
      ...remote.github,
      read: async (path, encoding) =>
        path === "a.md" ? ok("v1") : remote.github.read(path, encoding),
    };

    const proposal = await pull(stale, first.model.notes);
    if (proposal.kind !== "pulled") throw new Error("expected a pull");
    expect(proposal.gone).toEqual([]);
    remote.files.set("a.md", entry!);
  });

  it("still deletes a note the Contents API confirms is gone", async () => {
    remote.put("a.md", "v1");
    const loop = await boot(deps(), root);
    await settle(loop);

    remote.files.delete("a.md");
    const proposal = await pull(remote.github, loop.model.notes);
    if (proposal.kind !== "pulled") throw new Error("expected a pull");
    expect(proposal.gone).toEqual(["a.md"]);
  });

  it("leaves it alone when the check itself fails", async () => {
    remote.put("a.md", "v1");
    const loop = await boot(deps(), root);
    await settle(loop);

    remote.files.delete("a.md");
    const flaky: typeof remote.github = {
      ...remote.github,
      read: async () => err({ kind: "offline" }),
    };
    const proposal = await pull(flaky, loop.model.notes);
    if (proposal.kind !== "pulled") throw new Error("expected a pull");
    // An unreachable network is not evidence of a deletion.
    expect(proposal.gone).toEqual([]);
  });
});

describe("push", () => {
  it("sends a new note and records the sha it came back with", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "created", path: "a.md" });
    loop.propose({ kind: "edited", path: "a.md", body: "hello" });
    await settle(loop);

    expect(remote.files.get("a.md")?.body).toBe("hello");
    const note = loop.model.notes.get("a.md");
    expect(note?.pending).toBe(false);
    expect(note?.baseSha).toBe(remote.files.get("a.md")?.sha ?? "");
  });

  it("survives a reload with the edit still queued", async () => {
    remote.fail({ kind: "offline" });
    const first = await boot(deps(), root);
    first.propose({ kind: "created", path: "a.md" });
    first.propose({ kind: "edited", path: "a.md", body: "queued" });
    await settle(first);
    expect(first.model.notes.get("a.md")?.pending).toBe(true);

    // pending is persisted, so a fresh boot still knows to push.
    remote.fail(null);
    const second = await boot(deps(), root);
    await settle(second);
    expect(remote.files.get("a.md")?.body).toBe("queued");
  });

  it("deletes remotely, then drops the tombstone", async () => {
    remote.put("a.md", "v1");
    const loop = await boot(deps(), root);
    await settle(loop);

    loop.propose({ kind: "deleted", path: "a.md" });
    await settle(loop);

    expect(remote.files.has("a.md")).toBe(false);
    expect(loop.model.notes.has("a.md")).toBe(false);
  });
});

describe("conflict", () => {
  it("keeps both versions when the note moved on GitHub — the gate", async () => {
    remote.put("a.md", "original");
    const loop = await boot(deps(), root);
    await settle(loop);

    // Edit here...
    loop.propose({ kind: "edited", path: "a.md", body: "my version" });
    // ...while someone else edits the same note there.
    remote.put("a.md", "their version");
    await settle(loop);

    const copy = "a (conflict 2023-11-14).md";
    expect(loop.model.notes.get(copy)?.body).toBe("my version");
    expect(loop.model.notes.get("a.md")?.body).toBe("their version");
    // Nothing was merged and nothing was lost.
    expect(remote.files.get(copy)?.body).toBe("my version");
    expect(remote.files.get("a.md")?.body).toBe("their version");
  });

  it("opens the conflict copy so it is not silently filed away", async () => {
    remote.put("a.md", "original");
    const loop = await boot(deps(), root);
    await settle(loop);
    loop.propose({ kind: "edited", path: "a.md", body: "mine" });
    remote.put("a.md", "theirs");
    await settle(loop);

    expect(loop.model.openPath).toBe("a (conflict 2023-11-14).md");
  });
});

describe("conflict naming", () => {
  it("does not stack a second marker on an already-conflicted copy", () => {
    const at = () => new Date("2026-09-07T10:00:00").getTime();
    expect(conflictPath("a (conflict 2026-09-06).md", at)).toBe(
      "a (conflict 2026-09-07).md",
    );
  });

  it("never returns the path it was given", () => {
    // A conflict copy conflicting again on the same day would otherwise resolve
    // to itself: push, collide, push, forever.
    const at = () => new Date("2026-09-06T10:00:00").getTime();
    const result = conflictPath("a (conflict 2026-09-06).md", at);
    expect(result).not.toBe("a (conflict 2026-09-06).md");
    expect(result).toBe("a (conflict 2026-09-06 2).md");
  });

  it("steps past names already in use", () => {
    const at = () => new Date("2026-09-06T10:00:00").getTime();
    const used = new Set(["a (conflict 2026-09-06).md", "a (conflict 2026-09-06 2).md"]);
    expect(conflictPath("a.md", at, (c) => used.has(c))).toBe(
      "a (conflict 2026-09-06 3).md",
    );
  });

  it("strips a numbered marker rather than nesting one", () => {
    const at = () => new Date("2026-09-07T10:00:00").getTime();
    expect(conflictPath("a (conflict 2026-09-06 3).md", at)).toBe(
      "a (conflict 2026-09-07).md",
    );
  });

  it("marks a clean path normally", () => {
    const at = () => new Date("2026-09-07T10:00:00").getTime();
    expect(conflictPath("inbox/a.md", at)).toBe(
      "inbox/a (conflict 2026-09-07).md",
    );
  });

  it("handles a path with no extension", () => {
    const at = () => new Date("2026-09-07T10:00:00").getTime();
    expect(conflictPath("weird", at)).toBe("weird (conflict 2026-09-07)");
  });
});

describe("failure handling", () => {
  it("keeps the note pending when offline and does not touch the body", async () => {
    remote.fail({ kind: "offline" });
    const loop = await boot(deps(), root);
    loop.propose({ kind: "created", path: "a.md" });
    loop.propose({ kind: "edited", path: "a.md", body: "mine" });
    await settle(loop);

    expect(loop.model.notes.get("a.md")?.body).toBe("mine");
    expect(loop.model.notes.get("a.md")?.pending).toBe(true);
    expect(loop.model.syncError).toEqual({ kind: "offline" });
  });

  it("backs off instead of spinning, and doubles the delay", async () => {
    remote.fail({ kind: "github", status: 500 });
    const loop = await boot(deps(), root);
    loop.propose({ kind: "created", path: "a.md" });
    await settle(loop);

    const firstRetry = loop.model.retryAt;
    expect(firstRetry).toBeGreaterThan(clock);
    expect(loop.model.syncing).toBe(false);
    expect(scheduled.length).toBe(1);

    // Wake up, fail again: the cooldown must lengthen, not repeat.
    const firstDelay = loop.model.retryDelay;
    clock = firstRetry;
    scheduled.pop()?.();
    await settle(loop);
    expect(loop.model.retryDelay).toBe(firstDelay * 2);
  });

  it("recovers once the failure clears", async () => {
    remote.fail({ kind: "github", status: 500 });
    const loop = await boot(deps(), root);
    loop.propose({ kind: "created", path: "a.md" });
    loop.propose({ kind: "edited", path: "a.md", body: "eventually" });
    await settle(loop);
    expect(loop.model.retryAt).toBeGreaterThan(clock);

    remote.fail(null);
    clock = loop.model.retryAt;
    scheduled.pop()?.();
    await settle(loop);

    expect(remote.files.get("a.md")?.body).toBe("eventually");
    expect(loop.model.retryDelay).toBe(0);
    expect(loop.model.syncError).toBeNull();
  });

  it("coming back online clears the cooldown immediately", async () => {
    remote.fail({ kind: "offline" });
    const loop = await boot(deps(), root);
    loop.propose({ kind: "created", path: "a.md" });
    await settle(loop);
    expect(loop.model.online).toBe(false);

    remote.fail(null);
    loop.propose({ kind: "online", online: true });
    await settle(loop);

    expect(loop.model.retryAt).toBe(0);
    expect(remote.files.has("a.md")).toBe(true);
  });

  it("saves locally even when GitHub is unreachable", async () => {
    remote.fail({ kind: "offline" });
    const loop = await boot(deps(), root);
    loop.propose({ kind: "created", path: "a.md" });
    loop.propose({ kind: "edited", path: "a.md", body: "on the train" });
    await settle(loop);

    const stored = await getAll(db as IDBDatabase);
    expect(stored.map((r) => [r.path, r.body, r.pending])).toEqual([
      ["a.md", "on the train", true],
    ]);
  });
});
