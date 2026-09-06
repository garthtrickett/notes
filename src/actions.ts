// Actions are the impure edge. They touch IndexedDB, they can fail, and they
// end by *returning* a proposal rather than calling present() themselves.
//
// That is what keeps the module graph acyclic — actions never import the loop —
// and it makes every action testable as a plain function from inputs to a
// proposal, with no model and no renderer in sight.

import { attemptAsync } from "./result.ts";
import * as idb from "./idb.ts";
import type { Note, NoteRecord, Proposal } from "./model.ts";

export const hydrate = async (db: IDBDatabase): Promise<Proposal> => {
  const read = await attemptAsync(
    () => idb.getAll(db),
    (cause) => `Could not read your notes from this device: ${String(cause)}`,
  );
  if (!read.ok) return { kind: "failed", message: read.error };

  const notes: Note[] = read.value.map((r) => ({
    path: r.path,
    body: r.body,
    dirty: false,
  }));
  return { kind: "hydrated", notes };
};

export const persist = async (
  db: IDBDatabase,
  notes: readonly Note[],
): Promise<Proposal> => {
  // Snapshot before the await: these exact bodies are what the write covers, and
  // present() compares against them to decide what is still dirty.
  const written: NoteRecord[] = notes.map((n) => ({
    path: n.path,
    body: n.body,
  }));

  const wrote = await attemptAsync(
    () => idb.putMany(db, written),
    (cause) => `Could not save to this device: ${String(cause)}`,
  );
  if (!wrote.ok) return { kind: "failed", message: wrote.error };

  return { kind: "persisted", written };
};

export const forget = async (
  db: IDBDatabase,
  paths: readonly string[],
): Promise<Proposal> => {
  const removed = await attemptAsync(
    () => idb.deleteMany(db, paths),
    (cause) => `Could not delete from this device: ${String(cause)}`,
  );
  if (!removed.ok) return { kind: "failed", message: removed.error };

  return { kind: "persisted", written: [] };
};
