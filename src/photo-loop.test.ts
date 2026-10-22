import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { boot, type Loop } from "./loop.ts";
import { deleteMany, getAll, getBlob, openDb, photoImportPath } from "./idb.ts";
import type { PhotoShare, PhotoShares } from "./photos.ts";

const batch: PhotoShare = { id: "12345678-1234-4123-8123-123456789abc", receivedAt: 1792661000000,
  files: [{ key: "0", name: "camera.jpg", mime: "image/jpeg" }] };
let db: IDBDatabase;
let root: HTMLElement;
let loops: Loop[];
beforeEach(async () => {
  await new Promise<void>(resolve => { const r = indexedDB.deleteDatabase("notes"); r.onsuccess = () => resolve(); });
  db = await openDb();
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app")!;
  loops = [];
});
afterEach(() => { for (const loop of loops) loop.dispose(); db.close(); });

const start = async (photos?: PhotoShares, shrink: (file: Blob) => Promise<ArrayBuffer> = file => file.arrayBuffer()) => {
  const loop = await boot({ db, github: null, now: () => batch.receivedAt, shrink,
    schedule: (_ms, fire) => void queueMicrotask(fire), ...(photos ? { photoShares: photos } : {}) }, root);
  loops.push(loop);
  await loop.flush();
  return loop;
};
const inbox = () => {
  let waiting: readonly PhotoShare[] = [batch];
  let changed = () => {};
  let reads = 0, acknowledgments = 0;
  const port = {
    supported: true,
    pending: async () => waiting,
    read: async (_id, photo) => { reads++; return new File(["photo bytes"], photo.name, { type: photo.mime }); },
    acknowledge: async () => { acknowledgments++; waiting = []; },
    listen: async callback => { changed = callback; return () => { changed = () => {}; }; },
  } satisfies PhotoShares;
  return { port, set: (value: readonly PhotoShare[]) => { waiting = value; }, emit: () => changed(),
    reads: () => reads, acknowledgments: () => acknowledgments };
};
const button = (text: string): HTMLButtonElement =>
  [...root.querySelectorAll("button")].find(b => b.textContent === text)!;
const pick = (files: File[]) => {
  const input = root.querySelector<HTMLInputElement>("[data-photo-picker]")!;
  Object.defineProperty(input, "files", { value: files });
  input.dispatchEvent(new Event("change"));
};

describe("Android share delivery", () => {
  it("imports a cold-start share offline and acknowledges only after the bytes and note are durable", async () => {
    const source = inbox();
    source.port.acknowledge = async () => {
      const path = await photoImportPath(db, batch.id);
      expect(path).not.toBeNull();
      const notes = await getAll(db);
      expect(notes.find(n => n.path === path)?.body).toContain("![](attachments/");
      const image = notes.find(n => n.encoding === "base64")!;
      expect(await getBlob(db, image.path)).toBe(btoa("photo bytes"));
      source.set([]);
    };
    const loop = await start(source.port);
    expect(loop.model.openPath).toMatch(/^inbox\/Photo /);
    expect(loop.model.notes.size).toBe(2);
    expect(loop.model.notes.get(loop.model.openPath!)?.dirty).toBe(false);
  });
  it("handles a warm share without losing the note being edited", async () => {
    const source = inbox(); source.set([]);
    const loop = await start(source.port);
    loop.propose({ kind: "created", path: "draft.md" });
    loop.propose({ kind: "edited", path: "draft.md", body: "important unsynced edits" });
    source.set([batch]); source.emit();
    await loop.flush();
    expect(loop.model.notes.get("draft.md")?.body).toBe("important unsynced edits");
    expect(loop.model.openPath).not.toBe("draft.md");
    expect(source.acknowledgments()).toBe(1);
  });
  it("a lost acknowledgment retries without rereading files or duplicating a renamed photo note", async () => {
    const source = inbox();
    source.port.acknowledge = async () => { throw new Error("bridge lost"); };
    const loop = await start(source.port);
    const path = loop.model.openPath!;
    loop.propose({ kind: "renamed", from: path, to: "my-photo.md" });
    await loop.flush();
    source.port.acknowledge = async () => { source.set([]); };
    loop.propose({ kind: "resumed" });
    await loop.flush();
    expect(source.reads()).toBe(1);
    expect(loop.model.notes.has("my-photo.md")).toBe(true);
    expect([...loop.model.notes.values()].filter(n => n.encoding === "utf8" && !n.deleted)).toHaveLength(1);
  });
  it("a cold retry respects a deliberate deletion after the prior import", async () => {
    const source = inbox();
    source.port.acknowledge = async () => { throw new Error("app interrupted"); };
    const first = await start(source.port);
    const path = first.model.openPath!;
    first.dispose();
    await deleteMany(db, [path]);
    source.port.acknowledge = async () => source.set([]);
    const next = await start(source.port);
    expect(next.model.notes.has(path)).toBe(false);
    expect(source.reads()).toBe(1);
  });
  it("keeps the native source pending when decoding fails and does not create a partial note", async () => {
    const source = inbox();
    const loop = await start(source.port, async () => { throw new Error("decode failed"); });
    expect(source.acknowledgments()).toBe(0);
    expect(await getAll(db)).toEqual([]);
    expect(await photoImportPath(db, batch.id)).toBeNull();
    expect(loop.model.photoShareFailure?.message).toBe("That image could not be read.");
    expect(loop.model.photosBusy).toBe(0);
    button("Discard shared photos").click();
    await loop.flush();
    expect(source.acknowledgments()).toBe(1);
    expect(loop.model.photoShareFailure).toBeNull();
    expect(await getAll(db)).toEqual([]);
  });

  it("retries a failed share on request and clears its recovery controls after saving", async () => {
    const source = inbox();
    let readable = false;
    const loop = await start(source.port, async file => {
      if (!readable) throw new Error("temporary decode failure");
      return file.arrayBuffer();
    });
    expect(loop.model.photoShareFailure?.id).toBe(batch.id);
    readable = true;
    button("Retry").click();
    await loop.flush();
    expect(loop.model.photoShareFailure).toBeNull();
    expect(source.acknowledgments()).toBe(1);
    expect(await getAll(db)).toHaveLength(2);
  });
});

describe("adding a photo inside a note", () => {
  it("preserves the target and caret across navigation and edits while decoding", async () => {
    let release!: (bytes: ArrayBuffer) => void;
    const loop = await start(undefined, () => new Promise(resolve => { release = resolve; }));
    loop.propose({ kind: "created", path: "second.md" });
    loop.propose({ kind: "edited", path: "second.md", body: "second note" });
    loop.propose({ kind: "created", path: "first.md" });
    loop.propose({ kind: "edited", path: "first.md", body: "before after" });
    await loop.flush();
    const editor = EditorView.findFromDOM(root.querySelector(".cm-host")!)!;
    editor.dispatch({ selection: EditorSelection.cursor(7) });
    button("Add photo").click();
    pick([new File(["source"], "photo.jpg", { type: "image/jpeg" })]);
    loop.propose({ kind: "opened", path: "second.md" });
    loop.propose({ kind: "edited", path: "first.md", body: "before after plus typing" });
    release(new TextEncoder().encode("compressed image").buffer);
    await loop.flush();
    expect(loop.model.notes.get("first.md")?.body).toMatch(/^before !\[\]\(attachments\/.*\)after plus typing$/);
    expect(loop.model.notes.get("second.md")?.body).toBe("second note");
    expect(loop.model.openPath).toBe("second.md");
  });
  it("cancelling the picker changes nothing", async () => {
    const loop = await start();
    loop.propose({ kind: "created", path: "note.md" });
    await loop.flush();
    button("Add photo").click();
    const input = root.querySelector<HTMLInputElement>("[data-photo-picker]")!;
    expect(input.accept).toBe("image/*");
    input.dispatchEvent(new Event("cancel"));
    await loop.flush();
    expect(root.querySelector("[data-photo-picker]")).toBeNull();
    expect(loop.model.notes.size).toBe(1);
    expect(loop.model.notes.get("note.md")?.body).toBe("");
  });
  it("offers native camera capture with the same destination, and omits it on web", async () => {
    const source = inbox(); source.set([]);
    const loop = await start(source.port);
    loop.propose({ kind: "created", path: "note.md" });
    await loop.flush();
    button("Take photo").click();
    const input = root.querySelector<HTMLInputElement>("[data-photo-picker]")!;
    expect(input.getAttribute("capture")).toBe("environment");
    expect(input.multiple).toBe(false);
    input.dispatchEvent(new Event("cancel"));
    loop.dispose();
    await start();
    expect(button("Take photo")).toBeUndefined();
  });
});
