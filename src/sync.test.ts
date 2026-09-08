import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getAll, getBlob, openDb } from "./idb.ts";
import * as actions from "./actions.ts";
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
      if (current !== baseSha) return err({ kind: "conflict" });
      const sha = `sha-${nextSha++}`;
      files.set(path, { body, sha });
      return ok(sha);
    },
    remove: async (path, baseSha) => {
      calls.push(`remove ${path}`);
      if (failWith) return err(failWith);
      const existing = files.get(path);
      if (existing && existing.sha !== baseSha) {
        return err({ kind: "conflict" });
      }
      files.delete(path);
      return ok(undefined);
    },
    // History is read-only and is never reached by sync; the fake keeps one
    // revision per file so the panel has something to show.
    history: async (path) => {
      calls.push(`history ${path}`);
      if (failWith) return err(failWith);
      const f = files.get(path);
      return f
        ? ok([
            {
              sha: f.sha,
              when: "2026-09-06T00:00:00Z",
              message: `notes: ${path}`,
              author: "someone",
            },
          ])
        : ok([]);
    },
    readAt: async (path, ref) => {
      calls.push(`readAt ${path}@${ref}`);
      if (failWith) return err(failWith);
      const f = files.get(path);
      return f && f.sha === ref ? ok(f.body) : err({ kind: "notFound" });
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

// The push waits for typing to stop, so a test that wants the push wants the
// pause with it: move the clock past the quiet period and run whatever the loop
// asked to be woken for. Anything scheduled *after* this — a retry cooldown —
// is left where it is, for the test to inspect.
const quiet = async (loop: Loop) => {
  clock += 5_000;
  for (const fire of scheduled.splice(0)) fire();
  await settle(loop);
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
    await quiet(loop);

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
  it("holds the push while you are still typing", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "created", path: "a.md" });
    loop.propose({ kind: "edited", path: "a.md", body: "h" });
    await settle(loop);
    loop.propose({ kind: "edited", path: "a.md", body: "he" });
    await settle(loop);

    // Nothing has left the device yet. Without this a sentence arrived at
    // GitHub as a dozen commits, one per keystroke that happened to settle.
    expect(remote.files.has("a.md")).toBe(false);

    await quiet(loop);
    // And then it goes, once, carrying the finished text rather than a prefix.
    expect(remote.files.get("a.md")?.body).toBe("he");
  });

  it("a note being typed does not hold up one that is finished with", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "created", path: "old.md" });
    loop.propose({ kind: "edited", path: "old.md", body: "done" });
    await settle(loop);
    clock += 5_000; // old.md has gone quiet

    loop.propose({ kind: "created", path: "new.md" });
    loop.propose({ kind: "edited", path: "new.md", body: "typing" });
    await settle(loop);

    // The quiet period is per note, so the one you left alone still goes.
    expect(remote.files.get("old.md")?.body).toBe("done");
    expect(remote.files.has("new.md")).toBe(false);
  });

  it("sends a new note and records the sha it came back with", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "created", path: "a.md" });
    loop.propose({ kind: "edited", path: "a.md", body: "hello" });
    await quiet(loop);

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
    await quiet(loop);

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
    await quiet(loop);

    expect(loop.model.openPath).toBe("a (conflict 2023-11-14).md");
  });
});

describe("flush", () => {
  it("waits for a sync in flight, not only a local write", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "created", path: "a.md" });

    // Deliberately bare: no extra microtask hop afterwards. Checking only
    // `persisting` let this return with a push still running, so callers papered
    // over it with their own wait and the gap stayed hidden.
    await loop.flush();

    expect(loop.model.syncing).toBe(false);
    expect(loop.model.persisting).toBe(false);
    expect(remote.files.has("a.md")).toBe(true);
  });

  it("settles a push that triggers a further pull", async () => {
    remote.put("other.md", "theirs");
    const loop = await boot(deps(), root);
    loop.propose({ kind: "created", path: "a.md" });
    await loop.flush();

    expect(loop.model.syncing).toBe(false);
    expect(loop.model.notes.get("other.md")?.body).toBe("theirs");
  });
});

describe("rate limiting", () => {
  it("waits as long as GitHub asked, not as long as the backoff guessed", async () => {
    remote.fail({ kind: "rateLimited", retryAfterMs: 15 * 60_000 });
    const loop = await boot(deps(), root);
    loop.propose({ kind: "created", path: "a.md" });
    await settle(loop);

    // Doubling from a second towards a sixty-second cap would burn requests
    // against a window fifteen minutes wide.
    expect(loop.model.retryAt).toBe(clock + 15 * 60_000);
    expect(loop.model.syncError).toEqual({
      kind: "rateLimited",
      retryAfterMs: 15 * 60_000,
    });
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
    await quiet(loop);
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

describe("the history panel over the wire", () => {
  it("fetches the revisions, then the body of the one chosen", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [] });
    loop.propose({ kind: "created", path: "a.md" });
    loop.propose({ kind: "edited", path: "a.md", body: "on github" });
    await quiet(loop);

    loop.propose({ kind: "historyOpened", path: "a.md" });
    await settle(loop);
    expect(remote.calls).toContain("history a.md");
    const sha = remote.files.get("a.md")!.sha;
    expect(loop.model.history?.revisions?.[0]?.sha).toBe(sha);

    loop.propose({ kind: "revisionOpened", sha });
    await settle(loop);
    expect(remote.calls).toContain(`readAt a.md@${sha}`);
    expect(loop.model.history?.viewingBody).toBe("on github");
  });

  it("says so in the panel when GitHub cannot be reached", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [] });
    loop.propose({ kind: "created", path: "a.md" });
    await settle(loop);

    remote.fail({ kind: "offline" });
    loop.propose({ kind: "historyOpened", path: "a.md" });
    await settle(loop);
    expect(loop.model.history?.error).toBe("No history while offline.");
    // The note itself is fine; only the panel failed.
    expect(loop.model.error).toBeNull();
  });
});

describe("importing a vault someone filled from the GitHub side", () => {
  const manyRemote = (count: number, prefix = "imported") => {
    for (let i = 0; i < count; i += 1) {
      remote.put(`${prefix}/note-${String(i).padStart(3, "0")}.md`, `body ${i}`);
    }
  };

  // Driven through the action rather than the loop: one call, one proposal, so
  // the batch boundary is observable instead of racing the scheduler.
  it("hands back a batch and says how much is left", async () => {
    manyRemote(450);
    const first = await actions.pull(remote.github, new Map());
    if (first.kind !== "pulled") throw new Error(`got ${first.kind}`);
    expect(first.notes.length).toBe(200);
    expect(first.remaining).toBe(250);
  });

  it("skips on the next batch what the last one already brought", async () => {
    manyRemote(450);
    const first = await actions.pull(remote.github, new Map());
    if (first.kind !== "pulled") throw new Error(`got ${first.kind}`);
    const local = new Map(
      first.notes.map((n) => [n.path, { ...n, dirty: false } as Note]),
    );
    const second = await actions.pull(remote.github, local);
    if (second.kind !== "pulled") throw new Error(`got ${second.kind}`);
    expect(second.notes.length).toBe(200);
    expect(second.remaining).toBe(50);
    // None of the first batch was fetched twice.
    expect(second.notes.some((n) => local.has(n.path))).toBe(false);
  });

  it("does not mistake an unfetched file for a remote delete", async () => {
    manyRemote(300);
    // A local note GitHub no longer lists would normally be checked. Mid-import
    // the local map is deliberately incomplete, so that check is not run at all.
    const first = await actions.pull(remote.github, new Map());
    if (first.kind !== "pulled") throw new Error(`got ${first.kind}`);
    expect(first.gone).toEqual([]);
    expect(remote.calls.filter((c) => c.startsWith("read ")).length).toBe(200);
  });

  it("still checks for deletes on the last batch", async () => {
    remote.put("stays.md", "here");
    const local = new Map<string, Note>([
      [
        "vanished.md",
        {
          path: "vanished.md",
          body: "was here",
          baseSha: "sha-old",
          pending: false,
          deleted: false,
          dirty: false,
          encoding: "utf8",
        },
      ],
    ]);
    const result = await actions.pull(remote.github, local);
    if (result.kind !== "pulled") throw new Error(`got ${result.kind}`);
    expect(result.remaining).toBe(0);
    expect(result.gone).toEqual(["vanished.md"]);
  });

  it("keeps what already landed when a later batch fails", async () => {
    manyRemote(300);
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [] });
    await settle(loop);
    const landed = loop.model.notes.size;
    expect(landed).toBeGreaterThan(0);

    remote.fail({ kind: "github", status: 500 });
    await settle(loop);
    // A failed batch costs one batch, not the import.
    expect(loop.model.notes.size).toBe(landed);
    // And the backoff owns the retry rather than nap spinning on it.
    expect(loop.model.pullRemaining).toBe(0);
  });

  it("gets all the way there", async () => {
    manyRemote(450);
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [] });
    for (let round = 0; round < 10 && loop.model.notes.size < 450; round += 1) {
      await settle(loop);
    }
    expect(loop.model.notes.size).toBe(450);
    expect(loop.model.pullRemaining).toBe(0);
  });
});

describe("attachment bytes stay out of the model", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("pushes bytes it never held in memory", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [] });
    loop.propose({ kind: "created", path: "a.md" });
    await settle(loop);

    await actions.storeBlobs(db as IDBDatabase, [
      { path: "attachments/x.webp", body: png, encoding: "base64" },
    ]);
    loop.propose({
      kind: "attached",
      path: "attachments/x.webp",
      base64: png,
      into: "a.md",
      cursor: 0,
      ref: "![](attachments/x.webp)",
    });
    await settle(loop);
    await settle(loop);

    // The model carries the record and not the picture...
    expect(loop.model.notes.get("attachments/x.webp")?.body).toBe("");
    // ...and the push still sent the bytes, fetched from the blob store.
    expect(remote.files.get("attachments/x.webp")?.body).toBe(png);
  });

  it("puts pulled bytes in the blob store, not on the record", async () => {
    remote.put("attachments/y.webp", png);
    remote.put("note.md", "![](attachments/y.webp)");
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [] });
    await settle(loop);

    expect(loop.model.notes.get("attachments/y.webp")?.encoding).toBe("base64");
    expect(loop.model.notes.get("attachments/y.webp")?.body).toBe("");
    expect(await getBlob(db as IDBDatabase, "attachments/y.webp")).toBe(png);
  });

  it("persisting a note never erases the bytes beside it", async () => {
    remote.put("attachments/z.webp", png);
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [] });
    await settle(loop);
    // Several rounds of persist and push, which is where an empty body on the
    // record would have overwritten the real one.
    for (let i = 0; i < 3; i++) await settle(loop);
    expect(await getBlob(db as IDBDatabase, "attachments/z.webp")).toBe(png);
  });
});

describe("an attachment push settles", () => {
  it("does not push the same bytes over and over", async () => {
    const png = "AAAA";
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [] });
    loop.propose({ kind: "created", path: "a.md" });
    await settle(loop);
    await actions.storeBlobs(db as IDBDatabase, [
      { path: "attachments/p.webp", body: png, encoding: "base64" },
    ]);
    loop.propose({
      kind: "attached",
      path: "attachments/p.webp",
      base64: png,
      into: "a.md",
      cursor: 0,
      ref: "![](attachments/p.webp)",
    });
    for (let i = 0; i < 4; i++) await settle(loop);

    // The bytes are not on the record, so comparing them to what was pushed
    // never matched and the note never stopped being pending.
    expect(loop.model.notes.get("attachments/p.webp")?.pending).toBe(false);
    const writes = remote.calls.filter((c) => c === "write attachments/p.webp");
    expect(writes.length).toBe(1);
  });
});
