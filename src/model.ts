// The model is a mutable container of immutable values.
//
// Only present() writes to a Model, and everything a Model holds is readonly
// (principle 3). Replacing one Note per keystroke costs a small allocation;
// replacing the whole model would cost one per keystroke for no benefit, since
// there is exactly one writer.

import type { SyncError } from "./github.ts";

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
}

export interface Note extends NoteRecord {
  // The body differs from what is in IndexedDB. Never persisted — on reload
  // everything read back is by definition clean.
  readonly dirty: boolean;
}

export interface Model {
  notes: Map<string, Note>;
  openPath: string | null;
  hydrated: boolean;
  persisting: boolean;
  syncing: boolean;
  // Set while a network failure is cooling off. nap() skips until now passes it.
  retryAt: number;
  retryDelay: number;
  online: boolean;
  syncError: SyncError | null;
  lastSyncedAt: number | null;
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
  hydrated: false,
  persisting: false,
  persistBlocked: false,
  syncing: false,
  retryAt: 0,
  retryDelay: 0,
  online: true,
  syncError: null,
  lastSyncedAt: null,
  error: null,
});

export type Proposal =
  | { readonly kind: "hydrated"; readonly notes: readonly Note[] }
  | { readonly kind: "opened"; readonly path: string }
  | { readonly kind: "created"; readonly path: string }
  | { readonly kind: "edited"; readonly path: string; readonly body: string }
  | { readonly kind: "deleted"; readonly path: string }
  | { readonly kind: "persisted"; readonly written: readonly NoteRecord[] }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "online"; readonly online: boolean }
  | { readonly kind: "woke" }
  | { readonly kind: "pulled"; readonly notes: readonly NoteRecord[]; readonly gone: readonly string[] }
  | { readonly kind: "pushed"; readonly path: string; readonly body: string; readonly sha: string }
  | { readonly kind: "removed"; readonly path: string }
  | { readonly kind: "conflicted"; readonly path: string; readonly copyPath: string; readonly body: string }
  | { readonly kind: "syncFailed"; readonly error: SyncError };

// A tombstone still exists as a record until the remote delete lands, but it is
// not a note any more and must never be shown or opened.
export const visible = (m: Model): Note[] =>
  [...m.notes.values()].filter((n) => !n.deleted);

const firstVisiblePath = (m: Model): string | null =>
  visible(m)[0]?.path ?? null;

// Accepts or rejects. A rejection is a silent return — the proposal violated an
// invariant, so the model declines it and nothing changes. Never throws.
export const present = (m: Model, p: Proposal): void => {
  switch (p.kind) {
    case "hydrated": {
      m.notes = new Map(p.notes.map((n) => [n.path, n]));
      m.hydrated = true;
      m.openPath = firstVisiblePath(m);
      return;
    }

    case "opened": {
      const target = m.notes.get(p.path);
      if (!target || target.deleted) return; // reject: unknown or tombstoned
      m.openPath = p.path;
      return;
    }

    case "created": {
      if (m.notes.has(p.path)) return; // reject: would clobber an existing note
      if (p.path.trim() === "") return; // reject: unnameable
      m.notes.set(p.path, {
        path: p.path,
        body: "",
        baseSha: null,
        pending: true,
        deleted: false,
        dirty: true,
      });
      m.openPath = p.path;
      m.persistBlocked = false;
      return;
    }

    case "edited": {
      const note = m.notes.get(p.path);
      if (!note) return; // reject: unknown note
      if (note.body === p.body) return; // reject: no-op, do not dirty
      m.notes.set(p.path, { ...note, body: p.body, dirty: true, pending: true });
      m.persistBlocked = false;
      return;
    }

    case "deleted": {
      const doomed = m.notes.get(p.path);
      if (!doomed) return; // reject: nothing to delete
      if (doomed.baseSha === null) {
        // Never reached GitHub, so there is nothing to tell it about.
        m.notes.delete(p.path);
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
      return;
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
      return;
    }

    case "failed": {
      m.error = p.message;
      m.persisting = false;
      m.persistBlocked = true;
      return;
    }

    case "online": {
      m.online = p.online;
      // Coming back is itself the signal to try again, so drop any cooldown.
      if (p.online) {
        m.retryAt = 0;
        m.retryDelay = 0;
      }
      return;
    }

    case "woke": {
      // The cooldown timer fired. nap() re-evaluates on the way out of present.
      return;
    }

    case "pulled": {
      for (const incoming of p.notes) {
        const local = m.notes.get(incoming.path);
        // A pending note has unpushed edits; the push decides that conflict, not
        // the pull. Never overwrite it here.
        if (local?.pending) continue;
        m.notes.set(incoming.path, { ...incoming, dirty: true });
      }
      for (const path of p.gone) {
        const local = m.notes.get(path);
        if (!local || local.pending) continue; // local edits win a remote delete
        m.notes.delete(path);
      }
      m.syncing = false;
      m.syncError = null;
      m.retryDelay = 0;
      m.retryAt = 0;
      if (m.openPath === null || !m.notes.has(m.openPath)) {
        m.openPath = firstVisiblePath(m);
      }
      return;
    }

    case "pushed": {
      const note = m.notes.get(p.path);
      m.syncing = false;
      m.syncError = null;
      m.retryDelay = 0;
      m.retryAt = 0;
      // Re-pull after pushing, so the remote's view of the world is confirmed
      // rather than assumed.
      m.lastSyncedAt = null;
      if (!note) return;
      // Same rule as persistence: only clear pending if the body still matches
      // what went to GitHub. An edit that landed mid-flight stays pending.
      const settled = note.body === p.body;
      m.notes.set(p.path, {
        ...note,
        baseSha: p.sha,
        pending: !settled,
        dirty: true,
      });
      return;
    }

    case "removed": {
      m.notes.delete(p.path);
      m.syncing = false;
      m.syncError = null;
      m.retryDelay = 0;
      m.retryAt = 0;
      if (m.openPath === p.path) m.openPath = firstVisiblePath(m);
      return;
    }

    case "conflicted": {
      const note = m.notes.get(p.path);
      if (!note) return;
      // Keep the remote as canonical and park the local body beside it. Nothing
      // is merged and nothing is lost.
      m.notes.set(p.copyPath, {
        path: p.copyPath,
        body: p.body,
        baseSha: null,
        pending: true,
        deleted: false,
        dirty: true,
      });
      // Drop the local claim on the original; the next pull brings the remote.
      m.notes.set(p.path, {
        ...note,
        pending: false,
        baseSha: null,
        dirty: true,
      });
      m.syncing = false;
      m.syncError = null;
      m.retryDelay = 0;
      m.retryAt = 0;
      // The original now has no baseSha, so a fresh pull is what brings the
      // remote version back down beside the copy.
      m.lastSyncedAt = null;
      m.openPath = p.copyPath;
      return;
    }

    case "syncFailed": {
      m.syncing = false;
      m.syncError = p.error;
      if (p.error.kind === "offline") m.online = false;
      return;
    }
  }
};
