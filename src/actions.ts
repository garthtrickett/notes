// Actions are the impure edge. They touch IndexedDB, they can fail, and they
// end by *returning* a proposal rather than calling present() themselves.
//
// That is what keeps the module graph acyclic — actions never import the loop —
// and it makes every action testable as a plain function from inputs to a
// proposal, with no model and no renderer in sight.

import { attemptAsync } from "./result.ts";
import * as idb from "./idb.ts";
import type { Encoding, Note, NoteRecord, Proposal } from "./model.ts";
import type { Github } from "./github.ts";
import { appendEntry, dumpPathOf } from "./dump.ts";
import {
  attachmentPath,
  base64Of,
  isBinaryPath,
  insertAt,
  MAX_BYTES,
  shortHash,
  type Shrinker,
} from "./attachments.ts";

export const hydrate = async (db: IDBDatabase): Promise<Proposal> => {
  const read = await attemptAsync(
    () => idb.getAll(db),
    (cause) => `Could not read your notes from this device: ${String(cause)}`,
  );
  if (!read.ok) return { kind: "failed", message: read.error };

  const notes: Note[] = read.value.map((r) => ({
    ...r,
    // Older records predate the field; text is the safe reading.
    encoding: r.encoding ?? "utf8",
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
  const written: NoteRecord[] = notes.map(
    ({ path, body, baseSha, pending, deleted, encoding }) => ({
      path,
      body,
      baseSha,
      pending,
      deleted,
      encoding,
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

    const encoding: Encoding = isBinaryPath(path) ? "base64" : "utf8";
    const body = await github.read(path, encoding);
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
      encoding,
    });
  }

  // Known to GitHub before, absent now — which *might* mean deleted by someone
  // else. The Trees API lags a moment behind a write, so a file created seconds
  // ago can be missing from a manifest that is otherwise current.
  //
  // Deleting a note is the most destructive thing this app does, so a manifest
  // omission is not enough on its own. Confirm each disappearance against the
  // Contents API, which reads back a write immediately. Costs one request per
  // vanished file, and files rarely vanish.
  const suspected = [...local.values()].filter(
    (n) => n.baseSha !== null && !remote.has(n.path) && !n.deleted,
  );

  const gone: string[] = [];
  for (const note of suspected) {
    const check = await github.read(note.path, note.encoding);
    if (!check.ok && check.error.kind === "notFound") {
      gone.push(note.path);
      continue;
    }
    // Anything else — it still exists, or the network faltered — means leave it
    // alone. A later pull will settle it.
  }

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
  const written = await github.write(
    note.path,
    body,
    note.baseSha,
    note.encoding,
  );

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

// Capture appends to today's dump file, creating it if the day has not started
// yet. Synchronous and pure apart from the clock, so it is two proposals rather
// than an async action.
export const captureProposals = (
  notes: ReadonlyMap<string, Note>,
  text: string,
  now: () => number,
): Proposal[] => {
  if (text.trim() === "") return [];
  const at = now();
  const path = dumpPathOf(at);
  const existing = notes.get(path);

  if (!existing || existing.deleted) {
    return [
      { kind: "created", path },
      { kind: "edited", path, body: appendEntry("", text, at) },
    ];
  }
  return [
    { kind: "edited", path, body: appendEntry(existing.body, text, at) },
  ];
};

export const attach = async (
  file: Blob,
  into: Note,
  cursor: number,
  now: () => number,
  shrink: Shrinker,
): Promise<Proposal> => {
  const shrunk = await attemptAsync(
    () => shrink(file),
    (cause) => `Could not read that image: ${String(cause)}`,
  );
  if (!shrunk.ok) return { kind: "failed", message: shrunk.error };

  if (shrunk.value.byteLength > MAX_BYTES) {
    const mb = (shrunk.value.byteLength / 1_000_000).toFixed(1);
    return {
      kind: "failed",
      message: `That image is still ${mb} MB after resizing, so it was not added. Git keeps binaries forever.`,
    };
  }

  const hash = await attemptAsync(
    () => shortHash(shrunk.value),
    () => "Could not hash the image.",
  );
  if (!hash.ok) return { kind: "failed", message: hash.error };

  const path = attachmentPath(now(), hash.value);
  return {
    kind: "attached",
    path,
    base64: base64Of(shrunk.value),
    into: into.path,
    body: insertAt(into.body, cursor, `![](${path})`),
  };
};
