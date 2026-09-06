// Actions are the impure edge. They touch IndexedDB, they can fail, and they
// end by *returning* a proposal rather than calling present() themselves.
//
// That is what keeps the module graph acyclic — actions never import the loop —
// and it makes every action testable as a plain function from inputs to a
// proposal, with no model and no renderer in sight.

import { attemptAsync } from "./result.ts";
import type { LocalError } from "./local-error.ts";
import * as idb from "./idb.ts";
import type { Encoding, Note, NoteRecord, Proposal } from "./model.ts";
import type { Github, SyncError } from "./github.ts";
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
    (cause): LocalError => ({ kind: "readFailed", cause: String(cause) }),
  );
  if (!read.ok) return { kind: "failed", error: read.error };

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
    (cause): LocalError => ({ kind: "writeFailed", cause: String(cause) }),
  );
  if (!wrote.ok) return { kind: "failed", error: wrote.error };

  return { kind: "persisted", written };
};

export const forget = async (
  db: IDBDatabase,
  paths: readonly string[],
): Promise<Proposal> => {
  const removed = await attemptAsync(
    () => idb.deleteMany(db, paths),
    (cause): LocalError => ({ kind: "forgetFailed", cause: String(cause) }),
  );
  if (!removed.ok) return { kind: "failed", error: removed.error };

  return { kind: "forgot", paths };
};

// ---------------------------------------------------------------------------
// Sync. Same rule as above: impure, and ends by returning a proposal.
// ---------------------------------------------------------------------------

// Six at a time. A first sync of a large vault is otherwise one round trip per
// file, in series — minutes behind a motionless "Syncing…". Bounded rather than
// unbounded because the manifest can name hundreds of files and GitHub answers a
// flood with a rate limit, which is the failure this is trying to avoid.
const POOL = 6;

// How many files one pull will fetch before handing what it has to the model.
//
// The concurrency above was never the whole problem. A vault someone has just
// filled with a thousand notes from the GitHub side used to fetch all thousand
// and only then show any of them — a minute of motionless "Syncing…" — and a
// failure on the last one threw away the other nine hundred and ninety-nine.
//
// Batching fixes both at once: notes appear as they arrive, and a failure costs
// one batch rather than the lot, because everything already landed has a baseSha
// and the next pull skips it.
const BATCH = 200;

const inPool = async <T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(POOL, items.length) }, worker),
  );
  return results;
};

export const pull = async (
  github: Github,
  local: ReadonlyMap<string, Note>,
): Promise<Proposal> => {
  const manifest = await github.manifest();
  if (!manifest.ok) return { kind: "syncFailed", error: manifest.error };

  const remote = new Map(manifest.value.map((e) => [e.path, e.sha]));

  const allWanted = [...remote].filter(([path, sha]) => {
    const here = local.get(path);
    if (here?.pending) return false; // the push owns this one, conflict included
    return !here || here.baseSha !== sha; // otherwise unchanged
  });

  const wanted = allWanted.slice(0, BATCH);
  const remaining = allWanted.length - wanted.length;

  const fetched = await inPool(wanted, async ([path, sha]) => {
    const encoding: Encoding = isBinaryPath(path) ? "base64" : "utf8";
    const body = await github.read(path, encoding);
    return { path, sha, encoding, body };
  });

  const notes: NoteRecord[] = [];
  for (const { path, sha, encoding, body } of fetched) {
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
  // Only on the last batch. Mid-import the local map is deliberately incomplete,
  // and a missing file that has simply not been fetched yet is not a delete.
  const suspected =
    remaining > 0
      ? []
      : [...local.values()].filter(
          (n) => n.baseSha !== null && !remote.has(n.path) && !n.deleted,
        );

  const checked = await inPool(suspected, async (note) => ({
    path: note.path,
    result: await github.read(note.path, note.encoding),
  }));

  // Anything other than a confirmed 404 — it still exists, or the network
  // faltered — means leave it alone. A later pull will settle it.
  const gone = checked
    .filter(({ result }) => !result.ok && result.error.kind === "notFound")
    .map(({ path }) => path);

  return { kind: "pulled", notes, gone, remaining };
};

const CONFLICT_SUFFIX = / \(conflict \d{4}-\d{2}-\d{2}( \d+)?\)$/;

// Where a losing local edit goes.
//
// Two things this must never do. It must not append a second marker to an
// already-conflicted copy, because each retry would add another without bound.
// And it must not return a path that is already taken — above all the note's
// own path, which is what happens when a conflict copy conflicts again on the
// same day. That one is worse than a long name: the copy collides with itself,
// pushes, collides, and loops forever.
export const conflictPath = (
  path: string,
  now: () => number,
  taken: (candidate: string) => boolean = () => false,
): string => {
  const date = new Date(now()).toISOString().slice(0, 10);
  const dot = path.lastIndexOf(".");
  const stem = (dot === -1 ? path : path.slice(0, dot)).replace(
    CONFLICT_SUFFIX,
    "",
  );
  const ext = dot === -1 ? "" : path.slice(dot);
  // The number goes *inside* the parentheses, so CONFLICT_SUFFIX still matches
  // it and a later conflict strips the whole marker instead of nesting one.
  const candidateFor = (n?: number): string =>
    `${stem} (conflict ${date}${n === undefined ? "" : ` ${n}`})${ext}`;

  const free = (candidate: string): boolean =>
    candidate !== path && !taken(candidate);

  if (free(candidateFor())) return candidateFor();
  for (let n = 2; n <= 99; n += 1) {
    if (free(candidateFor(n))) return candidateFor(n);
  }
  // Unreachable in practice, and still terminating if it were not.
  return candidateFor(now());
};

export const push = async (
  github: Github,
  note: Note,
  now: () => number,
  known: ReadonlyMap<string, Note> = new Map(),
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
        copyPath: conflictPath(note.path, now, (c) => known.has(c)),
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
    (cause): LocalError => ({ kind: "imageUnreadable", cause: String(cause) }),
  );
  if (!shrunk.ok) return { kind: "failed", error: shrunk.error };

  if (shrunk.value.byteLength > MAX_BYTES) {
    return {
      kind: "failed",
      error: { kind: "imageTooBig", bytes: shrunk.value.byteLength },
    };
  }

  const hash = await attemptAsync(
    () => shortHash(shrunk.value),
    (cause): LocalError => ({ kind: "imageUnreadable", cause: String(cause) }),
  );
  if (!hash.ok) return { kind: "failed", error: hash.error };

  const path = attachmentPath(now(), hash.value);
  return {
    kind: "attached",
    path,
    base64: base64Of(shrunk.value),
    into: into.path,
    body: insertAt(into.body, cursor, `![](${path})`),
  };
};

// The history panel. Read-only against the network, and it degrades to a
// message rather than an error banner: not being able to reach GitHub should
// not look like the note is broken.
export const loadHistory = async (
  github: Github,
  path: string,
): Promise<Proposal> => {
  const result = await github.history(path);
  return result.ok
    ? { kind: "historyLoaded", path, revisions: result.value }
    : { kind: "historyFailed", path, reason: describeSync(result.error) };
};

export const loadRevision = async (
  github: Github,
  path: string,
  sha: string,
): Promise<Proposal> => {
  const result = await github.readAt(path, sha);
  return result.ok
    ? { kind: "revisionLoaded", sha, body: result.value }
    : { kind: "historyFailed", path, reason: describeSync(result.error) };
};

const describeSync = (error: SyncError): string => {
  switch (error.kind) {
    case "offline":
      return "No history while offline.";
    case "auth":
      return "GitHub rejected the token.";
    case "rateLimited":
      return "GitHub is rate limiting; try again shortly.";
    case "notFound":
      return "GitHub has never seen this note.";
    case "conflict":
    case "github":
      return "GitHub could not answer.";
  }
};
