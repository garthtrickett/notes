# Tasks aggregate — spec

One place that lists every open checkbox in the vault, grouped by note.
Tapping a box ticks it in the file it came from. No new state, no new sync,
no notifications — those are later specs. This one ends at: see everything,
tick anything.

## 0. Problem

Open `- [ ]` boxes scatter across notes and dump days and go stale there
invisibly. The vault just proved it: 29 open boxes across 215 dump days,
found only by reading every file. Check-ins solve *reminders* for three
fixed slots; nothing shows *all* open work in one place.

Non-goals for this spec: due dates, recurrence, snooze, notifications,
assignment, priorities, a task store. Any of those is a second spec that
builds on this one's scanner.

## 1. Definitions

- A **task** is what the renderer already calls one: a lezer `Task` node in
  the `markdownLanguage` tree (`decorate.ts` styles its `TaskMarker`). Not a
  regex, not a convention — the scanner parses with the same parser, so
  something is a task here exactly when it renders as one there. Code blocks,
  blockquotes and mid-line `[ ]` follow the grammar, not this spec.
- A task is **open** when its marker's middle character is a space
  (`- [ ]`), **done** otherwise (`- [x]`, `- [X]` — same rule as
  `decorate.ts`: `doc[node.from + 1] !== " "`).
- A task's **identity** is `(path, from)` — byte offset of the `Task` node
  in its file body. Offsets die on every keystroke, so identity is only ever
  used within a single paint: scan, render, propose, forget. Nothing is
  stored, nothing crosses renders. (This is why the loop can stay untouched.)

## 2. Scanner — `src/tasks.ts` (new, pure, no DOM)

```ts
export interface TaskRef {
  readonly path: string; // vault path of the file holding it
  readonly from: number; // offset of the Task node in that file's body
  readonly marker: number; // offset of the character to flip (" " <-> "x")
  readonly done: boolean;
  readonly title: string; // first line of the item, marker stripped, trimmed
}
```

- `tasksIn(body: string, path: string): TaskRef[]` — parse `body` with
  `markdownLanguage.parser.parse`, walk top-level `Task` nodes, record refs.
  The checkbox character lives at a fixed position inside the marker; the
  flip target is that offset, found structurally, never by string search.
- `title` is display-only: the item's first line with the marker removed.
  Multi-line items show their first line; the toggle still flips the one box.
- Nested tasks: each `Task` node is its own ref, including children. Tapping
  a child flips only the child — same as editing the character by hand.
- Dump mode needs no special case: every day file scans as its own note
  through `tasksInVault`, and the toggle rewrites that file's stored body
  directly — never the editor's composite document. (An earlier draft mapped
  composed offsets back through `DumpSection`s; per-file scanning made it
  unnecessary, and it was deleted rather than kept.)
- Memoize per path on body identity (`Map<path, { body, refs }>`); the vault
  is hundreds of files and paints happen per keystroke. Bodies are immutable
  strings, so identity comparison is the invalidation — no version counter,
  no model change.
- Trash (`.trash/`), archive (`.archive/`) and tombstones (`deleted`) are not
  triage and are never scanned: ticking a box in a deleted file is editing
  nowhere, and dot-paths would sort above everything live. (An earlier draft
  scanned everything; a vault with a busy bin proved that wrong — deleted
  files sat on the first screen.) Deleting a live file still deletes its
  tasks, by virtue of there being no other record of them.

## 3. Toggle — no model change, no loop change

Toggling is string surgery plus the existing `edited` proposal:

1. Take the file body, replace the single character at `marker`
   (`" "` → `"x"`, anything else → `" "` — done boxes of any flavor reopen).
2. Propose `{ kind: "edited", path, body: newBody }`.

Everything downstream — dirty/pending flags, IndexedDB persist, push,
conflict copies, CodeMirror echo, undo (the flip is a normal edit and
reports through `onEdit`) — already handles `edited`. `present()` gains no
case, `propose()` gains no branch. If this spec ever asks for a new proposal
kind, it has stopped being this spec.

## 4. View — a sixth mode, `tasks`

- `Mode` gains `"tasks"`. It renders like dump/archive/trash in `view()`:
  tabs, list, modal, status, update banner, error. `urlFor`/`titleFor` need
  no change — non-note modes are all root `/` titled `notes` already.
- Tab order: Notes, Dump, **Tasks**, Archive, Trash, Vault. Triage pairs
  with capture, so it sits next to Dump. The modes row already wraps on
  narrow phones; a sixth tab wraps, it does not squeeze.
- Shortcut: `K` (mnemonic: tasKs; `T` is Trash). Same rules as the rest —
  dead while typing, dead behind a modal, added to `keys.ts` + its tests.
- Row layout, per group: group header is the note path as plain text with its
  count (`inbox.md — 2/5`); under it one row per open task.
- Done work lives behind one toggle, default off: a header row (`12 open` +
  `Show done`) sits above the list, and `doneVisibilityToggled` flips a
  `showDone` boolean — the spec's only model addition, mirroring
  `previewToggled`. Hidden means hidden: done rows and done-only groups
  leave the page entirely until asked for. The header stays even when
  everything is ticked off, so the way back never strands; session state,
  so a fresh boot opens clean. (First shipped as always-visible collapsed
  sections; a vault with a busy history proved that a wall.)
- Groups sort open-first, done-only notes last — alphabetical history must
  never bury live work — alphabetical inside each band. Tasks within a group
  sort by file offset (document order). No undated/dated split — v1 has no
  dates.
- Done tasks are not listed. Each group header carries `open/total`
  (`inbox.md — 2/5`), so completed work is counted, not shown. A done-only
  note contributes no group.
- Empty vault-wide state: `No open tasks.` — same voice as `No note open.`
  / `Nothing captured yet.`
- The checkbox is a native `<input type="checkbox">`, not a styled span:
  thumb-sized hit target, free accessibility, no new CSS language. It does
  not steal focus on tap (the list must not yank the caret out of an
  editing session elsewhere — there is no editor on this screen, but the
  rule is stated so a later layout keeps it).
- The list scrolls internally: `main.single` is `overflow: hidden`, so an
  unbounded list clips past one page with no way to reach it. The height comes
  from `main.single` being a flex column and the list taking `flex: 1;
  min-height: 0` — not from subtracting a guessed tab-bar height, which is
  wrong by a whole row once the tabs wrap on a phone.
- Each group is `flex: none`. A height-bounded flex column shrinks its items,
  and the sheet's `section { min-height: 0 }` (there for the two-pane grid)
  turns off the automatic minimum that would otherwise stop it — so groups
  collapsed to slivers and painted their rows over the groups below.
- Phone and desktop render the same list from the same bodies. No
  `isNativePlatform` branch anywhere in this spec.

## 5. Refresh semantics

The list is computed at paint time from `model.notes` — it cannot go stale,
because there is nothing to go stale. Memoization (§2) is performance only
and keyed on body identity, so a sync pull that rewrites bodies shows up on
the next paint with no invalidation protocol.

## 6. Explicitly unchanged — and the complete touch list

Unchanged:

- `loop.ts`: no new branch, no editor calls. (Caret-precise jump would need
  the loop — that is v1.1, §9.)
- Sync, persist, conflicts, outbox: untouched — toggle traffic is `edited`
  traffic.
- `checkins.ts` / `notify.ts`: untouched. Reminders are the check-ins
  generalization spec, which consumes this scanner but changes nothing here.
- `keys.ts` gains one case; everything else about input stays.
- `url.ts`: untouched — like dump/archive/trash, tasks mode is root `/`.

Changed, minimally and only this:

- `model.ts`: `showDone` boolean + `doneVisibilityToggled` case — the one
  exception to "no model change", taken because the alternative (DOM-kept
  toggle state) wipes on every mode switch.

Touched, exhaustively (verified: these are the only sites that switch on
`Mode` or render tabs):

- `model.ts:57` — `Mode` union gains `"tasks"`.
- `view.ts` `tabs()` — sixth tab after Dump (`modeChanged: tasks`).
- `view.ts` `view()` — new branch rendering tabs + task list + modal +
  status + update banner + error, mirroring the dump branch.
- `src/tasks.ts` — new file: scanner, flip helper, per-path memo.
- `keys.ts` — `case "k"` proposing `modeChanged: tasks`.
- `style.css` — task list, rows, native-checkbox sizing, empty state.
- Tests: `tasks.test.ts` (new), `loop.test.ts`, `vault.test.ts`,
  `keys.test.ts`, `model.test.ts` (toggle starts hidden and flips).

## 7. Edge cases (decided, not deferred)

- A task edited in the note editor while Tasks is open: the next paint
  re-scans; the row follows the text. No live sync between screens beyond
  the paint both already share.
- Toggling the same box twice fast: two `edited` proposals, second is a
  no-change (`present()` returns null on identical bodies — the existing
  rule), so flapping is impossible.
- Task text containing `[[links]]`, images, `#tags`: title shows them raw,
  exactly as the editor row would. No rendering inside rows in v1.
- CRLF files: bodies are stored/compared as-is everywhere else in the app;
  offsets are computed on the same string that gets rewritten, so line
  endings cannot desync the flip. (If the vault ever normalizes endings,
  this inherits it.)
- Unicode boxes (`☐`/`☑`): not tasks. The grammar says no, the renderer
  agrees, this spec follows both.
- 10,000 tasks: the memoize-per-path rule keeps steady-state paints at the
  cost of changed files only; first paint of the mode parses everything
  once. If profiling ever blames this, the fix is a worker, not a store.
- Dump conflict copies (`(conflict …).md`): ordinary files, scanned like
  any other. Their tasks are real until the conflict resolves.

## 8. Tests

- `src/tasks.test.ts` (new): scanner finds `- [ ]`, `- [x]`, `- [X]`,
  `*`/`+` markers, numbered items, nested items, indented items; ignores
  code blocks, inline `[ ]`, `☐`; title strips marker, keeps first line;
  flip helper toggles both directions at the recorded offset and touches
  nothing else; **parity test**: every `Task` node the parser yields gets
  spans from `spansFor`, and every `cm-md-task-open/done` span traces to a
  `Task` node — the two can never disagree about what a task is.
- `dump` mapping test (in `tasks.test.ts`): `tasksInVault` over two day
  files groups per path with file-local offsets; the flip lands in the file
  body, where the `edited` proposal expects it.
- `loop.test.ts`: open note, propose `edited` flipping a box by hand (the
  exact proposal the button will send) — model, persist and echo behave;
  this pins the contract §3 relies on without testing the button through it.
- DOM test (`vault.test.ts`, beside "check-ins on screen"): hydrate notes
  with boxes, go to tasks mode, assert open groups/counts with done hidden
  and done-only notes absent; toggle on, assert done rows and done-only
  groups appear; tick a box and it leaves the page until toggled; reopen it
  from the done list; click a title, assert the note opened; assert both
  empty states (nothing at all, and everything ticked off with the header
  still offering the way back).
- `keys.test.ts`: `K` proposes `modeChanged: tasks` outside inputs, silent
  while typing or behind a modal.
- Full suite + typecheck + build stay green; no new dependencies.

## 9. Deliberately v1.1 (named so they don't leak in)

- **Caret-precise jump**: row text already opens the note; landing the caret
  on the box needs loop support (`opened` + editor `focusAt`
  choreography) — which is exactly the loop change v1 refuses.
- **Done section**: collapsible recently-done list. Needs a definition of
  "recently" (mtime? the model has none — files carry no timestamps).
- **Due micro-syntax** (`@fri`, `@2026-09-15`): parser extension + sorting
  + overdue styling. The scanner is built to grow it (title already
  isolates display text), but v1 ships without reading it.
- **Tree badges**: open counts beside note rows (`badgesFor` precedent).
- **Notifications**: consume the scanner from the check-ins generalization;
  scheduling stays device-local.

## 10. Acceptance

- Phone, airplane mode, 500-note vault: Tasks tab lists open boxes grouped
  by note with correct counts and no done anywhere; Show done reveals per-group
  collapsed done rows and done-only groups; tapping a box ticks it off the
  page; tapping a title opens its note; reopening the source note shows the
  tick; killing and relaunching loses nothing and reopens clean.
- Desktop: `K` opens the mode; boxes tick; ticking the last open box leaves
  the header offering Show done rather than stranding; empty vault says
  `No open tasks.`
- A box ticked in the note editor vanishes from the list on next paint.
- `bun test`, `tsc --noEmit`, `bun run build`, `git diff --check` green.
