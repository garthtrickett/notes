// Actions are the impure edge. They touch IndexedDB, they can fail, and they
// end by *returning* a proposal rather than calling present() themselves.
//
// That is what keeps the module graph acyclic — actions never import the loop —
// and it makes every action testable as a plain function from inputs to a
// proposal, with no model and no renderer in sight.

import { attemptAsync, type Result } from "./result.ts";
import type { LocalError } from "./local-error.ts";
import * as idb from "./idb.ts";
import type { Encoding, Note, NoteRecord, Proposal } from "./model.ts";
import type { Github, SyncError } from "./github.ts";
import { appendEntry, dumpPathOf } from "./dump.ts";
import { toggleCheckin, type CheckinSlot } from "./checkins.ts";
import { mergeInsertions } from "./merge.ts";
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
  // An attachment record carries no bytes, and writing it must not be how the
  // bytes in the blob store come to be replaced by nothing. Two stores is
  // precisely so this cannot happen by accident.
  const written: NoteRecord[] = notes.map(
    ({ path, body, baseSha, pending, deleted, encoding }) => ({
      path,
      body: encoding === "base64" ? "" : body,
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

// Bytes arriving from anywhere — a pull, a paste, a drop — land here before the
// proposal that mentions them is made. By the time the model sees the record,
// the bytes it refers to are already stored.
export const storeBlobs = async (
  db: IDBDatabase,
  notes: readonly { path: string; body: string; encoding: Encoding }[],
): Promise<void> => {
  const blobs = notes
    .filter((n) => n.encoding === "base64" && n.body !== "")
    .map((n) => ({ path: n.path, body: n.body }));
  if (blobs.length === 0) return;
  await idb.putBlobs(db, blobs);
};

// Pushing an attachment needs the bytes the model does not hold.
export const bodyToPush = async (db: IDBDatabase, note: Note): Promise<string> =>
  note.encoding === "base64" && note.body === ""
    ? ((await idb.getBlob(db, note.path)) ?? "")
    : note.body;

// The Contents API stops carrying content at 1MB. Over that it answers 200 with
// `content: ""` and `encoding: "none"` — not an error, just nothing — so the
// read looked like it worked and the file arrived empty. media.ts then filed
// the path as absent and never asked again, which is why a clip would simply
// not be there: no broken player, no message, the markdown left showing.
//
// Measured against a 1,106,662-byte file in a public repo, unauthenticated:
// size 1106662, content "" of length 0, encoding "none", download_url present.
//
// The Blobs API carries the same bytes up to 100MB, and a pull already knows
// every file's sha from the manifest, so the fallback costs one extra request
// and only for the files that need it.
const readWhateverTheSize = async (
  github: Github,
  path: string,
  sha: string,
  encoding: Encoding,
): Promise<Result<string, SyncError>> => {
  const first = await github.read(path, encoding);
  // An empty file is a real thing and reads the same way, but fetching its
  // blob costs one request and returns empty again, so this does not need to
  // tell them apart.
  if (!first.ok || first.value !== "") return first;
  return github.blob(sha, encoding);
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
    const body = await readWhateverTheSize(github, path, sha, encoding);
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

// One attempt at resolving a lost compare-and-swap without a person. Returns
// null for "could not", never for "failed" — every way this gives up leaves the
// caller to make the copy it always made.
//
// Attachments are excluded outright: their bodies are base64 bytes, and lines
// mean nothing there.
const mergeAndRetry = async (
  github: Github,
  note: Note,
  body: string,
): Promise<Proposal | null> => {
  if (note.encoding === "base64") return null;
  // No base means the file was created on both sides independently. There is
  // no common ancestor, so there is no way to tell an insertion from an edit.
  if (note.baseSha === null) return null;

  const ancestor = await github.blob(note.baseSha, note.encoding);
  if (!ancestor.ok) return null;
  const remote = await github.current(note.path, note.encoding);
  if (!remote.ok) return null;

  const merged = mergeInsertions(ancestor.value, body, remote.value.body);
  if (merged === null) return null;

  // Swapped against what the remote is at *now*, not the stale base — that is
  // the whole reason `current` returns the sha alongside the body.
  const rewritten = await github.write(
    note.path,
    merged,
    remote.value.sha,
    note.encoding,
  );
  // A second conflict means a third device, or the same one again. Do not loop:
  // fall back to the copy and let the next push try afresh.
  if (!rewritten.ok) return null;

  return {
    kind: "merged",
    path: note.path,
    from: body,
    body: merged,
    sha: rewritten.value,
  };
};

export const push = async (
  github: Github,
  note: Note,
  now: () => number,
  known: ReadonlyMap<string, Note> = new Map(),
  bodyOverride: string | null = null,
): Promise<Proposal> => {
  if (note.deleted) {
    if (note.baseSha === null) return { kind: "removed", path: note.path };
    const removed = await github.remove(note.path, note.baseSha);
    if (!removed.ok) return { kind: "syncFailed", error: removed.error };
    return { kind: "removed", path: note.path };
  }

  // Snapshot before the await, so present() can tell whether the note moved on
  // while this was in flight. An attachment's bytes come from the blob store,
  // because the model does not carry them.
  const body = bodyOverride ?? note.body;
  const written = await github.write(
    note.path,
    body,
    note.baseSha,
    note.encoding,
  );

  if (!written.ok) {
    if (written.error.kind === "conflict") {
      // Both devices added lines and neither overwrote anything? Then there is
      // nothing for a person to decide, and a copy is just litter. Anything
      // else — or any failure gathering the evidence — falls through to the
      // copy, which is the answer that is always safe.
      const merged = await mergeAndRetry(github, note, body);
      if (merged !== null) return merged;
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

// Ticking a check-in is capture's shape: the day file may not exist yet, and
// the first tick is what creates it. Nothing is written before that, so two
// devices opening the dump on the same morning do not race to seed a file.
export const checkinProposals = (
  notes: ReadonlyMap<string, Note>,
  slot: CheckinSlot,
  now: () => number,
): Proposal[] => {
  const at = now();
  const path = dumpPathOf(at);
  const existing = notes.get(path);

  if (!existing || existing.deleted) {
    return [
      { kind: "created", path },
      { kind: "edited", path, body: toggleCheckin("", slot) },
    ];
  }
  const body = toggleCheckin(existing.body, slot);
  if (body === existing.body) return [];
  return [{ kind: "edited", path, body }];
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
    // The model does the insertion, against the note as it is when the image is
    // ready rather than as it was when the paste happened.
    cursor,
    ref: `![](${path})`,
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
