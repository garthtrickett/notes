// Raw IndexedDB, not idb-keyval: the wrapper cannot express a multi-key
// transaction, and phase 2's outbox needs one.
//
// One record per note, keyed by path. Never one blob holding the whole
// collection — that would rewrite every note on every keystroke, which is the
// write amplification that made gafu's store O(n) per edit.

import type { NoteRecord } from "./model.ts";

const DB_NAME = "notes";
const DB_VERSION = 2;
export const NOTES_STORE = "notes";
// Attachment bytes live apart from note metadata, and that separation is the
// point rather than tidiness. The model holds every note; if the bytes sat on
// the same record, holding a note would mean holding megabytes of video, and
// any write of the metadata would have to carry the bytes along or erase them.
export const BLOBS_STORE = "blobs";

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

// Resolves on the transaction completing, not on the individual requests
// succeeding. That difference is what makes "all or nothing" observable: a
// failure anywhere aborts the transaction and nothing lands.
const commit = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });

export const openDb = (): Promise<IDBDatabase> => {
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = (event) => {
    const db = req.result;
    if (!db.objectStoreNames.contains(NOTES_STORE)) {
      db.createObjectStore(NOTES_STORE, { keyPath: "path" });
    }
    if (!db.objectStoreNames.contains(BLOBS_STORE)) {
      db.createObjectStore(BLOBS_STORE);
    }
    // Anything already stored keeps its bytes: move them across rather than
    // asking the next sync to fetch every attachment again.
    if ((event.oldVersion ?? 0) < 2 && req.transaction) {
      const notes = req.transaction.objectStore(NOTES_STORE);
      const blobs = req.transaction.objectStore(BLOBS_STORE);
      const cursor = notes.openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return;
        const record = c.value as NoteRecord;
        if (record.encoding === "base64" && record.body !== "") {
          blobs.put(record.body, record.path);
          c.update({ ...record, body: "" });
        }
        c.continue();
      };
    }
  };
  return request(req);
};

// One attachment's bytes, or null when this device has never had them.
export const getBlob = async (
  db: IDBDatabase,
  path: string,
): Promise<string | null> => {
  const value = await request(
    db.transaction(BLOBS_STORE, "readonly").objectStore(BLOBS_STORE).get(path),
  );
  return typeof value === "string" ? value : null;
};

export const putBlobs = async (
  db: IDBDatabase,
  blobs: readonly { readonly path: string; readonly body: string }[],
): Promise<void> => {
  if (blobs.length === 0) return;
  const tx = db.transaction(BLOBS_STORE, "readwrite");
  const store = tx.objectStore(BLOBS_STORE);
  queueAll(tx, blobs, (b) => void store.put(b.body, b.path));
  await commit(tx);
};

export const getAll = (db: IDBDatabase): Promise<NoteRecord[]> =>
  request(
    db.transaction(NOTES_STORE, "readonly").objectStore(NOTES_STORE).getAll(),
  ) as Promise<NoteRecord[]>;

// A request can throw *synchronously* — put() raises DataCloneError on a value
// it cannot serialize. Without the abort, the transaction would go on to commit
// whatever was queued before the throw, which is exactly the partial write this
// module exists to prevent.
const queueAll = <T>(
  tx: IDBTransaction,
  items: readonly T[],
  enqueue: (item: T) => void,
): void => {
  try {
    for (const item of items) enqueue(item);
  } catch (cause) {
    tx.abort();
    throw cause;
  }
};

export const putMany = async (
  db: IDBDatabase,
  records: readonly NoteRecord[],
): Promise<void> => {
  if (records.length === 0) return;
  const tx = db.transaction(NOTES_STORE, "readwrite");
  const store = tx.objectStore(NOTES_STORE);
  queueAll(tx, records, (record) => void store.put(record));
  await commit(tx);
};

export const deleteMany = async (
  db: IDBDatabase,
  paths: readonly string[],
): Promise<void> => {
  if (paths.length === 0) return;
  // Both stores in one transaction: a note whose metadata is gone but whose
  // bytes are not is a leak nothing would ever collect.
  const tx = db.transaction([NOTES_STORE, BLOBS_STORE], "readwrite");
  const notes = tx.objectStore(NOTES_STORE);
  const blobs = tx.objectStore(BLOBS_STORE);
  queueAll(tx, paths, (path) => {
    notes.delete(path);
    blobs.delete(path);
  });
  await commit(tx);
};
