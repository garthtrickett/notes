# Build plan

Four phases. Each is self-contained and ends with the whole thing under test.

The split is at the risky seams: phase 1 proves the architecture with no network,
phase 2 proves sync, and only then does feature work start on a base that is
known to hold.

| Phase | Ends with |
|---|---|
| 1. The loop, offline | A working notes app with no network |
| 2. Sync | It round-trips to GitHub and survives a real conflict |
| 3. The vault | Nested folders, and the dump |
| 4. Documents | Rendered markdown, links, rename, search, attachments |

Only phase 1 is fleshed out. The rest are one paragraph each and get expanded
when we reach them — writing them out now would be guessing.

---

# Phase 1 — The loop, offline

**Goal:** the complete architecture, with the network cut out. Result, the SAM
loop, IndexedDB, and a text box. If the shape is wrong, it is wrong here, where
nothing else is built on top of it yet.

**Done when:** open the app, create a note, type, reload the page, the note is
still there. No network involved at any point. `bun test` green.

## 1.1 Scaffolding

- Bun, Vite, TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`),
  `lit-html`.
- No PWA manifest yet — that lands with sync, when offline starts to mean
  something.

Starting shape, not a prescription:

```
src/
  main.ts       boot and wiring
  result.ts     Result + helpers
  model.ts      Model, Proposal, present(), nap()
  view.ts       lit-html templates
  render.ts     scheduleRender
  idb.ts        raw IndexedDB, transactional
```

## 1.2 `result.ts`

`Result<T, E>`, `ok`, `err`, `attempt`, `attemptAsync`, `combine` — the kernel
from `DECISIONS.md`, unchanged.

## 1.3 `idb.ts`

Raw IndexedDB. Not `idb-keyval`: it cannot express a multi-key transaction, and
phase 2 needs one for the outbox.

- `open()`, `getAll()`, `putMany(records)`, `deleteMany(paths)`
- **Every write is one transaction.** `putMany` writing three records either
  writes all three or none.
- One record per note, keyed by path. Never one blob holding the collection —
  that would rewrite every note on every keystroke.

## 1.4 `model.ts`

```ts
type Note = { path: string; body: string; dirty: boolean };
type Model = {
  notes: Map<string, Note>;
  openPath: string | null;
  hydrated: boolean;
  error: string | null;
};

type Proposal =
  | { kind: "hydrated"; notes: Note[] }
  | { kind: "opened"; path: string }
  | { kind: "created"; path: string }
  | { kind: "edited"; path: string; body: string }
  | { kind: "deleted"; path: string }
  | { kind: "persisted"; paths: string[] }
  | { kind: "failed"; message: string };
```

`present(p)` is the only thing that mutates `M`. It **rejects** as well as
accepts — editing an unknown path, creating a path that already exists, opening
something that is not there. Rejection is a silent return, not a throw.

`nap()` is the only place automatic behaviour lives. In phase 1 it has one rule:

```ts
function nap() {
  const dirty = [...M.notes.values()].filter(n => n.dirty);
  if (dirty.length && !persisting) { persisting = true; void persist(dirty); }
}
```

## 1.5 `view.ts` and `render.ts`

- `render.ts`: microtask-batched `scheduleRender`, six lines.
- `view.ts`: a list of note paths and one editor. Flat list — no tree yet.
- **The textarea is uncontrolled.** Set `.value` imperatively when the open note
  changes; never bind it to model state, or the cursor will fight you on mobile.
- `repeat()` with a key function for the list.

## 1.6 `main.ts`

Boot: open IndexedDB, `getAll()`, `present({ kind: "hydrated", notes })`. Wire
the input and click handlers to `present`. Pass `Date.now` in as `now` — nothing
below `main.ts` calls it directly (principle 5).

## Tests

The point of this phase is that nearly all of it is testable without a DOM,
because the model is separate from the view.

**Pure, no DOM:**
- `result.ts` — every helper, including `attempt` catching a throw.
- `present()` accepts a valid proposal and mutates as expected.
- `present()` **rejects**: edit an unknown path, create a duplicate path.
- `present()` is exhaustive — adding a proposal kind must fail to compile.
- `nap()` fires persistence when something is dirty, and not when nothing is.
- `nap()` does not start a second persist while one is running.

**With `fake-indexeddb`:**
- `putMany` / `getAll` round-trip.
- A failing write in `putMany` leaves *nothing* written (the transaction holds).
- Editing one note writes one record, not the whole collection.

**With jsdom:**
- Boot hydrates from IndexedDB and renders the list.
- Typing proposes `edited` and eventually persists.
- The textarea keeps its cursor position across an unrelated re-render.

**The gate:** create a note, type into it, reload the page, it is still there.

## Explicitly not in phase 1

GitHub, sync, the outbox, conflicts, folders, the tree UI, the dump, markdown
rendering, `[[links]]`, search, attachments, the PWA manifest.

---

# Phase 2 — Sync

Add the GitHub client and make the app a second writer to the `vault` branch.
Trees API for the manifest, Contents API with `sha` for compare-and-swap writes,
an outbox in IndexedDB, and flushing driven from `nap()`. A `409` writes a
conflict copy. PWA manifest and offline caching land here too, since offline
finally means something.

**The gate is a deliberate conflict:** edit the same note in the GitHub web UI
and in the app while offline, then reconnect. Expected result is a conflict copy,
not a lost edit. Phase 2 is not done until that passes.

---

# Phase 3 — The vault

Give the flat list a shape.

**Nested folders to arbitrary depth.** This needs no model change — folders are
path prefixes and the manifest already returns full paths, so the tree is derived
on read. What it needs is a tree view with expand/collapse, and create / move /
delete. Moving a note is just a path change.

**The dump.** Per-day files, the 04:00 rollover, entries carrying a time, and the
one-continuous-scroll UI: one textarea per day, past days read-only until
clicked, headers rendered from filenames, lazy loading off the manifest.

---

# Phase 4 — Documents

Notes stop being plain text.

Markdown rendering via `remark`, `[[wikilinks]]` resolved on basename plus a
backlink index, rename-as-an-operation (find inbound links, rewrite, move, one
commit via the Git Data API), search over the vault, and attachments —
canvas-resized to WebP on paste.
