// The model is a mutable container of immutable values.
//
// Only present() writes to a Model, and everything a Model holds is readonly
// (principle 3). Replacing one Note per keystroke costs a small allocation;
// replacing the whole model would cost one per keystroke for no benefit, since
// there is exactly one writer.

// What a persist actually wrote. Carried back so present() can tell whether the
// note changed while the write was in flight.
export interface NoteRecord {
  readonly path: string;
  readonly body: string;
}

export interface Note {
  readonly path: string;
  readonly body: string;
  readonly dirty: boolean;
}

export interface Model {
  notes: Map<string, Note>;
  openPath: string | null;
  hydrated: boolean;
  persisting: boolean;
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
  error: null,
});

export type Proposal =
  | { readonly kind: "hydrated"; readonly notes: readonly Note[] }
  | { readonly kind: "opened"; readonly path: string }
  | { readonly kind: "created"; readonly path: string }
  | { readonly kind: "edited"; readonly path: string; readonly body: string }
  | { readonly kind: "deleted"; readonly path: string }
  | { readonly kind: "persisted"; readonly written: readonly NoteRecord[] }
  | { readonly kind: "failed"; readonly message: string };

// Accepts or rejects. A rejection is a silent return — the proposal violated an
// invariant, so the model declines it and nothing changes. Never throws.
export const present = (m: Model, p: Proposal): void => {
  switch (p.kind) {
    case "hydrated": {
      m.notes = new Map(p.notes.map((n) => [n.path, n]));
      m.hydrated = true;
      m.openPath = p.notes[0]?.path ?? null;
      return;
    }

    case "opened": {
      if (!m.notes.has(p.path)) return; // reject: unknown note
      m.openPath = p.path;
      return;
    }

    case "created": {
      if (m.notes.has(p.path)) return; // reject: would clobber an existing note
      if (p.path.trim() === "") return; // reject: unnameable
      m.notes.set(p.path, { path: p.path, body: "", dirty: true });
      m.openPath = p.path;
      m.persistBlocked = false;
      return;
    }

    case "edited": {
      const note = m.notes.get(p.path);
      if (!note) return; // reject: unknown note
      if (note.body === p.body) return; // reject: no-op, do not dirty
      m.notes.set(p.path, { ...note, body: p.body, dirty: true });
      m.persistBlocked = false;
      return;
    }

    case "deleted": {
      if (!m.notes.delete(p.path)) return; // reject: nothing to delete
      m.persistBlocked = false;
      if (m.openPath === p.path) {
        m.openPath = m.notes.keys().next().value ?? null;
      }
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
  }
};
