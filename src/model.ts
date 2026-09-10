// The model is a mutable container of immutable values.
//
// present() writes note state; everything a Model holds is readonly (principle
// 3). loop.ts additionally writes the in-flight flags — see the header there for
// why that boundary is temporal rather than by field.
//
// Replacing one Note per keystroke costs a small allocation. Replacing the whole
// model would cost one per keystroke for no benefit, since there is exactly one
// writer.

import type { Revision, SyncError } from "./github.ts";
import { resolveLink, rewriteLinks } from "./links.ts";
import { describeProblem, normalizePath, pathProblem, type PathProblem } from "./paths.ts";
import { buildTree, type TreeNode } from "./tree.ts";
import { isDumpPath } from "./dump.ts";
import { insertAt, isAttachmentPath } from "./attachments.ts";
import {
  ARCHIVE,
  TRASH,
  dropTarget,
  filedPath,
  isFiledPath,
  isTrashPath,
  isUnder,
  parentFolder,
  unfiledPath,
  uniquePath,
} from "./paths.ts";
import { SLOTS } from "./checkins.ts";
import { describeLocal, type LocalError } from "./local-error.ts";

// What is stored on this device. The record *is* the outbox entry: `pending`
// lives here rather than in a separate queue, so there is no index that can fall
// out of step with it — which was gafu's one real bug.
export interface NoteRecord {
  readonly path: string;
  readonly body: string;
  // Blob SHA of the remote version last seen. null means it has never existed
  // on GitHub.
  readonly baseSha: string | null;
  // The body differs from what GitHub has. Persisted, so unpushed edits survive
  // closing the tab.
  readonly pending: boolean;
  // A tombstone: gone locally, remote delete not yet landed.
  readonly deleted: boolean;
  // base64 means the body is an attachment's bytes rather than text. Everything
  // else — persistence, the outbox, conflicts, retries — is unchanged by it.
  readonly encoding: Encoding;
}

export interface Note extends NoteRecord {
  // The body differs from what is in IndexedDB. Never persisted — on reload
  // everything read back is by definition clean.
  readonly dirty: boolean;
}

export type Mode = "notes" | "dump" | "tasks" | "archive" | "trash" | "settings";

// The vault is a git branch, so a note's history is its commits. Nothing is
// stored: this is emptied when the panel closes.
export interface Drag {
  readonly from: string;
  readonly folder: boolean;
  // The folder currently under the pointer, or null for the root. `undefined`
  // is not a state: over nothing droppable means the drag shows no preview.
  readonly over: string | null | undefined;
}

export interface History {
  readonly path: string;
  // null until fetched, which is what distinguishes "not asked yet" from
  // "no history".
  revisions: Revision[] | null;
  loading: boolean;
  error: string | null;
  viewingSha: string | null;
  viewingBody: string | null;
}
// A discriminated union rather than a string, because a dialog that asks about
// something has to carry what it is asking about.
export type Modal =
  | { readonly kind: "capture" }
  | { readonly kind: "history" }
  | { readonly kind: "newNote" }
  | { readonly kind: "open" }
  | { readonly kind: "confirmDelete"; readonly path: string; readonly folder: boolean };
export type Encoding = "utf8" | "base64";

export interface Model {
  notes: Map<string, Note>;
  openPath: string | null;
  mode: Mode;
  preview: boolean;
  // Whether the tasks tab shows done work. Off by default: triage is open
  // work, and done is one tap away. Session state like preview — a fresh
  // boot opens clean.
  showDone: boolean;
  query: string;
  // At most one floating box at a time. One field rather than a boolean each, so
  // opening, dismissing and focusing are one rule instead of one per modal.
  modal: Modal | null;
  // What the history panel is showing. Separate from `modal` because it is data
  // being fetched, not a dialog being open.
  history: History | null;
  // Which row the open palette has selected. Lives here rather than in the view
  // because arrow keys move it and the view is a pure function of the model.
  paletteIndex: number;
  // Open folders. Session-lived UI state, deliberately not persisted.
  expanded: Set<string>;
  // Check-ins ticked off today. Device-local rather than vault state — whether
  // this phone reminded you is not something another device needs to know — so
  // it lives in localStorage, loaded at boot and written on every toggle.
  checkinsDone: Set<string>;
  // Self-update state. Device-local like the check-ins: the installed build
  // and its download belong to this phone, not the vault.
  update: UpdateInfo;
  // Which folder the number badges currently count inside, or null for the top
  // level. A digit on a folder scopes to it, so the next digit reaches its
  // children.
  numberScope: string | null;
  // A drag in progress. Held in the model so the tree can be drawn as it would
  // be *after* the drop, which is what makes a drag legible: you see where the
  // thing lands before you commit to it.
  drag: Drag | null;
  hydrated: boolean;
  persisting: boolean;
  syncing: boolean;
  // How much of a large first import is still to come, so the status line can
  // say something and nap knows to go round again.
  pullRemaining: number;
  // Set while a network failure is cooling off. nap() skips until now passes it.
  retryAt: number;
  retryDelay: number;
  online: boolean;
  syncError: SyncError | null;
  lastSyncedAt: number | null;
  // Paths whose record must be dropped from this device. Removing a note from
  // the map is not enough: nap() only ever writes notes it can still see, so a
  // vanished record would linger in IndexedDB and be read back on reload — the
  // note would return from the dead.
  forgotten: Set<string>;
  // Set when a write fails, so nap() stops retrying. Without it a failing store
  // spins: the note is still dirty, so nap starts another write immediately,
  // which fails, forever. Cleared by the next user action, which is the only
  // honest signal that conditions might have changed.
  persistBlocked: boolean;
  error: string | null;
}

export interface UpdateInfo {
  // permission sits between available and downloading: the OS has not yet
  // been told this source may install packages. There is one downloading
  // state, not two, because fetching and saving are now a single native call
  // — nothing in between is observable from here.
  readonly status: "idle" | "available" | "permission" | "fetching" | "failed";
  readonly version: number;
  readonly url: string;
  readonly dismissed: boolean;
  readonly error: string | null;
}

export const idleUpdate: UpdateInfo = {
  status: "idle",
  version: 0,
  url: "",
  dismissed: false,
  error: null,
};

export const createModel = (): Model => ({
  notes: new Map(),
  openPath: null,
  mode: "notes",
  preview: false,
  showDone: false,
  query: "",
  modal: null,
  history: null,
  paletteIndex: 0,
  expanded: new Set(),
  checkinsDone: new Set(),
  update: idleUpdate,
  numberScope: null,
  drag: null,
  hydrated: false,
  persisting: false,
  persistBlocked: false,
  syncing: false,
  pullRemaining: 0,
  retryAt: 0,
  retryDelay: 0,
  online: true,
  syncError: null,
  lastSyncedAt: null,
  forgotten: new Set(),
  error: null,
});

export type Proposal =
  | { readonly kind: "hydrated"; readonly notes: readonly Note[] }
  | { readonly kind: "opened"; readonly path: string }
  | { readonly kind: "created"; readonly path: string }
  | { readonly kind: "edited"; readonly path: string; readonly body: string }
  // Into the editor's own history, handled by the loop — the model holds no
  // undo stack, so presenting these changes nothing and must change nothing.
  | { readonly kind: "undoEdit" }
  | { readonly kind: "redoEdit" }
  | { readonly kind: "deleted"; readonly path: string }
  // Out of the vault for good, rather than into the bin.
  | { readonly kind: "purged"; readonly path: string }
  | { readonly kind: "archived"; readonly path: string }
  | { readonly kind: "restored"; readonly path: string }
  | { readonly kind: "persisted"; readonly written: readonly NoteRecord[] }
  | { readonly kind: "forgot"; readonly paths: readonly string[] }
  | { readonly kind: "failed"; readonly error: LocalError }
  | { readonly kind: "online"; readonly online: boolean }
  | { readonly kind: "woke" }
  | {
      readonly kind: "pulled";
      readonly notes: readonly NoteRecord[];
      readonly gone: readonly string[];
      // Files the manifest wants that this batch did not take.
      readonly remaining: number;
    }
  | { readonly kind: "pushed"; readonly path: string; readonly body: string; readonly sha: string }
  | { readonly kind: "removed"; readonly path: string }
  | { readonly kind: "conflicted"; readonly path: string; readonly copyPath: string; readonly body: string }
  | { readonly kind: "syncFailed"; readonly error: SyncError }
  | { readonly kind: "modeChanged"; readonly mode: Mode }
  | { readonly kind: "folderToggled"; readonly path: string }
  | { readonly kind: "folderDeleted"; readonly path: string }
  | { readonly kind: "folderMoved"; readonly from: string; readonly to: string }
  // Which top-level row, counting from zero, as shown in the tree.
  | { readonly kind: "jumped"; readonly index: number }
  | { readonly kind: "checkinToggled"; readonly id: string }
  | { readonly kind: "updateFound"; readonly version: number; readonly url: string }
  | { readonly kind: "updateDismissed" }
  | { readonly kind: "updateStarted" }
  | { readonly kind: "updatePermissionNeeded" }
  | { readonly kind: "updateOpenSettings" }
  | { readonly kind: "updateDownloaded"; readonly path: string }
  | { readonly kind: "updateFailed"; readonly error: string }
  // Back to numbering the top level.
  | { readonly kind: "steppedOut" }
  | { readonly kind: "dragStarted"; readonly from: string; readonly folder: boolean }
  | { readonly kind: "draggedOver"; readonly over: string | null | undefined }
  | { readonly kind: "dragEnded" }
  // A wikilink that could not be followed, so the click can say why.
  | { readonly kind: "linkRefused"; readonly target: string }
  | { readonly kind: "moved"; readonly from: string; readonly to: string }
  | { readonly kind: "resumed" }
  | { readonly kind: "renamed"; readonly from: string; readonly to: string }
  | { readonly kind: "previewToggled" }
  | { readonly kind: "doneVisibilityToggled" }
  | { readonly kind: "searched"; readonly query: string }
  | { readonly kind: "modalOpened"; readonly modal: Modal }
  | { readonly kind: "modalClosed" }
  | { readonly kind: "modalConfirmed" }
  | { readonly kind: "historyOpened"; readonly path: string }
  | {
      readonly kind: "historyLoaded";
      readonly path: string;
      readonly revisions: readonly Revision[];
    }
  | { readonly kind: "historyFailed"; readonly path: string; readonly reason: string }
  | { readonly kind: "revisionOpened"; readonly sha: string }
  | { readonly kind: "revisionLoaded"; readonly sha: string; readonly body: string }
  | { readonly kind: "revisionRestored" }
  | { readonly kind: "paletteMoved"; readonly delta: number }
  | {
      readonly kind: "attached";
      readonly path: string;
      readonly base64: string;
      readonly into: string;
      // Where the caret was when the image was pasted, and what to put there.
      // Deliberately *not* a finished body: shrinking a large image takes a
      // second or more, and a body computed before that second overwrites
      // everything typed during it.
      readonly cursor: number;
      readonly ref: string;
    };

// A tombstone still exists as a record until the remote delete lands, but it is
// not a note any more and must never be shown or opened.
// An attachment's bytes live in the blob store, never on the record the model
// holds. `body` on a base64 record is always "" above this line.
export const withoutBytes = <T extends { encoding: Encoding; body: string }>(
  record: T,
): T => (record.encoding === "base64" ? { ...record, body: "" } : record);

export const visible = (m: Model): Note[] =>
  [...m.notes.values()].filter((n) => !n.deleted);

// The dump, newest day first. One definition, because the view renders it, the
// loop composes the document from it and the split reads it back — three
// answers to "which days, in what order" is three chances to disagree.
export const dumpDays = (m: Model): Note[] =>
  visible(m)
    .filter((n) => isDumpPath(n.path))
    .sort((a, b) => b.path.localeCompare(a.path));

// What the notes view can show and open. An attachment is a record, not a note,
// and a dump day belongs to its own view — opening either puts something in the
// editor that is not text you meant to edit. Defined here rather than in the
// view so there is one answer to "is this a note" (never duplicate rules).
export const openable = (m: Model): Note[] =>
  visible(m).filter(
    (n) => !isDumpPath(n.path) && !isAttachmentPath(n.path) && !isFiledPath(n.path),
  );

// Attachments no note points at any more.
//
// Deliberately not collected automatically. An attachment is unreferenced the
// moment you delete the line above it, and again for the second between cutting
// a paragraph and pasting it back — a collector would take the bytes in that
// gap, and undo would restore a reference to nothing. Nor would it be safe
// across devices: a note written on the phone and not yet pulled here references
// files this device cannot see.
//
// So they are listed, and removing one is something you do on purpose. Notes in
// the bin and the archive count as referring: restoring a note should not find
// its pictures gone.
export const orphanAttachments = (m: Model): Note[] => {
  const referenced = new Set<string>();
  for (const note of visible(m)) {
    if (note.encoding === "base64") continue;
    for (const match of note.body.matchAll(IMAGE_SCAN)) {
      const src = (match[1] ?? "").replace(/^\.?\//, "");
      if (src !== "") referenced.add(src);
    }
  }
  return visible(m)
    .filter(
      (n) =>
        isAttachmentPath(n.path) &&
        // One already in the bin is listed there, above this. Twice in one view
        // would read as two files.
        !isFiledPath(n.path) &&
        !referenced.has(n.path),
    )
    .sort((a, b) => a.path.localeCompare(b.path));
};

const IMAGE_SCAN = /!\[[^\]]*\]\(([^)\s]+)\)/g;

// What the bin and the archive hold. Filed notes are ordinary files that the
// note tree does not show, so this is the same question asked of a prefix.
export const filedIn = (m: Model, folder: string): Note[] =>
  visible(m)
    .filter((n) => n.path.startsWith(`${folder}/`))
    .sort((a, b) => a.path.localeCompare(b.path));

// The tree exactly as the notes view draws it. The view renders this and the
// number shortcuts index into it, so there is one ordering and the badges cannot
// drift from what the digits do (never duplicate rules).
export const noteTree = (m: Model): TreeNode[] =>
  buildTree(previewPaths(m).sort((a, b) => a.path.localeCompare(b.path)));

// Where the dragged thing would end up, or null when the drop would do nothing.
export const dragLanding = (m: Model): string | null => {
  if (m.drag === null || m.drag.over === undefined) return null;
  return dropTarget(m.drag.from, m.drag.over);
};

// The notes as the tree should draw them right now. Mid-drag that is the vault
// as it *would* be, so the row moves under the pointer and the order settles
// around it — and the row is drawn as provisional, so it still reads as a
// question rather than a fact.
const previewPaths = (m: Model): Note[] => {
  const notes = openable(m);
  const landing = dragLanding(m);
  if (m.drag === null || landing === null) return notes;

  const from = m.drag.from;
  if (!m.drag.folder) {
    return notes.map((n) => (n.path === from ? { ...n, path: landing } : n));
  }
  const prefix = `${from}/`;
  return notes.map((n) =>
    n.path.startsWith(prefix)
      ? { ...n, path: `${landing}/${n.path.slice(prefix.length)}` }
      : n,
  );
};

// The rows the digits currently address, and the rows that therefore wear the
// badges. One function, so a badge can never point somewhere its digit does not
// go (never duplicate rules).
export const numberedRows = (m: Model): TreeNode[] => {
  if (m.numberScope === null) return noteTree(m);
  const found = findFolder(noteTree(m), m.numberScope);
  // A scope whose folder has gone — deleted, renamed — falls back to the top
  // level rather than leaving the digits pointing at nothing.
  return found ?? noteTree(m);
};

const findFolder = (nodes: readonly TreeNode[], path: string): TreeNode[] | null => {
  for (const node of nodes) {
    if (node.kind !== "folder") continue;
    if (node.path === path) return [...node.children];
    const deeper = findFolder(node.children, path);
    if (deeper !== null) return deeper;
  }
  return null;
};

// A tombstone does not occupy its path — `checkPath` already ignores them, and
// anything choosing a free name has to agree with it. When it did not, restoring
// a note landed on `a (2).md` while `a.md` sat there apparently free.
const occupied = (m: Model) => {
  const paths = new Set(visible(m).map((n) => n.path));
  return (candidate: string): boolean => paths.has(candidate);
};

// Filing a note is a move, which is why deleting is recoverable from any device
// rather than from the one that did it: the file is still in the repo.
const fileAway = (m: Model, note: Note, folder: string): Rejection | null => {
  const to = uniquePath(filedPath(folder, note.path), occupied(m));
  const rejection = present(m, { kind: "moved", from: note.path, to });
  // `moved` follows the note to its new home, which for a filed note means
  // opening the bin. Stay in the tree instead.
  if (rejection === null && m.openPath !== null && isFiledPath(m.openPath)) {
    m.openPath = firstVisiblePath(m);
  }
  return rejection;
};

const firstVisiblePath = (m: Model): string | null =>
  openable(m)[0]?.path ?? null;

const isOpenable = (note: Note): boolean =>
  !note.deleted &&
  !isDumpPath(note.path) &&
  !isAttachmentPath(note.path) &&
  !isFiledPath(note.path);

// Asking whether a path is usable is a question, so it does not mutate anything.
// Recording the refusal is a separate step, which is what lets each arm phrase
// its own rejection instead of fishing the sentence back out of the model.
interface CheckedPath {
  readonly path: string;
  readonly problem: PathProblem | null;
}

const checkPath = (m: Model, raw: string): CheckedPath => {
  const path = normalizePath(raw);
  return {
    path,
    problem: pathProblem(
      path,
      [...m.notes.values()].filter((n) => !n.deleted).map((n) => n.path),
    ),
  };
};

// A rejection says why. A silent one is how someone ends up typing into a note
// they did not mean to open.
const refusePath = (m: Model, path: string, problem: PathProblem): Rejection => {
  m.error = describeProblem(problem, path);
  return reject(m.error);
};

export interface Rejection {
  readonly reason: string;
}

const reject = (reason: string): Rejection => ({ reason });

// A sync ended well. Four fields have to move together — an arm that sets three
// of them leaves a cooldown in place and wedges the retry loop, so this is a
// rule rather than a shape and does not get duplicated (never duplicate rules).
// Removing a note is two different things depending on whether GitHub has ever
// heard of it, and getting that wrong either strands a record on the device or
// tells GitHub to delete something that was never there. Copied verbatim in two
// arms before this: a rule, not a shape (never duplicate rules).
const stopKeeping = (m: Model, note: Note, path: string): void => {
  if (note.baseSha === null) {
    // Never reached GitHub, so nothing to tell it — but this device still has to
    // forget the record, or it is read back on the next reload.
    m.notes.delete(path);
    m.forgotten.add(path);
    return;
  }
  // Keep a tombstone until the remote delete lands.
  m.notes.set(path, {
    ...note,
    body: "",
    deleted: true,
    pending: true,
    dirty: true,
  });
};

// A sync ended well. Four fields have to move together — an arm that sets three
// of them leaves a cooldown in place and wedges the retry loop, so this is a
// rule rather than a shape and does not get duplicated (never duplicate rules).
const settleSync = (m: Model): void => {
  m.syncing = false;
  m.syncError = null;
  m.retryDelay = 0;
  m.retryAt = 0;
};

// Accepts or rejects. A rejection returns a reason: the proposal violated an
// invariant, so the model declines it and nothing changes. Never throws.
//
// `renamed` delegates to `moved` and returns its verdict. At a third delegation
// this switch has become a dispatcher and the arms want to be named functions.
export const present = (m: Model, p: Proposal): Rejection | null => {
  switch (p.kind) {
    case "hydrated": {
      m.notes = new Map(p.notes.map((n) => [n.path, withoutBytes(n)]));
      m.hydrated = true;
      m.openPath = firstVisiblePath(m);
      return null;
    }

    case "opened": {
      const target = m.notes.get(p.path);
      // Rejects an attachment and a dump day as well as a tombstone: none of
      // them are text the editor should be showing.
      if (!target || !isOpenable(target)) {
        return reject(`Cannot open ${p.path}: it is not a note.`);
      }
      m.openPath = p.path;
      m.error = null;
      // The numbers go back to the top level: whatever folder they were counting
      // inside, you have left it.
      m.numberScope = null;
      // Opening a note means showing it. The palette reaches here from the dump,
      // where setting openPath alone changed nothing visible. Same rule as
      // `created`, which already did this.
      m.mode = "notes";
      return null;
    }

    case "created": {
      const checked = checkPath(m, p.path);
      if (checked.problem !== null) {
        return refusePath(m, checked.path, checked.problem);
      }
      const path = checked.path;
      // The bin and the archive are the app's, not places to file things by
      // hand. Creating one here used to succeed silently and put the note
      // somewhere the tree does not show — you typed a name, pressed Enter, and
      // nothing appeared to happen.
      if (isFiledPath(path)) {
        m.error = `${path} is inside a folder this app manages. Pick another name.`;
        return reject(m.error);
      }
      m.error = null;
      m.forgotten.delete(path);
      m.notes.set(path, {
        path,
        body: "",
        baseSha: null,
        pending: true,
        deleted: false,
        dirty: true,
        encoding: "utf8",
      });
      // Only follow the user to something they could have opened. Quick capture
      // creates today's dump file, and jumping to it would lose the place the
      // whole feature exists to keep.
      const created = m.notes.get(path);
      if (created && isOpenable(created)) {
        m.openPath = path;
        // Creating a note from the dump should take you to it. Quick capture
        // creates a dump file, which is not openable, so it stays put.
        m.mode = "notes";
      }
      m.persistBlocked = false;
      return null;
    }

    case "edited": {
      const note = m.notes.get(p.path);
      if (!note) return reject(`Cannot edit ${p.path}: no such note.`);
      // Not a rejection: an edit that changes nothing is a normal no-change, and
      // reporting it would drown the anomalies in noise.
      if (note.body === p.body) return null;
      m.notes.set(p.path, { ...note, body: p.body, dirty: true, pending: true });
      m.persistBlocked = false;
      return null;
    }
    case "undoEdit":
    case "redoEdit": {
      return null;
    }

    case "deleted": {
      const doomed = m.notes.get(p.path);
      if (!doomed || doomed.deleted) {
        return reject(`Cannot delete ${p.path}: no such note.`);
      }
      // Already in the bin, so there is nowhere further to move it to.
      if (isTrashPath(p.path)) return present(m, { kind: "purged", path: p.path });
      return fileAway(m, doomed, TRASH);
    }

    case "archived": {
      const note = m.notes.get(p.path);
      if (!note || note.deleted) {
        return reject(`Cannot archive ${p.path}: no such note.`);
      }
      if (isFiledPath(p.path)) {
        return reject(`${p.path} is already filed away.`);
      }
      return fileAway(m, note, ARCHIVE);
    }

    case "restored": {
      const note = m.notes.get(p.path);
      if (!note || note.deleted || !isFiledPath(p.path)) {
        return reject(`Cannot restore ${p.path}: it is not filed away.`);
      }
      const to = uniquePath(unfiledPath(p.path), occupied(m));
      return present(m, { kind: "moved", from: p.path, to });
    }

    case "purged": {
      const doomed = m.notes.get(p.path);
      if (!doomed || doomed.deleted) {
        return reject(`Cannot delete ${p.path}: no such note.`);
      }
      stopKeeping(m, doomed, p.path);
      m.persistBlocked = false;
      if (m.openPath === p.path) m.openPath = firstVisiblePath(m);
      return null;
    }

    case "persisted": {
      for (const written of p.written) {
        const note = m.notes.get(written.path);
        if (!note) continue;
        // Only clean it if the body still matches what was written. An edit
        // that landed while the write was in flight leaves the note dirty for a
        // newer reason, and clearing that flag would lose it.
        if (note.body === written.body) {
          m.notes.set(written.path, { ...note, dirty: false });
        }
      }
      m.persisting = false;
      m.error = null;
      return null;
    }

    case "forgot": {
      for (const path of p.paths) m.forgotten.delete(path);
      m.persisting = false;
      return null;
    }

    case "failed": {
      // The one place a local failure becomes a sentence.
      m.error = describeLocal(p.error);
      m.persisting = false;
      m.persistBlocked = true;
      return null;
    }

    case "modeChanged": {
      m.error = null;
      m.numberScope = null;
      m.mode = p.mode;
      return null;
    }

    case "folderDeleted": {
      // Everything beneath the folder, attachments included — deleting a folder
      // deletes what is in it.
      const prefix = `${p.path}/`;
      const doomed = visible(m).filter((n) => n.path.startsWith(prefix));
      if (doomed.length === 0) {
        return reject(`Cannot delete ${p.path}: no such folder.`);
      }
      for (const note of doomed) {
        // The same rule one note at a time: into the bin, unless it is already
        // there, in which case there is nowhere further to go.
        if (isTrashPath(note.path)) stopKeeping(m, note, note.path);
        else fileAway(m, note, TRASH);
      }
      m.persistBlocked = false;
      m.expanded.delete(p.path);
      if (m.openPath !== null && m.openPath.startsWith(prefix)) {
        m.openPath = firstVisiblePath(m);
      }
      return null;
    }

    case "checkinToggled": {
      // Toggling is the whole behaviour, so an unknown id is a caller bug
      // rather than something to absorb silently.
      if (!SLOTS.some((slot) => slot.id === p.id))
        return reject(`Unknown check-in: ${p.id}`);
      if (m.checkinsDone.has(p.id)) m.checkinsDone.delete(p.id);
      else m.checkinsDone.add(p.id);
      return null;
    }
    case "updateFound": {
      // A newer build than the dismissed one re-opens the question; the same
      // one stays dismissed.
      if (p.version === m.update.version && m.update.dismissed) return null;
      m.update = { status: "available", version: p.version, url: p.url, dismissed: false, error: null };
      return null;
    }
    case "updateDismissed": {
      m.update = { ...m.update, dismissed: true };
      return null;
    }
    case "updateStarted": {
      // Downloading twice is just bandwidth; starting from anywhere else is a
      // caller bug.
      if (m.update.status !== "available" || m.update.dismissed)
        return reject(`Cannot start an update from ${m.update.status}`);
      m.update = { ...m.update, status: "fetching" };
      return null;
    }
    case "updateDownloaded": {
      // The installer takes it from here. Idle and dismissed: the job is done
      // whether the user taps through or cancels.
      m.update = { ...idleUpdate, dismissed: true };
      return null;
    }
    case "updatePermissionNeeded": {
      m.update = { ...m.update, status: "permission" };
      return null;
    }
    case "updateOpenSettings": {
      // Fire-and-forget by design: the answer arrives as the user coming back,
      // which resumed already observes.
      return null;
    }
    case "updateFailed": {
      m.update = { ...m.update, status: "failed", error: p.error };
      return null;
    }
    case "jumped": {
      const target = numberedRows(m)[p.index];
      // A digit with nothing in that slot is not a mistake worth reporting, it
      // is simply an empty row.
      if (target === undefined) return null;
      if (target.kind === "note") {
        m.numberScope = null;
        return present(m, { kind: "opened", path: target.note.path });
      }
      // A folder expands and takes the numbers with it, so the next digit
      // reaches its children. Expand rather than toggle: with a scope, a second
      // press of the same digit has to mean "the second child", not "close this".
      m.mode = "notes";
      m.expanded.add(target.path);
      m.numberScope = target.path;
      return null;
    }

    case "dragStarted": {
      m.drag = { from: p.from, folder: p.folder, over: undefined };
      return null;
    }

    case "draggedOver": {
      if (m.drag === null) return null;
      m.drag = { ...m.drag, over: p.over };
      return null;
    }

    case "dragEnded": {
      m.drag = null;
      return null;
    }

    case "linkRefused": {
      const resolved = resolveLink(p.target, m.notes);
      m.error =
        resolved.kind === "ambiguous"
          ? `More than one note is called ${p.target}. Links match on the name alone, so rename one of them.`
          : `Cannot follow ${p.target}.`;
      return reject(m.error);
    }

    case "steppedOut": {
      if (m.numberScope === null) return null;
      // One level, not all the way out. Collapsing the folder being left is
      // half of it: a folder standing open with nothing numbered inside it is
      // the state this exists to get out of.
      m.expanded.delete(m.numberScope);
      m.numberScope = parentFolder(m.numberScope);
      return null;
    }

    case "folderMoved": {
      const prefix = `${p.from}/`;
      // Snapshotted before anything moves: each note is renamed once, and the
      // list must not shift underneath the loop.
      const moving = visible(m).filter((n) => n.path.startsWith(prefix));
      if (moving.length === 0) {
        return reject(`Cannot move ${p.from}: no such folder.`);
      }
      if (p.to === p.from || p.to.startsWith(prefix)) {
        return reject(`Cannot move ${p.from} inside itself.`);
      }
      for (const note of moving) {
        // Each one is a rename, so links come along. Folder moves leave
        // basenames alone, so in practice nothing needs rewriting — the rule is
        // shared rather than assumed away.
        const rejection = present(m, {
          kind: "renamed",
          from: note.path,
          to: `${p.to}/${note.path.slice(prefix.length)}`,
        });
        // A refusal partway leaves the notes already moved where they are. That
        // is honest: they moved, and the message says which one stopped.
        if (rejection !== null) return rejection;
      }
      // Whatever was open stays open, and open folders stay open.
      for (const open of [...m.expanded]) {
        if (open !== p.from && !open.startsWith(prefix)) continue;
        m.expanded.delete(open);
        const suffix = open === p.from ? "" : open.slice(prefix.length);
        m.expanded.add(suffix === "" ? p.to : `${p.to}/${suffix}`);
      }
      m.numberScope = null;
      return null;
    }

    case "folderToggled": {
      if (!m.expanded.has(p.path)) {
        m.expanded.add(p.path);
        return null;
      }
      m.expanded.delete(p.path);
      // Closing a folder the digits are inside would leave them addressing rows
      // that are no longer drawn: badges on invisible children, and nothing on
      // screen to say where the numbers went. They come out with it.
      if (m.numberScope !== null && isUnder(m.numberScope, p.path)) {
        m.numberScope = parentFolder(p.path);
      }
      return null;
    }

    case "resumed": {
      // The window came back. Clearing the watermark is the whole mechanism;
      // nap() notices and pulls.
      if (!m.syncing) m.lastSyncedAt = null;
      return null;
    }

    case "attached": {
      const host = m.notes.get(p.into);
      if (!host || host.deleted) {
        return reject(`Cannot attach to ${p.into}: that note is gone.`);
      }

      // The name is a hash of the bytes, so pasting the same image twice lands
      // on the same path. Re-adding it would reset baseSha to null, and the next
      // push would then send "create" for a path that already exists — a 422,
      // which is a conflict, which produced a spurious conflict copy. An
      // identical attachment is already there; only the reference is new.
      const already = m.notes.get(p.path);
      // The name is the hash of the bytes, so a path that is already here with
      // the same name is already the same picture. That used to be checked by
      // comparing bodies, which the record no longer carries.
      const unchanged = already !== undefined && !already.deleted;

      if (!unchanged) {
        m.notes.set(p.path, {
          path: p.path,
          // The bytes were written to the blob store before this proposal was
          // made. The record is what the model keeps.
          body: "",
          baseSha: already?.deleted === false ? already.baseSha : null,
          pending: true,
          deleted: false,
          dirty: true,
          encoding: "base64",
        });
      }
      // The markdown reference and the bytes land together, so a note never
      // points at an attachment that was not added.
      //
      // Inserted into the note as it is *now*, not into the copy captured when
      // the paste happened. Anything typed while the image was being shrunk is
      // still there; the reference goes in at the caret, clamped, which is at
      // worst a few characters out and never a lost sentence.
      const at = Math.min(p.cursor, host.body.length);
      m.notes.set(p.into, {
        ...host,
        body: insertAt(host.body, at, p.ref),
        dirty: true,
        pending: true,
      });
      m.persistBlocked = false;
      return null;
    }

    case "previewToggled": {
      m.preview = !m.preview;
      return null;
    }
    case "doneVisibilityToggled": {
      m.showDone = !m.showDone;
      return null;
    }

    case "modalConfirmed": {
      const asking = m.modal;
      if (asking === null || asking.kind !== "confirmDelete") {
        return reject("Nothing to confirm.");
      }
      m.modal = null;
      // The dialog holds the question; the arms that already know how to delete
      // do the deleting (never duplicate rules).
      return asking.folder
        ? present(m, { kind: "folderDeleted", path: asking.path })
        : present(m, { kind: "deleted", path: asking.path });
    }

    case "modalOpened": {
      // Moving somewhere clears the message about where you were. Without this a
      // refusal stayed on screen through every unrelated action that followed.
      m.error = null;
      m.modal = p.modal;
      return null;
    }

    case "historyOpened": {
      const note = m.notes.get(p.path);
      if (!note || !isOpenable(note)) {
        return reject(`Cannot show history for ${p.path}.`);
      }
      m.modal = { kind: "history" };
      m.history = {
        path: p.path,
        revisions: null,
        loading: false,
        error: null,
        viewingSha: null,
        viewingBody: null,
      };
      return null;
    }

    case "historyLoaded": {
      // A late answer for a note nobody is looking at any more is dropped, not
      // shown over the top of the one they are.
      if (m.history === null || m.history.path !== p.path) return null;
      m.history.revisions = [...p.revisions];
      m.history.loading = false;
      m.history.error = null;
      return null;
    }

    case "historyFailed": {
      if (m.history === null || m.history.path !== p.path) return null;
      m.history.loading = false;
      m.history.revisions = m.history.revisions ?? [];
      m.history.error = p.reason;
      return null;
    }

    case "revisionOpened": {
      if (m.history === null) return reject("No history is open.");
      m.history.viewingSha = p.sha;
      m.history.viewingBody = null;
      m.history.error = null;
      return null;
    }

    case "revisionLoaded": {
      if (m.history === null || m.history.viewingSha !== p.sha) return null;
      m.history.viewingBody = p.body;
      m.history.loading = false;
      return null;
    }

    case "revisionRestored": {
      const h = m.history;
      if (h === null || h.viewingBody === null) {
        return reject("Nothing to restore.");
      }
      // Restoring writes the old text as a new edit, so history moves forward
      // and nothing in the repo is rewritten.
      const rejection = present(m, {
        kind: "edited",
        path: h.path,
        body: h.viewingBody,
      });
      if (rejection !== null) return rejection;
      m.modal = null;
      m.history = null;
      return null;
    }

    case "modalClosed": {
      // Deliberately *not* clearing the error here. The new-note dialog closes
      // itself the instant it submits, so clearing on close swallowed every
      // refusal it produced — an unusable path just made the dialog vanish with
      // nothing said. Clearing on open is what handles staleness.
      m.history = null;
      m.modal = null;
      // The palette starts fresh next time rather than resuming someone else's
      // half-typed search.
      m.query = "";
      m.paletteIndex = 0;
      return null;
    }

    case "paletteMoved": {
      m.paletteIndex = Math.max(0, m.paletteIndex + p.delta);
      return null;
    }

    case "searched": {
      m.query = p.query;
      // A new query means the old selection points at a different note.
      m.paletteIndex = 0;
      return null;
    }

    case "renamed": {
      const note = m.notes.get(p.from);
      if (!note || note.deleted) {
        return reject(`Cannot rename ${p.from}: no such note.`);
      }
      // Checked before anything is rewritten, so a refused rename leaves no
      // half-updated links behind. Normalised once, not twice.
      const checked = checkPath(m, p.to);
      if (checked.problem !== null) {
        return refusePath(m, checked.path, checked.problem);
      }
      const to = checked.path;
      // Same rule as creating. `moved` stays unguarded on purpose — it is the
      // primitive filing itself is built from.
      if (isFiledPath(to)) {
        m.error = `${to} is inside a folder this app manages. Pick another name.`;
        return reject(m.error);
      }
      m.error = null;

      // A rename changes the note's identity, so every inbound link has to move
      // with it. Doing that here means the whole rename is one synchronous state
      // change: either all of it happened or none of it did.
      for (const referrer of [...m.notes.values()]) {
        if (referrer.deleted || referrer.path === p.from) continue;
        const rewritten = rewriteLinks(referrer.body, p.from, to);
        // Comparing the result, rather than merely finding a link, is what keeps
        // a folder move free: the basename does not change, so every rewrite is
        // a no-op and nothing needs pushing.
        if (rewritten === referrer.body) continue;
        m.notes.set(referrer.path, {
          ...referrer,
          body: rewritten,
          dirty: true,
          pending: true,
        });
      }

      // Return what the delegate decided rather than assuming it accepted.
      return present(m, { kind: "moved", from: p.from, to });
    }

    case "moved": {
      const note = m.notes.get(p.from);
      if (!note || note.deleted) {
        return reject(`Cannot move ${p.from}: no such note.`);
      }
      const checked = checkPath(m, p.to);
      if (checked.problem !== null) {
        return refusePath(m, checked.path, checked.problem);
      }
      const to = checked.path;
      m.error = null;

      // A move is a create plus a delete, which the sync machinery already
      // expresses. Links match on basename, so nothing else needs touching.
      m.notes.set(to, {
        path: to,
        body: note.body,
        baseSha: null,
        pending: true,
        deleted: false,
        dirty: true,
        encoding: note.encoding,
      });
      stopKeeping(m, note, p.from);
      if (m.openPath === p.from) m.openPath = to;
      m.persistBlocked = false;
      return null;
    }

    case "online": {
      m.online = p.online;
      // Coming back is itself the signal to try again, so drop any cooldown.
      if (p.online) {
        m.retryAt = 0;
        m.retryDelay = 0;
        // And stop saying "offline", which the banner went on doing until some
        // later sync happened to succeed. Only that message: an auth failure is
        // still true whether or not there is a network.
        if (m.syncError?.kind === "offline") m.syncError = null;
      }
      return null;
    }

    case "woke": {
      // The cooldown timer fired. nap() re-evaluates on the way out of present.
      return null;
    }

    case "pulled": {
      for (const incoming of p.notes) {
        const local = m.notes.get(incoming.path);
        // A pending note has unpushed edits; the push decides that conflict, not
        // the pull. Never overwrite it here.
        if (local?.pending) continue;
        m.forgotten.delete(incoming.path);
        // Bytes are already in the blob store by the time this runs, and the
        // model must not hold a second copy of them.
        m.notes.set(incoming.path, { ...withoutBytes(incoming), dirty: true });
      }
      for (const path of p.gone) {
        const local = m.notes.get(path);
        if (!local || local.pending) continue; // local edits win a remote delete
        m.notes.delete(path);
        m.forgotten.add(path);
      }
      settleSync(m);
      m.pullRemaining = p.remaining;
      if (m.openPath === null || !m.notes.has(m.openPath)) {
        m.openPath = firstVisiblePath(m);
      }
      return null;
    }

    case "pushed": {
      const note = m.notes.get(p.path);
      settleSync(m);
      // Deliberately *not* clearing lastSyncedAt here. Re-pulling straight after
      // a push races the Trees API's staleness for no benefit — the push already
      // told us the remote state. The conflict branch still forces a pull,
      // because there the remote genuinely holds something we do not have.
      if (!note) {
        return reject(`Pushed ${p.path}, but it is no longer here.`);
      }
      // Same rule as persistence: only clear pending if the body still matches
      // what went to GitHub. An edit that landed mid-flight stays pending.
      //
      // An attachment is settled by definition. Its bytes are not on the record
      // — they are in the blob store — so comparing them here compared "" with
      // the pushed bytes, never matched, and pushed the same file to GitHub for
      // as long as the tab stayed open.
      const settled = note.encoding === "base64" || note.body === p.body;
      m.notes.set(p.path, {
        ...note,
        baseSha: p.sha,
        pending: !settled,
        dirty: true,
      });
      return null;
    }

    case "removed": {
      m.notes.delete(p.path);
      m.forgotten.add(p.path);
      settleSync(m);
      if (m.openPath === p.path) m.openPath = firstVisiblePath(m);
      return null;
    }

    case "conflicted": {
      const note = m.notes.get(p.path);
      if (!note) {
        return reject(`Conflict on ${p.path}, but it is no longer here.`);
      }
      // Keep the remote as canonical and park the local body beside it. Nothing
      // is merged and nothing is lost.
      m.notes.set(p.copyPath, {
        path: p.copyPath,
        body: p.body,
        baseSha: null,
        pending: true,
        deleted: false,
        dirty: true,
        // Inherited, not assumed. A conflicted attachment copied as text would
        // be re-encoded on push and arrive corrupt.
        encoding: note.encoding,
      });
      // Drop the local claim on the original; the next pull brings the remote.
      m.notes.set(p.path, {
        ...note,
        pending: false,
        baseSha: null,
        dirty: true,
      });
      settleSync(m);
      // The original now has no baseSha, so a fresh pull is what brings the
      // remote version back down beside the copy.
      m.lastSyncedAt = null;
      m.openPath = p.copyPath;
      return null;
    }

    case "syncFailed": {
      m.syncing = false;
      m.syncError = p.error;
      // The backoff owns the retry from here. Leaving a batch count set would
      // have nap pulling again immediately and spinning against whatever just
      // failed.
      m.pullRemaining = 0;
      if (p.error.kind === "offline") m.online = false;
      return null;
    }
  }
};
