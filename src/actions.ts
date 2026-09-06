// Actions are the impure edge. They touch IndexedDB, they can fail, and they
// end by *returning* a proposal rather than calling present() themselves.
//
// That is what keeps the module graph acyclic — actions never import the loop —
// and it makes every action testable as a plain function from inputs to a
// proposal, with no model and no renderer in sight.

import { attemptAsync } from "./result.ts";
import * as idb from "./idb.ts";
import type { Note, NoteRecord, Proposal } from "./model.ts";
import type { Github } from "./github.ts";

export const hydrate = async (db: IDBDatabase): Promise<Proposal> => {
  const read = await attemptAsync(
    () => idb.getAll(db),
    (cause) => `Could not read your notes from this device: ${String(cause)}`,
  );
  if (!read.ok) return { kind: "failed", message: read.error };

  const notes: Note[] = read.value.map((r) => ({ ...r, dirty: false }));
  return { kind: "hydrated", notes };
};

export const persist = async (
  db: IDBDatabase,
  notes: readonly Note[],
): Promise<Proposal> => {
  // Snapshot before the await: these exact bodies are what the write covers, and
  // present() compares against them to decide what is still dirty.
  const written: NoteRecord[] = notes.map(
    ({ path, body, baseSha, pending, deleted }) => ({
      path,
      body,
      baseSha,
      pending,
      deleted,
    }),
  );

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

// ---------------------------------------------------------------------------
// Sync. Same rule as above: impure, and ends by returning a proposal.
// ---------------------------------------------------------------------------

export const pull = async (
  github: Github,
  local: ReadonlyMap<string, Note>,
): Promise<Proposal> => {
  const manifest = await github.manifest();
  if (!manifest.ok) return { kind: "syncFailed", error: manifest.error };

  const remote = new Map(manifest.value.map((e) => [e.path, e.sha]));
  const notes: NoteRecord[] = [];

  for (const [path, sha] of remote) {
    const here = local.get(path);
    if (here?.pending) continue; // the push owns this one, conflict included
    if (here && here.baseSha === sha) continue; // unchanged

    const body = await github.read(path);
    if (!body.ok) {
      // A file listed in the manifest and then missing is a race with someone
      // else's delete, not an error worth failing the whole pull over.
      if (body.error.kind === "notFound") continue;
      return { kind: "syncFailed", error: body.error };
    }
    notes.push({
      path,
      body: body.value,
      baseSha: sha,
      pending: false,
      deleted: false,
    });
  }

  // Known to GitHub before, absent now: deleted by someone else.
  const gone = [...local.values()]
    .filter((n) => n.baseSha !== null && !remote.has(n.path) && !n.deleted)
    .map((n) => n.path);

  return { kind: "pulled", notes, gone };
};

// Where a losing local edit goes. Dated, so a second conflict on the same day
// is the caller's problem to notice rather than a silent overwrite.
export const conflictPath = (path: string, now: () => number): string => {
  const date = new Date(now()).toISOString().slice(0, 10);
  const dot = path.lastIndexOf(".");
  const stem = dot === -1 ? path : path.slice(0, dot);
  const ext = dot === -1 ? "" : path.slice(dot);
  return `${stem} (conflict ${date})${ext}`;
};

export const push = async (
  github: Github,
  note: Note,
  now: () => number,
): Promise<Proposal> => {
  if (note.deleted) {
    if (note.baseSha === null) return { kind: "removed", path: note.path };
    const removed = await github.remove(note.path, note.baseSha);
    if (!removed.ok) return { kind: "syncFailed", error: removed.error };
    return { kind: "removed", path: note.path };
  }

  // Snapshot before the await, so present() can tell whether the note moved on
  // while this was in flight.
  const body = note.body;
  const written = await github.write(note.path, body, note.baseSha);

  if (!written.ok) {
    if (written.error.kind === "conflict") {
      return {
        kind: "conflicted",
        path: note.path,
        copyPath: conflictPath(note.path, now),
        body,
      };
    }
    return { kind: "syncFailed", error: written.error };
  }

  return { kind: "pushed", path: note.path, body, sha: written.value };
};
