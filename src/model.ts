// The model is a mutable container of immutable values.
//
// present() writes note state; everything a Model holds is readonly (principle
// 3). loop.ts additionally writes the in-flight flags — see the header there for
// why that boundary is temporal rather than by field.
//
// Replacing one Note per keystroke costs a small allocation. Replacing the whole
// model would cost one per keystroke for no benefit, since there is exactly one
// writer.

import type { SyncError } from "./github.ts";
import { rewriteLinks } from "./links.ts";
import { describeProblem, normalizePath, pathProblem, type PathProblem } from "./paths.ts";
import { buildTree, type TreeNode } from "./tree.ts";
import { isDumpPath } from "./dump.ts";
import { isAttachmentPath } from "./attachments.ts";
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

export type Mode = "notes" | "dump";
// A discriminated union rather than a string, because a dialog that asks about
// something has to carry what it is asking about.
export type Modal =
  | { readonly kind: "capture" }
  | { readonly kind: "newNote" }
  | { readonly kind: "open" }
  | { readonly kind: "confirmDelete"; readonly path: string; readonly folder: boolean };
export type Encoding = "utf8" | "base64";

export interface Model {
  notes: Map<string, Note>;
  openPath: string | null;
  mode: Mode;
  preview: boolean;
  query: string;
  // At most one floating box at a time. One field rather than a boolean each, so
  // opening, dismissing and focusing are one rule instead of one per modal.
  modal: Modal | null;
  // Which row the open palette has selected. Lives here rather than in the view
  // because arrow keys move it and the view is a pure function of the model.
  paletteIndex: number;
  // Open folders. Session-lived UI state, deliberately not persisted.
  expanded: Set<string>;
  // Which folder the number badges currently count inside, or null for the top
  // level. A digit on a folder scopes to it, so the next digit reaches its
  // children.
  numberScope: string | null;
  hydrated: boolean;
  persisting: boolean;
  syncing: boolean;
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

export const createModel = (): Model => ({
  notes: new Map(),
  openPath: null,
  mode: "notes",
  preview: false,
  query: "",
  modal: null,
  paletteIndex: 0,
  expanded: new Set(),
  numberScope: null,
  hydrated: false,
  persisting: false,
  persistBlocked: false,
  syncing: false,
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
  | { readonly kind: "deleted"; readonly path: string }
  | { readonly kind: "persisted"; readonly written: readonly NoteRecord[] }
  | { readonly kind: "forgot"; readonly paths: readonly string[] }
  | { readonly kind: "failed"; readonly error: LocalError }
  | { readonly kind: "online"; readonly online: boolean }
  | { readonly kind: "woke" }
  | { readonly kind: "pulled"; readonly notes: readonly NoteRecord[]; readonly gone: readonly string[] }
  | { readonly kind: "pushed"; readonly path: string; readonly body: string; readonly sha: string }
  | { readonly kind: "removed"; readonly path: string }
  | { readonly kind: "conflicted"; readonly path: string; readonly copyPath: string; readonly body: string }
  | { readonly kind: "syncFailed"; readonly error: SyncError }
  | { readonly kind: "modeChanged"; readonly mode: Mode }
  | { readonly kind: "folderToggled"; readonly path: string }
  | { readonly kind: "folderDeleted"; readonly path: string }
  // Which top-level row, counting from zero, as shown in the tree.
  | { readonly kind: "jumped"; readonly index: number }
  // Back to numbering the top level.
  | { readonly kind: "unscoped" }
  | { readonly kind: "moved"; readonly from: string; readonly to: string }
  | { readonly kind: "resumed" }
  | { readonly kind: "renamed"; readonly from: string; readonly to: string }
  | { readonly kind: "previewToggled" }
  | { readonly kind: "searched"; readonly query: string }
  | { readonly kind: "modalOpened"; readonly modal: Modal }
  | { readonly kind: "modalClosed" }
  | { readonly kind: "modalConfirmed" }
  | { readonly kind: "paletteMoved"; readonly delta: number }
  | {
      readonly kind: "attached";
      readonly path: string;
      readonly base64: string;
      readonly into: string;
      readonly body: string;
    };

// A tombstone still exists as a record until the remote delete lands, but it is
// not a note any more and must never be shown or opened.
export const visible = (m: Model): Note[] =>
  [...m.notes.values()].filter((n) => !n.deleted);

// What the notes view can show and open. An attachment is a record, not a note,
// and a dump day belongs to its own view — opening either puts something in the
// editor that is not text you meant to edit. Defined here rather than in the
// view so there is one answer to "is this a note" (never duplicate rules).
export const openable = (m: Model): Note[] =>
  visible(m).filter((n) => !isDumpPath(n.path) && !isAttachmentPath(n.path));

// The tree exactly as the notes view draws it. The view renders this and the
// number shortcuts index into it, so there is one ordering and the badges cannot
// drift from what the digits do (never duplicate rules).
export const noteTree = (m: Model): TreeNode[] =>
  buildTree(openable(m).sort((a, b) => a.path.localeCompare(b.path)));

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

const firstVisiblePath = (m: Model): string | null =>
  openable(m)[0]?.path ?? null;

const isOpenable = (note: Note): boolean =>
  !note.deleted && !isDumpPath(note.path) && !isAttachmentPath(note.path);

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
      m.notes = new Map(p.notes.map((n) => [n.path, n]));
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

    case "deleted": {
      const doomed = m.notes.get(p.path);
      if (!doomed) return reject(`Cannot delete ${p.path}: no such note.`);
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
      for (const note of doomed) stopKeeping(m, note, note.path);
      m.persistBlocked = false;
      m.expanded.delete(p.path);
      if (m.openPath !== null && m.openPath.startsWith(prefix)) {
        m.openPath = firstVisiblePath(m);
      }
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

    case "unscoped": {
      m.numberScope = null;
      return null;
    }

    case "folderToggled": {
      if (m.expanded.has(p.path)) m.expanded.delete(p.path);
      else m.expanded.add(p.path);
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
      const unchanged =
        already !== undefined && !already.deleted && already.body === p.base64;

      if (!unchanged) {
        m.notes.set(p.path, {
          path: p.path,
          body: p.base64,
          baseSha: already?.deleted === false ? already.baseSha : null,
          pending: true,
          deleted: false,
          dirty: true,
          encoding: "base64",
        });
      }
      // The markdown reference and the bytes land together, so a note never
      // points at an attachment that was not added.
      m.notes.set(p.into, { ...host, body: p.body, dirty: true, pending: true });
      m.persistBlocked = false;
      return null;
    }

    case "previewToggled": {
      m.preview = !m.preview;
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
      m.modal = p.modal;
      return null;
    }

    case "modalClosed": {
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
        m.notes.set(incoming.path, { ...incoming, dirty: true });
      }
      for (const path of p.gone) {
        const local = m.notes.get(path);
        if (!local || local.pending) continue; // local edits win a remote delete
        m.notes.delete(path);
        m.forgotten.add(path);
      }
      settleSync(m);
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
      const settled = note.body === p.body;
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
      if (p.error.kind === "offline") m.online = false;
      return null;
    }
  }
};
