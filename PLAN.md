# Build plan

Five phases. Each is self-contained and ends with the whole thing under test.

The split is at the risky seams: phase 1 proves the architecture with no network,
phase 2 proves sync, and only then does feature work start on a base that is
known to hold.

| Phase | Ends with |
|---|---|
| 1. The loop, offline | A working notes app with no network |
| 2. Sync | It round-trips to GitHub and survives a real conflict |
| 3. The vault | Nested folders, the dump, and offline start-up |
| 4. Documents | Rendered markdown, links, backlinks, rename, search |
| 5. Attachments | Paste an image, get a resized WebP committed |

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

**Goal:** the app becomes a second writer to the `vault` branch. Notes round-trip
to GitHub, and a genuine concurrent edit produces a conflict copy rather than a
lost one.

**The gate:** edit the same note in the GitHub web UI *and* in the app while
offline, then reconnect. Expected: a conflict copy. Phase 2 is not done until
that passes against the real API, not a fake.

## 2.1 The outbox is not a separate store

The obvious design is a queue table alongside the notes. Don't build it.

gafu's one real bug was exactly that: a `tx:` record and an `outbox_pending_keys`
index written in two separate IndexedDB transactions, so a crash or an interleave
between them orphaned the transaction forever.

Here the note record *is* the queue entry. A record carries:

```ts
{ path, body, baseSha, pending, deleted }
```

- `baseSha` — the blob SHA of the remote version last seen. `null` means the note
  has never existed on GitHub.
- `pending` — the body differs from what GitHub has, so it needs pushing.
- `deleted` — a tombstone. The note is gone locally but the remote delete has not
  landed yet; the record disappears once it has.

The outbox is then a *query*, not a structure: `records.filter(r => r.pending)`.
There is no index to keep in step with anything, so there is nothing to
desynchronise. One store, one transaction, no orphans possible.

`pending` must be persisted. Closing the tab with unpushed edits and reopening it
has to still know they need pushing.

## 2.2 Typed errors, finally earning their keep

```ts
type SyncError =
  | { kind: "offline" }                        // keep it, try later
  | { kind: "conflict"; remoteSha: string }    // write a conflict copy
  | { kind: "auth" }                           // ask for a token
  | { kind: "notFound" }                       // treat as a remote delete
  | { kind: "github"; status: number };        // surface it and back off
```

Five errors, five different responses in `present()`. This is the point where the
`E` parameter stops being decoration and an exhaustive switch starts catching the
case that was forgotten. Phase 1's `E = string` gets replaced.

## 2.3 The GitHub client

One module, injected into the loop, so every test runs against a fake and the
whole of sync is testable with no network.

| Operation | Call |
|---|---|
| manifest | `GET /repos/{o}/{r}/git/trees/vault?recursive=1` |
| read | `GET /repos/{o}/{r}/contents/{path}?ref=vault` |
| write | `PUT /repos/{o}/{r}/contents/{path}` with `sha`, `branch` |
| delete | `DELETE /repos/{o}/{r}/contents/{path}` with `sha`, `branch` |

Every method returns `Promise<Result<T, SyncError>>`. HTTP status maps to the
union at this boundary and nowhere else — above this file, statuses do not exist
(principle 6).

Content is base64 both ways, and must be UTF-8 safe: `btoa` alone corrupts
anything non-ASCII, which for a notes app means the first accented character or
emoji. Use `TextEncoder`/`TextDecoder`.

## 2.4 Config and auth

Owner, repo and a personal access token in `localStorage`. If any is missing the
app renders a settings form instead of the note list — there is nothing useful to
show without them.

The token is the user's own, on their own repo. Not a secret from themselves.

## 2.5 Pull

1. Fetch the manifest — every path with its blob SHA, in one call.
2. For each remote path where `remote.sha !== local.baseSha`, fetch the content.
3. **Skip any note that is `pending`.** Local has unpushed edits, so pull must not
   clobber it. The push will discover the conflict via the `sha` check, which
   keeps conflict handling in exactly one place.
4. Local records with a `baseSha` that are absent from the manifest were deleted
   remotely. Remove them — unless they are `pending`, in which case the local
   edit wins and gets re-created.

## 2.6 Push, and the conflict copy

For each pending record: `PUT` with `sha: baseSha`. GitHub commits it, or returns
**409** because the file moved on since.

On 409, Obsidian's answer: keep the remote as canonical and park the local
version beside it.

- Write the local body to `{name} (conflict {YYYY-MM-DD}).md`, itself pending.
- Clear `pending` on the original and let the next pull bring the remote version.

Nothing is lost and no merge is attempted. The conflict name needs the injected
clock (principle 5).

## 2.7 `nap()` needs a real backoff

Phase 1's latch — stop on failure, clear on the next user action — is wrong for a
network. Failures are *normal* there, and nobody is typing while the train is in
a tunnel.

Replace it with `retryAt`: on failure set `retryAt = now + delay`, doubling to a
cap, reset on success. `nap()` skips while `now < retryAt` and schedules a single
wakeup for it. Coming back online resets it immediately.

## 2.8 Tests

**Against a fake client**, so all of it is deterministic and offline:
- Pull adds new notes, updates changed ones, and leaves unchanged ones alone.
- Pull does not clobber a pending note.
- Pull removes a note deleted remotely, but not one with local edits.
- Push sends `baseSha`, and stores the new SHA on success.
- **409 produces a conflict copy, and the local body survives in it.**
- A tombstone deletes remotely, then disappears.
- `offline` keeps the note pending and does not touch the body.
- `auth` surfaces without wedging the loop.
- Backoff: two failures schedule, do not spin, and recover on success.
- Every `SyncError` kind has a branch — adding a sixth must fail to compile.

**Against the real API**, one test, run by hand: the gate above.

## Not in phase 2

The PWA manifest and service worker have moved to phase 3. They are about the app
*shell* loading offline, which is independent of sync being correct, and adding a
build plugin here would blur the one thing this phase is meant to prove.

Also out: folders, the dump, markdown rendering, links, search, attachments.

# Phase 3 — The vault

**Goal:** give the flat list a shape. Nested folders, the dump, and the app shell
loading with no network.

**The gate:** capture a thought on one device, and have it appear on another
without a reload — and with the browser offline from a cold start, the app still
opens and still shows the notes.

## 3.1 The tree

Arbitrary nesting, and it needs no model change: folders are path prefixes, so
the tree is derived from the paths on render. `buildTree(notes)` is a pure
function from a flat list to a nested one — testable with no DOM.

Expansion state lives in the model as a `Set<string>` of open folder paths. Not
persisted; a session is the right lifetime for it.

Folders sort before notes, then alphabetically.

## 3.2 Moving a note

Folders are useless if nothing can move between them. A move is a path change,
and because links match on basename it breaks nothing (phase 4 handles rename,
which does).

The Contents API has no move, so it is a create at the new path plus a delete of
the old — which the existing machinery already expresses: write the new record as
`pending` with a `null` baseSha, and tombstone the old one. Two commits, no new
sync code.

## 3.3 The dump

`dump/YYYY-MM-DD.md`, one file per day. **The day rolls over at 04:00**, so
`dumpDayOf(t) = localDate(t - 4h)` — an entry at 01:30 belongs to the night
before. From the injected clock, never `Date.now()` inline.

It is a second view, not a note: a continuous scroll, oldest to newest, one
`<textarea>` per day, date headers rendered from filenames rather than stored in
them, and the bottom day labelled **Today** rather than its date — at 02:00 the
live day carries yesterday's, which would otherwise read as a bug.

Past days render read-only until clicked. They are settled, and it keeps the hot
path a single focused editor.

**Capture** is a separate input pinned at the bottom. Enter appends
`HH:MM <text>` to today's file and clears. That is the phone gesture, and it is
what makes entries timestamped without fighting a textarea over cursor position.

Appending is naturally in order: time moves forward through a dump day, so a new
entry always belongs at the end. The shifted-hour comparator the decisions doc
specifies — `(h - 4 + 24) % 24`, so `01:30` sorts last — is only needed to merge
two divergent copies of a day. That is not built here, and it gets written when
the merge is (principle 8).

## 3.4 Pull on focus

The app currently pulls once per session, so a note written on the laptop does
not appear on the phone until a reload. `visibilitychange` and `focus` propose a
refresh, which clears `lastSyncedAt` and lets `nap()` do the rest.

This is what makes laptop → phone feel live, and it is four lines.

## 3.5 The app shell offline

A hand-rolled service worker, not `vite-plugin-pwa`.

The usual reason to reach for the plugin is needing the build manifest to
precache hashed filenames. That is avoidable: hashed asset names are immutable,
so caching them *as they are requested* is correct and needs no build step.
Navigations are network-first falling back to cache, so a new deploy is picked up
whenever there is a network and the app still opens when there is not.

Roughly thirty lines and no dependency. Plus a web manifest so it installs to a
home screen.

## 3.6 Tests

- `buildTree` — nesting, ordering, a folder containing only folders, paths with
  no folder at all.
- `dumpDayOf` — 04:00 exactly, 03:59 belonging to the previous day, midnight,
  and a DST-shifted day.
- Capture appends `HH:MM` to the right file, and creates that file if the day has
  not started yet.
- The dump renders one editor per day, with past days read-only.
- Moving a note tombstones the old path and marks the new one pending.
- A focus event triggers exactly one pull, not one per event.
- Expanding and collapsing a folder does not touch note state.

## Not in phase 3

**Lazy loading of note bodies.** The plan said the dump would lazy-load off the
manifest. `pull` does fetch every changed file, one request per dump day on a
first sync — but lazy bodies is the wrong fix to reach for first, and the cost is
recorded in `DECISIONS.md` under accepted costs. The wall is latency, so bounded
concurrency answers it for a fraction of the work and no change to the model.
Lazy bodies is for when the data itself is too large, which is a different
problem and not this one yet.

Also out: markdown rendering, links, backlinks, rename, search, attachments.

# Phase 4 — Documents

**Goal:** notes stop being plain text. Rendered markdown, links that work,
backlinks, rename that does not break them, and search.

**The gate:** rename a note that three others link to, and have every one of
those links still resolve afterwards — with the rewrite visible on GitHub.

## 4.1 Rendering

`marked`, not `remark`.

The plan justified remark by needing an AST to find `[[wikilinks]]`. That was
wrong: a wikilink is `/\[\[([^\]]+)\]\]/g` over the raw text, three lines and no
parser. With that gone, the remaining job is markdown to HTML, which is what
`marked` does in a third of the weight.

Wikilinks are turned into ordinary markdown links *before* parsing, so the
renderer needs no plugin and no fork.

**Raw HTML is stripped from the output.** Not a dependency — a short pass over
the produced fragment removing `script`, `iframe`, `object`, `embed`, every
`on*` attribute, and any non-`http(s)` URL. Personal notes rarely contain
deliberate HTML, and the agent-native goal means content can arrive from a web
page an agent summarised. This is not DOMPurify and is not claimed to be; it
removes the obvious class rather than every case.

The editor stays a textarea. Rendering is a **preview toggle**, not a WYSIWYG
surface — the round trip through a document model is the trap phase 1 avoided
and there is still no reason to take it.

## 4.2 Links and backlinks

`[[japanese-grammar]]` resolves on **basename**, so a note keeps its links when
it moves between folders. If two notes share a basename the link is ambiguous
and needs a path; that is surfaced rather than guessed at.

Backlinks — "what points here" — are derived by scanning bodies, not stored.
At a few hundred notes that is a scan per render and imperceptible; when it is
not, memoise it. Storing an index would be a second source of truth for
something the notes already say (principle 4).

A broken link renders differently from a live one. A link to a note that does
not exist yet is a normal thing to write, and clicking it should offer to create
it.

## 4.3 Rename is an operation

The thing `DECISIONS.md` promised. Renaming `a.md` to `b.md`:

1. find every note whose body contains `[[a]]`
2. rewrite those to `[[b]]`, marking each dirty and pending
3. move the note itself, tombstoning the old path

All in `present()`, so it is one synchronous state change — either the whole
rename happened or none of it did.

**Deferred: making it one commit.** The decisions doc calls for the Git Data
API so the N files land atomically. Pushing them individually means a window
where some links point at the new name and some at the old, if the network dies
midway. Self-healing, since the rest stay pending and retry — and it reuses the
push path that already exists rather than adding a second one. **Trigger: it
actually stranding a rename in practice, or a vault big enough that a rename
touches dozens of files.**

## 4.4 Search

`Array.filter` over path and body, case-insensitive, as the decisions doc says.
Results replace the tree while the box has text. No index, no dependency.

## 4.5 Tests

- Wikilink extraction: multiple links, duplicates, ones inside code fences (a
  known limitation if not handled — decide and test whichever way).
- Basename resolution, including a link that matches nothing and one that
  matches two notes.
- Backlinks find every referrer and no false positives.
- Rename rewrites every inbound link, and leaves `[[ab]]` alone when renaming
  `[[a]]`.
- Rename marks every touched note pending, so all of them sync.
- The sanitizer drops `script`, `on*` and `javascript:` while keeping ordinary
  markup.
- Search matches path and body, and is case-insensitive.

## Not in phase 4

**Attachments have moved to phase 5.** They are a different kind of change from
everything above: a binary record type threaded through the model, a second
encoding path in the GitHub client, and rewriting image sources to local data
URLs in the renderer. Bundling that with rendering and rename would make the
phase hard to review and give it two unrelated gates. Everything in phase 4 is
"text in, text out"; attachments are not.

---

# Phase 5 — Attachments

**Goal:** paste an image into a note and have it committed as a small WebP,
rendered from the local copy so it works offline and in a private repo.

**The gate:** paste a large screenshot, confirm what lands on GitHub is a WebP
under a few hundred KB, and confirm the image still renders with the network
off.

## 5.1 An attachment is a record, not a new thing

`NoteRecord` gains `encoding: "utf8" | "base64"`. An attachment is a record whose
body is base64.

That means persistence, the outbox, `pending`, conflict handling and the retry
loop all work unchanged — no second sync path, no second store. The cost is
filtering attachments out of the note tree and search, which is the same
`isDumpPath` pattern already there.

Binary-ness is decided by extension, not by folder, so an image is still an image
wherever it sits.

## 5.2 Encoding at the boundary

`github.read` and `github.write` take the encoding. For `utf8` they convert to
and from base64 as now; for `base64` they pass it straight through, because the
Contents API wants base64 anyway and re-encoding it would be wrong twice.

## 5.3 Paste

On paste, the first image on the clipboard is:

1. drawn to a canvas, longest edge capped at 2000px
2. re-encoded as WebP at ~0.85 quality
3. hashed, giving `attachments/YYYY-MM-DD-<shorthash>.webp`
4. added as a record, with `![](path)` inserted at the cursor

A 4 MB screenshot lands at roughly 200 KB. **Anything still over 1 MB after that
is refused** rather than committed — git keeps binaries forever, so one bad paste
is permanent and only removable by rewriting history.

The date and the hash both come from injected dependencies, so the whole thing is
testable without a browser.

## 5.4 Rendering

A relative `![](attachments/…)` is resolved against the local record and rendered
as a `data:` URL. It therefore works offline, and in a private repo, where a raw
GitHub URL would not.

The sanitizer has to allow those. It allows `data:image/<type>;base64,`
specifically — **not** `data:` in general, which would readmit `data:text/html`
and with it the whole class the sanitizer exists to remove.

An unresolved image source is left visibly broken rather than silently dropped.

## 5.5 Tests

- Naming: same bytes give the same path; a different day gives a different one.
- Over-size refusal, and that nothing is added to the model when it happens.
- The record round-trips base64 through IndexedDB unchanged.
- `write` does not double-encode a base64 body; `read` does not decode one.
- Attachments do not appear in the tree, in search, or as an openable note.
- A relative image source resolves to a data URL; an unknown one does not.
- The sanitizer permits `data:image/png;base64,` and still refuses
  `data:text/html`.
