import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { deleteMany, getAll, NOTES_STORE, openDb, putMany, getBlob, putBlobs } from "./idb.ts";
import type { NoteRecord } from "./model.ts";

const rec = (path: string, body: string): NoteRecord => ({
  path,
  body,
  baseSha: null,
  pending: false,
  deleted: false,
  encoding: "utf8",
});

let db: IDBDatabase | undefined;

// An open connection blocks deleteDatabase, so the previous one has to be closed
// before the next test can start from empty.
beforeEach(async () => {
  db?.close();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("notes");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
  db = await openDb();
});

const store = (): IDBDatabase => {
  if (!db) throw new Error("db was not opened");
  return db;
};

describe("idb", () => {
  it("round-trips records", async () => {
    await putMany(store(), [
      rec("a.md", "A"),
      rec("b.md", "B"),
    ]);
    const all = (await getAll(store())).sort((x, y) => x.path.localeCompare(y.path));
    expect(all).toEqual([
      rec("a.md", "A"),
      rec("b.md", "B"),
    ]);
  });

  it("writes one record per note, not one blob for the collection", async () => {
    await putMany(store(), [rec("a.md", "A")]);
    await putMany(store(), [rec("b.md", "B")]);

    const count = await new Promise<number>((resolve, reject) => {
      const req = store()
        .transaction(NOTES_STORE, "readonly")
        .objectStore(NOTES_STORE)
        .count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // Two keys, so editing one note rewrites one record — not the whole store.
    expect(count).toBe(2);
  });

  it("overwrites by path rather than duplicating", async () => {
    await putMany(store(), [rec("a.md", "v1")]);
    await putMany(store(), [rec("a.md", "v2")]);
    expect(await getAll(store())).toEqual([rec("a.md", "v2")]);
  });

  it("writes nothing at all when one record in the batch is unstorable", async () => {
    await putMany(store(), [rec("existing.md", "before")]);

    // A value IndexedDB's structured clone cannot handle. It must take the whole
    // transaction down, not land the records that came before it.
    const poisoned = [
      rec("a.md", "A"),
      rec("b.md", (() => {}) as unknown as string),
      rec("c.md", "C"),
    ];

    let threw = false;
    try {
      await putMany(store(), poisoned);
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    const all = await getAll(store());
    expect(all).toEqual([rec("existing.md", "before")]);
  });

  it("deletes in one transaction", async () => {
    await putMany(store(), [
      rec("a.md", "A"),
      rec("b.md", "B"),
      rec("c.md", "C"),
    ]);
    await deleteMany(store(), ["a.md", "c.md"]);
    expect(await getAll(store())).toEqual([rec("b.md", "B")]);
  });

  it("treats an empty batch as a no-op", async () => {
    await putMany(store(), []);
    await deleteMany(store(), []);
    expect(await getAll(store())).toEqual([]);
  });
});

afterEach(() => {
  // An open connection blocks deleteDatabase — including from another test file
  // sharing this process — so never leave one behind.
  db?.close();
  db = undefined;
});

describe("attachment bytes live apart from note metadata", () => {
  it("stores and reads them back", async () => {
    await putBlobs(db!, [{ path: "attachments/a.webp", body: "AAAA" }]);
    expect(await getBlob(db!, "attachments/a.webp")).toBe("AAAA");
  });

  it("says null for bytes this device has never had", async () => {
    expect(await getBlob(db!, "attachments/never.webp")).toBeNull();
  });

  it("writing the record does not disturb the bytes", async () => {
    await putBlobs(db!, [{ path: "attachments/a.webp", body: "AAAA" }]);
    // What persist does: metadata only, with an empty body on the record. The
    // whole reason for two stores is that this cannot reach the bytes.
    await putMany(db!, [
      {
        path: "attachments/a.webp",
        body: "",
        baseSha: "s1",
        pending: false,
        deleted: false,
        encoding: "base64",
      },
    ]);
    expect(await getBlob(db!, "attachments/a.webp")).toBe("AAAA");
  });

  it("deleting a note takes its bytes with it", async () => {
    await putBlobs(db!, [{ path: "attachments/gone.webp", body: "AAAA" }]);
    await putMany(db!, [
      {
        path: "attachments/gone.webp",
        body: "",
        baseSha: null,
        pending: true,
        deleted: false,
        encoding: "base64",
      },
    ]);
    await deleteMany(db!, ["attachments/gone.webp"]);
    // Bytes with no record is a leak nothing would ever collect.
    expect(await getBlob(db!, "attachments/gone.webp")).toBeNull();
    expect((await getAll(db!)).some((r) => r.path === "attachments/gone.webp")).toBe(false);
  });
});
