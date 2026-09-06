import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getAll, openDb } from "./idb.ts";
import { boot, createLoop, type Deps, type Loop } from "./loop.ts";
import type { Note } from "./model.ts";

const record = (path: string, body: string): Note => ({
  path,
  body,
  baseSha: "sha-0",
  pending: false,
  deleted: false,
  dirty: false,
  encoding: "utf8",
});

let db: IDBDatabase | undefined;
let root: HTMLElement;

const reset = async () => {
  db?.close();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("notes");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
  db = await openDb();
};

const theDb = (): IDBDatabase => {
  if (!db) throw new Error("db was not opened");
  return db;
};

// Phase 1 behaviour is sync-free: no client, so nap() never leaves the device.
const localOnly = (): Deps => ({
  db: theDb(),
  github: null,
  shrink: async () => new ArrayBuffer(0),
  now: () => 1_700_000_000_000,
  schedule: (_ms, fire) => void queueMicrotask(fire),
});

const paint = async () => {
  await new Promise<void>((r) => queueMicrotask(() => r()));
};

const settle = async (loop: Loop) => {
  await loop.flush();
  await paint();
};

beforeEach(async () => {
  await reset();
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app") as HTMLElement;
});

describe("the loop", () => {
  it("boots empty and renders", async () => {
    const loop = await boot(localOnly(), root);
    await paint();
    expect(loop.model.hydrated).toBe(true);
    expect(root.textContent).toContain("No note open.");
  });

  it("persists a created note without being told to", async () => {
    const loop = await boot(localOnly(), root);
    loop.propose({ kind: "created", path: "inbox/a.md" });
    await settle(loop);

    // Nothing called save(). nap() noticed the dirty note and acted.
    const stored = await getAll(theDb());
    expect(stored.map((r) => [r.path, r.body])).toEqual([["inbox/a.md", ""]]);
    expect(loop.model.notes.get("inbox/a.md")?.dirty).toBe(false);
  });

  it("persists an edit", async () => {
    const loop = await boot(localOnly(), root);
    loop.propose({ kind: "created", path: "a.md" });
    await settle(loop);
    loop.propose({ kind: "edited", path: "a.md", body: "hello" });
    await settle(loop);

    expect((await getAll(theDb())).map((r) => [r.path, r.body])).toEqual([
      ["a.md", "hello"],
    ]);
  });

  it("survives a reload — the gate for this phase", async () => {
    const first = await boot(localOnly(), root);
    first.propose({ kind: "created", path: "inbox/thought.md" });
    first.propose({ kind: "edited", path: "inbox/thought.md", body: "kept" });
    await settle(first);

    // Drop everything but the database, exactly as a page refresh would.
    document.body.innerHTML = '<div id="app"></div>';
    const second = await boot(
      localOnly(),
      document.getElementById("app") as HTMLElement,
    );
    await paint();

    expect(second.model.notes.get("inbox/thought.md")?.body).toBe("kept");
    expect(second.model.notes.get("inbox/thought.md")?.dirty).toBe(false);
  });

  it("does not start a second write while one is in flight", async () => {
    const loop = await boot(localOnly(), root);
    loop.propose({ kind: "created", path: "a.md" });
    expect(loop.model.persisting).toBe(true);

    // An edit arriving mid-write must not launch a competing persist.
    loop.propose({ kind: "edited", path: "a.md", body: "typed while saving" });
    expect(loop.model.persisting).toBe(true);

    await settle(loop);
    // ...and the loop comes back for it, so the edit is not stranded.
    expect((await getAll(theDb())).map((r) => [r.path, r.body])).toEqual([
      ["a.md", "typed while saving"],
    ]);
    expect(loop.model.notes.get("a.md")?.dirty).toBe(false);
  });

  it("removes a deleted note from the model", async () => {
    const loop = await boot(localOnly(), root);
    loop.propose({ kind: "created", path: "a.md" });
    await settle(loop);
    loop.propose({ kind: "deleted", path: "a.md" });
    await settle(loop);
    expect(loop.model.notes.size).toBe(0);
  });

  it("renders the note list and marks the open one", async () => {
    const loop = createLoop(localOnly(), root);
    loop.propose({
      kind: "hydrated",
      notes: [
        record("a.md", "A"),
        record("b.md", "B"),
      ],
    });
    await paint();

    const rows = root.querySelectorAll(".row");
    expect(rows.length).toBe(2);
    expect(rows[0]?.classList.contains("open")).toBe(true);
    expect(root.textContent).toContain("b.md");
  });

  it("keeps the editor uncontrolled so the cursor is never yanked", async () => {
    const loop = createLoop(localOnly(), root);
    loop.propose({
      kind: "hydrated",
      notes: [record("a.md", "hello")],
    });
    await paint();

    const editor = root.querySelector("#editor") as HTMLTextAreaElement;
    expect(editor.value).toBe("hello");

    // Simulate typing: the DOM already holds the new text, and the model catches
    // up. A re-render must not write back over the live field.
    editor.value = "hello world";
    editor.setSelectionRange(11, 11);
    loop.propose({ kind: "edited", path: "a.md", body: "hello world" });
    await paint();

    expect(editor.value).toBe("hello world");
    expect(editor.selectionStart).toBe(11);
  });

  it("loads the note body when the open note changes", async () => {
    const loop = createLoop(localOnly(), root);
    loop.propose({
      kind: "hydrated",
      notes: [
        record("a.md", "A body"),
        record("b.md", "B body"),
      ],
    });
    await paint();
    loop.propose({ kind: "opened", path: "b.md" });
    await paint();

    const editor = root.querySelector("#editor") as HTMLTextAreaElement;
    expect(editor.value).toBe("B body");
  });

  it("surfaces a storage failure instead of dying silently", async () => {
    const loop = await boot(localOnly(), root);
    theDb().close(); // every later write now fails

    loop.propose({ kind: "created", path: "a.md" });
    await settle(loop);
    await paint();

    expect(loop.model.error).toContain("Could not save");
    expect(root.textContent).toContain("Could not save");
    expect(loop.model.persisting).toBe(false);
    // The note is still dirty: a failed write must not look like a saved one.
    expect(loop.model.notes.get("a.md")?.dirty).toBe(true);
  });

  it("stops retrying a failing write instead of spinning", async () => {
    const loop = await boot(localOnly(), root);
    theDb().close();

    loop.propose({ kind: "created", path: "a.md" });
    await settle(loop);

    // Without the latch, nap() would see a dirty note, write, fail, and go
    // straight round again — a hot loop for as long as the store is broken.
    expect(loop.model.persistBlocked).toBe(true);
    expect(loop.model.persisting).toBe(false);
  });

  it("tries again after the next user action", async () => {
    const loop = await boot(localOnly(), root);
    theDb().close();
    loop.propose({ kind: "created", path: "a.md" });
    await settle(loop);
    expect(loop.model.persistBlocked).toBe(true);

    // Typing is the only honest signal that things may have changed.
    loop.propose({ kind: "edited", path: "a.md", body: "again" });
    expect(loop.model.persistBlocked).toBe(false);
    await settle(loop);
    expect(loop.model.persistBlocked).toBe(true); // failed again, latched again
  });

  it("clears a stale error once a write succeeds", async () => {
    const loop = await boot(localOnly(), root);
    loop.model.error = "something old";
    loop.propose({ kind: "created", path: "a.md" });
    await settle(loop);
    expect(loop.model.error).toBeNull();
  });
});

afterEach(() => {
  // An open connection blocks deleteDatabase — including from another test file
  // sharing this process — so never leave one behind.
  db?.close();
  db = undefined;
});

describe("deleting reaches the device, not just the model", () => {
  it("keeps a deleted note deleted across a reload", async () => {
    const first = await boot(localOnly(), root);
    first.propose({ kind: "created", path: "a.md" });
    first.propose({ kind: "edited", path: "a.md", body: "delete me" });
    await settle(first);
    expect((await getAll(theDb())).map((r) => r.path)).toEqual(["a.md"]);

    first.propose({ kind: "deleted", path: "a.md" });
    await settle(first);

    // Removing it from the map is not enough: nap() only writes notes it can
    // still see, so without an explicit forget the record survives and the note
    // returns from the dead on the next boot.
    expect(await getAll(theDb())).toEqual([]);

    document.body.innerHTML = '<div id="app"></div>';
    const second = await boot(
      localOnly(),
      document.getElementById("app") as HTMLElement,
    );
    await settle(second);
    expect([...second.model.notes.keys()]).toEqual([]);
  });

  it("forgets a synced note once its remote delete lands", async () => {
    const loop = await boot(localOnly(), root);
    loop.propose({
      kind: "hydrated",
      notes: [{ ...record("a.md", "text"), baseSha: "sha-1" }],
    });
    await settle(loop);

    loop.propose({ kind: "deleted", path: "a.md" });
    await settle(loop);
    // Still a tombstone: the remote has not been told yet.
    expect((await getAll(theDb())).map((r) => [r.path, r.deleted])).toEqual([
      ["a.md", true],
    ]);

    loop.propose({ kind: "removed", path: "a.md" });
    await settle(loop);
    expect(await getAll(theDb())).toEqual([]);
  });

  it("stops forgetting a path that comes back", async () => {
    const loop = await boot(localOnly(), root);
    loop.propose({ kind: "created", path: "a.md" });
    await settle(loop);
    loop.propose({ kind: "deleted", path: "a.md" });
    // Recreated before the forget has been written.
    loop.propose({ kind: "created", path: "a.md" });
    loop.propose({ kind: "edited", path: "a.md", body: "back" });
    await settle(loop);

    // A queued deletion must not erase the note that replaced it.
    expect((await getAll(theDb())).map((r) => [r.path, r.body])).toEqual([
      ["a.md", "back"],
    ]);
    expect(loop.model.forgotten.size).toBe(0);
  });

  it("forgets a note deleted on another device", async () => {
    const loop = await boot(localOnly(), root);
    loop.propose({
      kind: "hydrated",
      notes: [{ ...record("a.md", "text"), baseSha: "sha-1" }],
    });
    await settle(loop);

    loop.propose({ kind: "pulled", notes: [], gone: ["a.md"] });
    await settle(loop);
    expect(await getAll(theDb())).toEqual([]);
  });
});
