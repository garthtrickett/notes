// The model is a mutable container of immutable values.
//
// Only present() writes to a Model, and everything a Model holds is readonly
// (principle 3). Replacing one Note per keystroke costs a small allocation;
// replacing the whole model would cost one per keystroke for no benefit, since
// there is exactly one writer.

import type { SyncError } from "./github.ts";
import { rewriteLinks } from "./links.ts";
import { describeProblem, normalizePath, pathProblem } from "./paths.ts";
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
export type Encoding = "utf8" | "base64";

export interface Model {
  notes: Map<string, Note>;
  openPath: string | null;
  mode: Mode;
  preview: boolean;
  query: string;
  // Open folders. Session-lived UI state, deliberately not persisted.
  expanded: Set<string>;
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
  expanded: new Set(),
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
  | { readonly kind: "moved"; readonly from: string; readonly to: string }
  | { readonly kind: "resumed" }
  | { readonly kind: "renamed"; readonly from: string; readonly to: string }
  | { readonly kind: "previewToggled" }
  | { readonly kind: "searched"; readonly query: string }
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
// view so there is one answer to "is this a note" (principle 4).
export const openable = (m: Model): Note[] =>
  visible(m).filter((n) => !isDumpPath(n.path) && !isAttachmentPath(n.path));

const firstVisiblePath = (m: Model): string | null =>
  openable(m)[0]?.path ?? null;

const isOpenable = (note: Note): boolean =>
  !note.deleted && !isDumpPath(note.path) && !isAttachmentPath(note.path);

// A rejected path used to be a silent return, which is how someone ends up
// typing into a note they did not mean to open. Every rejection now says why.
const refusePath = (m: Model, raw: string): string | null => {
  const path = normalizePath(raw);
  const problem = pathProblem(
    path,
    [...m.notes.values()].filter((n) => !n.deleted).map((n) => n.path),
  );
  if (problem === null) {
    m.error = null;
    return path;
  }
  m.error = describeProblem(problem, path);
  return null;
};

export interface Rejection {
  readonly reason: string;
}

const reject = (reason: string): Rejection => ({ reason });

// A sync ended well. Four fields have to move together — an arm that sets three
// of them leaves a cooldown in place and wedges the retry loop, so this is a
// rule rather than a shape and does not get duplicated (principle 4).
const settleSync = (m: Model): void => {
  m.syncing = false;
  m.syncError = null;
  m.retryDelay = 0;
  m.retryAt = 0;
};

// Accepts or rejects. A rejection returns a reason rather than a silent return — the proposal violated an
// invariant, so the model declines it and nothing changes. Never throws.
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
      return null;
    }

    case "created": {
      const path = refusePath(m, p.path);
      if (path === null) return reject(m.error ?? `Cannot create ${p.path}.`);
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
      m.openPath = path;
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
      if (doomed.baseSha === null) {
        // Never reached GitHub, so there is nothing to tell it about — but this
        // device still has to forget it.
        m.notes.delete(p.path);
        m.forgotten.add(p.path);
      } else {
        // Keep a tombstone until the remote delete lands.
        m.notes.set(p.path, {
          ...doomed,
          body: "",
          deleted: true,
          pending: true,
          dirty: true,
        });
      }
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
      m.mode = p.mode;
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

    case "searched": {
      m.query = p.query;
      return null;
    }

    case "renamed": {
      const note = m.notes.get(p.from);
      if (!note || note.deleted) {
        return reject(`Cannot rename ${p.from}: no such note.`);
      }
      // Checked before anything is rewritten, so a refused rename leaves no
      // half-updated links behind.
      const to = normalizePath(p.to);
      if (refusePath(m, p.to) === null) {
        return reject(m.error ?? `Cannot rename to ${p.to}.`);
      }

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
      const to = refusePath(m, p.to);
      if (to === null) return reject(m.error ?? `Cannot move to ${p.to}.`);

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
      if (note.baseSha === null) {
        m.notes.delete(p.from);
        m.forgotten.add(p.from);
      } else {
        m.notes.set(p.from, {
          ...note,
          body: "",
          deleted: true,
          pending: true,
          dirty: true,
        });
      }
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
