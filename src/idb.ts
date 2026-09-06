// Raw IndexedDB, not idb-keyval: the wrapper cannot express a multi-key
// transaction, and phase 2's outbox needs one.
//
// One record per note, keyed by path. Never one blob holding the whole
// collection — that would rewrite every note on every keystroke, which is the
// write amplification that made gafu's store O(n) per edit.

const DB_NAME = "notes";
const DB_VERSION = 1;
export const NOTES_STORE = "notes";

export interface NoteRecord {
  readonly path: string;
  readonly body: string;
}

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
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains(NOTES_STORE)) {
      req.result.createObjectStore(NOTES_STORE, { keyPath: "path" });
    }
  };
  return request(req);
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
  const tx = db.transaction(NOTES_STORE, "readwrite");
  const store = tx.objectStore(NOTES_STORE);
  queueAll(tx, paths, (path) => void store.delete(path));
  await commit(tx);
};
