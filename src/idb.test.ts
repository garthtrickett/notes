import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { deleteMany, getAll, NOTES_STORE, openDb, putMany } from "./idb.ts";
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
