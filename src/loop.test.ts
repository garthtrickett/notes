import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getAll, openDb, putMany } from "./idb.ts";
import { boot, createLoop, type Deps, type Loop } from "./loop.ts";
import type { Note } from "./model.ts";
import { emptyLocation, type ViewLocation } from "./view-location.ts";

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

describe("appearance", () => {
  it("switches without replacing the editor or losing edits and undo history", async () => {
    const changes: string[] = [];
    const loop = createLoop({ ...localOnly(), theme: "light", onThemeChanged: t => changes.push(t) }, root);
    loop.propose({ kind: "hydrated", notes: [record("test.md", "Original")] });
    loop.propose({ kind: "opened", path: "test.md" });
    await settle(loop);
    const editor = root.querySelector<HTMLElement>(".cm-editor");
    if (!editor) throw new Error("no editor");
    const cm = EditorView.findFromDOM(editor);
    if (!cm) throw new Error("no editor view");
    cm.dispatch({ changes: { from: 8, insert: " and an edit" }, selection: { anchor: 8 } });
    await settle(loop);
    root.querySelector<HTMLButtonElement>(".theme-button")!.click();
    await settle(loop);
    expect(loop.model.theme).toBe("dark");
    expect(changes).toEqual(["dark"]);
    expect(root.querySelector(".cm-editor")).toBe(editor);
    expect(cm.state.selection.main.head).toBe(8);
    expect(loop.model.notes.get("test.md")?.body).toBe("Original and an edit");
    root.querySelector<HTMLButtonElement>("#undo-edit")!.click();
    await settle(loop);
    expect(loop.model.notes.get("test.md")?.body).toBe("Original");
    for (const mode of ["dump", "tasks", "archive", "trash", "settings"] as const) {
      loop.propose({ kind: "modeChanged", mode });
      await settle(loop);
      expect(root.querySelector(".theme-button")?.getAttribute("aria-label")).toBe("Switch to light theme");
    }
    loop.dispose();
  });
});

describe("audio storage test entry", () => {
  it("opens only on an explicit request and reports failure through the model", async () => {
    let opened = 0;
    const loop = createLoop({ ...localOnly(), audioStorageTest: {
      supported: true,
      open: async () => { opened++; return { ok: false, error: "Storage screen unavailable" }; },
    } }, root);
    loop.propose({ kind: "hydrated", notes: [] });
    loop.propose({ kind: "modeChanged", mode: "settings" });
    await loop.flush();
    expect(root.textContent).toContain("Audio storage test");
    expect(opened).toBe(0);
    loop.propose({ kind: "audioStorageTestRequested" });
    await loop.flush();
    expect(opened).toBe(1);
    expect(loop.model.error).toBe("Storage screen unavailable");
    loop.propose({ kind: "modeChanged", mode: "notes" });
    loop.propose({ kind: "modeChanged", mode: "settings" });
    await loop.flush();
    expect(opened).toBe(1);
  });

  it("keeps the entry hidden in unsupported browser builds", async () => {
    const loop = createLoop({ ...localOnly(), audioStorageTest: {
      supported: false, open: async () => ({ ok: true, value: undefined }),
    } }, root);
    loop.propose({ kind: "hydrated", notes: [] });
    loop.propose({ kind: "modeChanged", mode: "settings" });
    await loop.flush();
    expect(root.textContent).not.toContain("Audio storage test");
  });
});

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

  it("persists a ticked box exactly like a typed edit", async () => {
    // This is the entire contract the tasks view relies on: the button sends
    // an edited proposal with one character flipped, and everything below
    // treats it as typing.
    const loop = await boot(localOnly(), root);
    loop.propose({ kind: "created", path: "a.md" });
    await settle(loop);
    loop.propose({ kind: "edited", path: "a.md", body: "- [ ] milk\n" });
    await settle(loop);
    loop.propose({ kind: "edited", path: "a.md", body: "- [x] milk\n" });
    await settle(loop);

    expect((await getAll(theDb())).map((r) => [r.path, r.body])).toEqual([
      ["a.md", "- [x] milk\n"],
    ]);
    expect(loop.model.notes.get("a.md")?.dirty).toBe(false);
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

  it("removes a purged note from the model", async () => {
    const loop = await boot(localOnly(), root);
    loop.propose({ kind: "created", path: "a.md" });
    await settle(loop);
    loop.propose({ kind: "purged", path: "a.md" });
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
    loop.propose({ kind: "opened", path: "a.md" });
    await paint();

    const rows = root.querySelectorAll(".row");
    expect(rows.length).toBe(2);
    expect(rows[0]?.classList.contains("open")).toBe(true);
    expect(root.textContent).toContain("b.md");
  });

// The editor is CodeMirror, so its text lives in an EditorState rather than on
// an element. Everything below asks it the same two questions a textarea was
// asked before: what does it hold, and where is the caret.
const editorView = (): EditorView | null => {
  const host = root.querySelector<HTMLElement>("#editor-host");
  return host === null ? null : EditorView.findFromDOM(host);
};
const editorText = (): string => editorView()?.state.doc.toString() ?? "";
const caretAt = (): number => editorView()?.state.selection.main.head ?? -1;
const putCaret = (at: number): void => {
  editorView()?.dispatch({ selection: EditorSelection.cursor(at) });
};

  it("does not write over the editor while the model catches up", async () => {
    const loop = createLoop(localOnly(), root);
    loop.propose({
      kind: "hydrated",
      notes: [record("a.md", "hello")],
    });
    loop.propose({ kind: "opened", path: "a.md" });
    await paint();

    expect(editorText()).toBe("hello");

    // Typing, as the editor sees it: it already holds the new text and the model
    // is catching up. The paint that follows must leave both alone.
    editorView()!.dispatch({ changes: { from: 5, insert: " world" } });
    putCaret(11);
    loop.propose({ kind: "edited", path: "a.md", body: "hello world" });
    await paint();

    expect(editorText()).toBe("hello world");
    expect(caretAt()).toBe(11);
  });

  it("undoes and redoes through the buttons, and the model follows", async () => {
    const loop = createLoop(localOnly(), root);
    loop.propose({
      kind: "hydrated",
      notes: [record("a.md", "hello")],
    });
    await paint();
    loop.propose({ kind: "opened", path: "a.md" });
    await paint();

    const undo = root.querySelector<HTMLButtonElement>("#undo-edit");
    const redo = root.querySelector<HTMLButtonElement>("#redo-edit");
    if (undo === null || redo === null) throw new Error("no undo buttons");
    // A fresh note: nothing to undo, and both buttons say so.
    expect(undo.disabled).toBe(true);
    expect(redo.disabled).toBe(true);

    editorView()?.dispatch({ changes: { from: 5, insert: " world" } });
    await settle(loop);
    expect(loop.model.notes.get("a.md")?.body).toBe("hello world");
    expect(undo.disabled).toBe(false);

    undo.click();
    await settle(loop);
    expect(editorText()).toBe("hello");
    expect(loop.model.notes.get("a.md")?.body).toBe("hello");
    expect(redo.disabled).toBe(false);

    redo.click();
    await settle(loop);
    expect(editorText()).toBe("hello world");
    expect(loop.model.notes.get("a.md")?.body).toBe("hello world");
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

    expect(editorText()).toBe("B body");
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

describe("deleting for good reaches the device, not just the model", () => {
  it("keeps a deleted note deleted across a reload", async () => {
    const first = await boot(localOnly(), root);
    first.propose({ kind: "created", path: "a.md" });
    first.propose({ kind: "edited", path: "a.md", body: "delete me" });
    await settle(first);
    expect((await getAll(theDb())).map((r) => r.path)).toEqual(["a.md"]);

    first.propose({ kind: "purged", path: "a.md" });
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

    loop.propose({ kind: "purged", path: "a.md" });
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
    loop.propose({ kind: "purged", path: "a.md" });
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

    loop.propose({ kind: "pulled", notes: [], gone: ["a.md"], remaining: 0 });
    await settle(loop);
    expect(await getAll(theDb())).toEqual([]);
  });
});

describe("the path box after a refused rename", () => {
  it("goes back to naming the note that is actually open", async () => {
    const loop = createLoop(localOnly(), root);
    loop.propose({
      kind: "hydrated",
      notes: [record("a.md", "A"), record("b.md", "B")],
    });
    loop.propose({ kind: "opened", path: "a.md" });
    await paint();

    const field = root.querySelector("input.pathfield") as HTMLInputElement;
    expect(field.value).toBe("a.md");

    // What a refused rename leaves behind: the typed name in the box, and the
    // original note still open. The box used to go on showing b.md.
    field.value = "b.md";
    loop.propose({ kind: "renamed", from: "a.md", to: "b.md" });
    await paint();

    expect(loop.model.openPath).toBe("a.md");
    expect(field.value).toBe("a.md");
  });

  it("leaves the box alone while it is being typed in", async () => {
    const loop = createLoop(localOnly(), root);
    loop.propose({ kind: "hydrated", notes: [record("a.md", "A")] });
    loop.propose({ kind: "opened", path: "a.md" });
    await paint();

    const field = root.querySelector("input.pathfield") as HTMLInputElement;
    field.focus();
    field.value = "half-typed-na";
    loop.propose({ kind: "edited", path: "a.md", body: "A!" });
    await paint();

    // Rewriting under the cursor mid-word would be worse than the bug.
    expect(field.value).toBe("half-typed-na");
  });
});

describe("restoring a tab", () => {
  it("restores each saved view without publishing an intermediate first-note location", async () => {
    await putMany(theDb(), [record("aaa.md", "First"), record("z-last.md", "Last")]);
    for (const mode of ["notes", "dump", "tasks", "archive", "trash", "settings"] as const) {
      const initialView: ViewLocation = { mode, openPath: "z-last.md", preview: true };
      const saved: ViewLocation[] = [];
      const loop = await boot({ ...localOnly(), initialView, onViewChanged: view => saved.push(view) }, root);
      await settle(loop);
      expect(loop.model.mode).toBe(mode);
      expect(loop.model.openPath).toBe("z-last.md");
      expect(loop.model.preview).toBe(true);
      expect(saved).toEqual([initialView]);
      loop.propose({ kind: "resumed" });
      await settle(loop);
      expect(saved).toEqual([initialView]);
      loop.dispose();
    }
  });

  it("keeps preview for a reloaded note URL, but not for a different deep link", async () => {
    await putMany(theDb(), [record("one.md", "One"), record("two.md", "Two")]);
    const initialView: ViewLocation = { mode: "notes", openPath: "one.md", preview: true };
    for (const path of ["one.md", "two.md"]) {
      const loop = await boot({ ...localOnly(), initialView }, root, path);
      await settle(loop);
      expect(loop.model.openPath).toBe(path);
      expect(loop.model.preview).toBe(path === "one.md");
      loop.dispose();
    }
  });

  it("a fresh root does not choose the first cached note", async () => {
    await putMany(theDb(), [record("aaa.md", "First")]);
    const loop = await boot(localOnly(), root);
    await settle(loop);
    expect(loop.model.openPath).toBeNull();
    loop.propose({ kind: "pulled", notes: [record("b.md", "Other")], gone: [], remaining: 0 });
    await settle(loop);
    expect(loop.model.openPath).toBeNull();
    loop.dispose();
  });

  it("an explicit note link overrides the remembered tab and waits for its actual note", async () => {
    await putMany(theDb(), [record("aaa.md", "First")]);
    const navigations: string[] = [];
    const loop = await boot({ ...localOnly(), initialView: { ...emptyLocation, mode: "dump" },
      navigate: url => navigations.push(url) }, root, "not-yet-cached.md");
    await settle(loop);
    expect(loop.model.openPath).toBeNull();
    expect(navigations).toEqual(["/not-yet-cached.md"]);
    loop.propose({ kind: "pulled", notes: [record("not-yet-cached.md", "Arrived")], gone: [], remaining: 0 });
    await settle(loop);
    expect(loop.model.openPath).toBe("not-yet-cached.md");
    expect(loop.model.mode).toBe("notes");
    expect(navigations).toEqual(["/not-yet-cached.md"]);
    loop.dispose();
  });

  it("records root-to-root mode changes even though their URLs are identical", async () => {
    const saved: ViewLocation[] = [];
    const loop = await boot({ ...localOnly(), onViewChanged: view => saved.push(view) }, root);
    await settle(loop);
    for (const mode of ["dump", "tasks", "archive"] as const) {
      loop.propose({ kind: "modeChanged", mode });
      await settle(loop);
      expect(saved.at(-1)?.mode).toBe(mode);
    }
    expect(saved.map(view => view.mode)).toEqual(["notes", "dump", "tasks", "archive"]);
    loop.dispose();
  });
});

describe("the address bar", () => {
  const track = (): { calls: Array<[string, string]>; deps: Deps } => {
    const calls: Array<[string, string]> = [];
    return {
      calls,
      deps: { ...localOnly(), navigate: (url, title) => void calls.push([url, title]) },
    };
  };

  it("names the open note, and says so once", async () => {
    const { calls, deps } = track();
    const loop = await boot(deps, root);
    loop.propose({ kind: "created", path: "health/markers.md" });
    await settle(loop);

    expect(calls.at(-1)).toEqual(["/health/markers.md", "markers — notes"]);
    // Repainting is not navigating. Every paint reporting the same place would
    // be a history entry per keystroke.
    const before = calls.length;
    loop.propose({ kind: "edited", path: "health/markers.md", body: "typed" });
    await settle(loop);
    expect(calls.length).toBe(before);
  });

  it("goes back to the root when the note is left behind", async () => {
    const { calls, deps } = track();
    const loop = await boot(deps, root);
    loop.propose({ kind: "created", path: "a.md" });
    await settle(loop);
    loop.propose({ kind: "modeChanged", mode: "dump" });
    await settle(loop);

    expect(calls.at(-1)).toEqual(["/", "notes"]);
  });

  it("follows a rename, so a bookmark is never left pointing at nothing", async () => {
    const { calls, deps } = track();
    const loop = await boot(deps, root);
    loop.propose({ kind: "created", path: "a.md" });
    await settle(loop);
    loop.propose({ kind: "renamed", from: "a.md", to: "b.md" });
    await settle(loop);

    expect(calls.at(-1)).toEqual(["/b.md", "b — notes"]);
  });

  it("opens the note a cold load asked for, not the one hydrating picked", async () => {
    const first = await boot(localOnly(), root);
    first.propose({ kind: "created", path: "aaa.md" });
    first.propose({ kind: "created", path: "zzz.md" });
    await settle(first);

    document.body.innerHTML = '<div id="app"></div>';
    const second = await boot(
      localOnly(),
      document.getElementById("app") as HTMLElement,
      "zzz.md",
    );
    await paint();
    expect(second.model.openPath).toBe("zzz.md");
  });

  it("ignores a link to a note this device has not synced yet", async () => {
    // Rather than an error toast, which reads as the app being broken when the
    // truth is only that the pull has not finished.
    const loop = await boot(localOnly(), root, "never/seen.md");
    await paint();
    expect(loop.model.error).toBeNull();
  });
});
