import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parsePhotoShares, nativePhotoShares, type PhotoShare } from "./photos.ts";
import { photoNotePath, preparePhotoShare } from "./photo-actions.ts";
import { deleteMany, getAll, getBlob, importPhotoShare, openDb, photoImportPath, putMany, PHOTO_IMPORTS_STORE } from "./idb.ts";
import { createModel, present, type NoteRecord } from "./model.ts";

const id = "12345678-1234-4123-8123-123456789abc";
const share: PhotoShare = { id, receivedAt: new Date("2026-10-22T11:30:00Z").getTime(),
  files: [{ key: "0", name: "camera.jpg", mime: "image/jpeg" }, { key: "1", name: "second.jpg", mime: "image/jpeg" }] };
const record = (path: string, body: string, encoding: "utf8" | "base64" = "utf8"): NoteRecord =>
  ({ path, body, baseSha: null, pending: true, deleted: false, encoding });

describe("native photo boundary", () => {
  const raw = () => ({ batches: [{ ...share, schema: 1 }] });
  it("parses a batch without leaking raw native objects into the loop", () => {
    expect(parsePhotoShares(raw())).toEqual([share]);
    expect(parsePhotoShares({ batches: [] })).toEqual([]);
  });
  it("rejects unsupported schemas, duplicate IDs, invalid keys and non-image metadata", () => {
    expect(() => parsePhotoShares({ batches: [{ ...share, schema: 2 }] })).toThrow();
    expect(() => parsePhotoShares({ batches: [raw().batches[0], raw().batches[0]] })).toThrow();
    for (const patch of [{ id: "../secret" }, { receivedAt: NaN }, { files: [] },
      { files: [{ key: "../0", name: "x", mime: "image/jpeg" }] },
      { files: [{ key: "0", name: "x", mime: "image/svg+xml" }] }])
      expect(() => parsePhotoShares({ batches: [{ ...raw().batches[0], ...patch }] })).toThrow();
  });
  it("is inert in browser builds", async () => {
    const photos = nativePhotoShares();
    expect(photos.supported).toBe(false);
    expect(await photos.pending()).toEqual([]);
    (await photos.listen(() => { throw new Error("unexpected native event"); }))();
  });
});

describe("photo preparation", () => {
  it("reuses the attachment action and keeps photos in selected order", async () => {
    const prepared = await preparePhotoShare(share, "inbox/new.md", async (_id, file) =>
      new File([file.key], file.name, { type: file.mime }), async file => file.arrayBuffer());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const { note, attachments } = prepared.value;
    expect(attachments).toHaveLength(2);
    expect(note.body).toBe(`# Photo\n\n![](${attachments[0]!.record.path})\n\n![](${attachments[1]!.record.path})\n`);
    expect(attachments.every(a => a.record.encoding === "base64" && a.record.body === "")).toBe(true);
    expect(attachments[0]!.base64).toBe(btoa("0"));
    expect(attachments[1]!.base64).toBe(btoa("1"));
  });
  it("returns no partial import when a later photo cannot be read", async () => {
    const result = await preparePhotoShare(share, "inbox/new.md", async (_id, file) => {
      if (file.key === "1") throw new Error("grant lost");
      return new File(["photo"], file.name, { type: file.mime });
    }, async file => file.arrayBuffer());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("imageUnreadable");
  });
  it("never chooses a path already occupied by a note", () => {
    const first = photoNotePath(share, new Set());
    expect(first).toMatch(/^inbox\/Photo .*12345678.md$/);
    expect(photoNotePath(share, new Set([first]))).not.toBe(first);
  });
});

describe("durable photo handoff", () => {
  let db: IDBDatabase;
  beforeEach(async () => {
    await new Promise<void>(resolve => { const r = indexedDB.deleteDatabase("notes"); r.onsuccess = () => resolve(); });
    db = await openDb();
  });
  afterEach(() => db.close());
  const note = record("inbox/Photo.md", "# Photo\n\n![](attachments/photo.webp)");
  const attachment = { record: record("attachments/photo.webp", "", "base64"), base64: "cGhvdG8=" };

  it("commits the note, bytes, metadata and receipt together", async () => {
    const saved = await importPhotoShare(db, id, note, [attachment]);
    expect(saved.alreadyImported).toBe(false);
    expect(await getAll(db)).toHaveLength(2);
    expect(await getBlob(db, attachment.record.path)).toBe(attachment.base64);
    expect(await photoImportPath(db, id)).toBe(note.path);
  });
  it("a retried native share cannot recreate a note deliberately deleted after import", async () => {
    await importPhotoShare(db, id, note, [attachment]);
    await deleteMany(db, [note.path]);
    const retried = await importPhotoShare(db, id, { ...note, path: "inbox/duplicate.md" }, [attachment]);
    expect(retried.alreadyImported).toBe(true);
    expect((await getAll(db)).some(n => n.path === note.path || n.path === "inbox/duplicate.md")).toBe(false);
  });
  it("a destination collision aborts the entire transaction without overwriting the note", async () => {
    await putMany(db, [{ ...note, body: "existing edits" }]);
    await expect(importPhotoShare(db, id, note, [attachment])).rejects.toThrow();
    expect((await getAll(db))[0]!.body).toBe("existing edits");
    expect(await getBlob(db, attachment.record.path)).toBeNull();
    expect(await photoImportPath(db, id)).toBeNull();
  });
  it("does not reset the SHA or pending state of an existing synced attachment", async () => {
    const synced = { ...attachment.record, baseSha: "synced-sha", pending: false };
    await putMany(db, [synced]);
    const saved = await importPhotoShare(db, id, note, [attachment]);
    expect(saved.attachments[0]).toEqual(synced);
    expect((await getAll(db)).find(n => n.path === synced.path)).toEqual(synced);
  });
  it("a corrupt receipt cannot discard a still-pending native share", async () => {
    const tx = db.transaction(PHOTO_IMPORTS_STORE, "readwrite");
    tx.objectStore(PHOTO_IMPORTS_STORE).put({ broken: true }, id);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    await expect(photoImportPath(db, id)).rejects.toThrow();
    await expect(importPhotoShare(db, id, note, [attachment])).rejects.toThrow();
    expect(await getAll(db)).toEqual([]);
  });
  it("an aborted blob write rolls back even earlier note and attachment writes", async () => {
    const bad = { record: record("attachments/bad.webp", "", "base64"),
      base64: (() => {}) as unknown as string };
    await expect(importPhotoShare(db, id, note, [attachment, bad])).rejects.toThrow();
    expect(await getAll(db)).toEqual([]);
    expect(await getBlob(db, attachment.record.path)).toBeNull();
    expect(await photoImportPath(db, id)).toBeNull();
  });
  it("upgrades an existing version-2 vault without losing unsynced notes or image bytes", async () => {
    db.close();
    await new Promise<void>(resolve => { const r = indexedDB.deleteDatabase("notes"); r.onsuccess = () => resolve(); });
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("notes", 2);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("notes", { keyPath: "path" });
        r.result.createObjectStore("blobs");
      };
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    const tx = old.transaction(["notes", "blobs"], "readwrite");
    tx.objectStore("notes").put(note);
    tx.objectStore("notes").put(attachment.record);
    tx.objectStore("blobs").put(attachment.base64, attachment.record.path);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    old.close();
    db = await openDb();
    expect(db.version).toBe(3);
    expect(await getAll(db)).toHaveLength(2);
    expect((await getAll(db)).find(n => n.path === note.path)).toEqual(note);
    expect(await getBlob(db, attachment.record.path)).toBe(attachment.base64);
    expect(await photoImportPath(db, id)).toBeNull();
  });
  it("presents an already-saved import without changing existing drafts or requiring another save", async () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [{ ...record("draft.md", "unsynced draft"), dirty: true }] });
    m.persistBlocked = true;
    present(m, { kind: "photoShareImported", note, attachments: [attachment.record] });
    expect(m.notes.get("draft.md")!.body).toBe("unsynced draft");
    expect(m.notes.get("draft.md")!.dirty).toBe(true);
    expect(m.notes.get(note.path)!.dirty).toBe(false);
    expect(m.notes.get(note.path)!.pending).toBe(true);
    expect(m.openPath).toBe(note.path);
    expect(m.persistBlocked).toBe(false);
  });
  it("a photo failure leaves an unrelated in-flight save alone", () => {
    const m = createModel();
    m.persisting = true;
    present(m, { kind: "photoFailed", error: { kind: "photoImportFailed", cause: "disk" } });
    expect(m.persisting).toBe(true);
    expect(m.persistBlocked).toBe(false);
    expect(m.error).toContain("Reopen Notes");
  });
});
