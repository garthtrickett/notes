# notes — stack decisions

**Status:** decided, nothing built yet.
**Date:** 2026-09-06

Working name only. Rename the folder once the app has one.

---

## What this is

A markdown note-taking app. Web + phone, same app (PWA). Single user.

**Your notes are `.md` files in a GitHub repo. The app is one web page that edits
them, driven by a single loop. There is no backend.**

---

## The loop

Everything enters at the top and leaves at the bottom. Nothing mutates outside
`present()`. Nothing throws into the loop — failures arrive as proposals.

```
  you type / a fetch returns
            ↓
       proposal
            ↓
     present()   ← the ONLY thing that mutates. may reject.
            ↓
      render()   ← lit-html, pure model → DOM
            ↓
        nap()    ← "what should happen automatically now?"
            ↓
    async action → Result → back to proposal
```

---

## Decisions

| Job | Choice | Why |
|---|---|---|
| Source of truth | `.md` files in a git repo | Markdown's whole value is outliving the app that wrote it. Files give git, grep, external editors, and a backup story for free. Export is `git clone`. |
| Backend | GitHub REST API, no server | Contents API `PUT` takes a `sha` and fails on mismatch — that's compare-and-swap, i.e. the entire conflict-detection system, for free. Trees API `?recursive=1` returns every path + blob SHA in one call: that's the sync manifest. Both CORS-enabled. |
| Auth | Personal access token in localStorage | Single user, own repo. No login system to build. |
| Offline | IndexedDB cache + outbox, raw (~25 lines) | Need multi-key transactions, which `idb-keyval` does not expose. Not using a wrapper. |
| Architecture | SAM (State-Action-Model) | One mutation point, serialized. Structurally prevents the concurrent read-modify-write class of bug. The NAP is where the sync engine lives. |
| View | `lit-html` standalone | Pure function from model to DOM — exactly the `S` SAM wants. No web components, no shadow DOM, no base class. ~5 KB. |
| Errors | Hand-rolled `Result<T, E>` | ~20 lines. Typed errors + exhaustive handling with no runtime and nothing to cast away at a boundary. |
| Editor | `<textarea>`, **uncontrolled** — see *The editor, revisited* below | Native control behaves correctly on mobile keyboards. No WYSIWYG: the markdown → doc-tree → markdown round trip is lossy exactly where people notice, and it costs more than every other feature combined. That reasoning still stands and is not reversed; what follows is a third option it did not consider. |
| Markdown → HTML | `marked` + a hand-rolled sanitizer | An earlier row here specified `remark` and rejected `marked`, on the grounds that finding `[[wikilinks]]` needed an AST. It does not — a wikilink is a three-line regex — so the only remaining job is rendering, which `marked` does in a third of the weight. Raw HTML is stripped from the output rather than trusted, since an agent may summarise a web page into a note. |
| Search | `Array.filter` | 1,000 notes × 2 KB is 2 MB. Add FTS when it's measurably slow, not before. |
| Toolchain | Bun | Fast install, runs TS directly, built-in test runner and `.env`. Low stakes — there is no production runtime, so the compat surface is Vite + tests. `npm i && node` is a one-command exit. |
| Build | Vite → PWA | |

---


## The editor, revisited

**Decision: one editing surface, on CodeMirror 6 — conditional on a mobile
spike.** Build detail is `PLAN.md` phase 6; this records what was chosen and why,
and is the only copy of the reasoning.

### This is not the WYSIWYG the row above rejects

Worth stating plainly, because otherwise the two read as a contradiction.

The original decision rejected a **document model**: parse markdown into a tree,
edit the tree, serialise back. The round trip is lossy at whitespace, list
markers, code fences and footnotes, and it would destroy semantic line breaks,
which two other decisions depend on.

CodeMirror is not that. The document **is** the markdown text, always. Styling is
decoration painted over it — headings drawn larger, `##` dimmed rather than
removed, images drawn as widgets over their own source. Nothing parses to a tree
and writes back, so nothing round-trips, so the original objection simply does
not apply. The earlier reasoning survives intact; it was answering a different
question.

### What forced a library, when nothing else did

Selecting text → an inline image → text as one range, then moving it.

Every cheaper option was examined and each has a ceiling. A textarea with a
styled overlay cannot change font size, because the overlay must match its
metrics character for character. The Custom Highlight API is paint-only by
design, for the same reason. A block editor — rendered blocks, a textarea for
the focused one — needs no library at all, and cross-block selection is precisely
its one stated weakness.

So the requirement is what decides it, not the aesthetic.

### The Ulysses rules, which are the scope

Markup stays **visible** and subordinate rather than hidden. That is the design,
not a limitation, and it removes the largest source of complexity in a live
preview editor: nothing appears or disappears as the caret moves, so nothing
reflows. Preview stops being a mode; a rendered view becomes export, if it exists
at all.

### What it removes

More than it adds, which is the only version worth doing: preview mode and its
`E` shortcut, the preview node cache, `render-markdown.ts`, `marked`, and
`syncEditorValue`'s hand-rolled caret arithmetic — CodeMirror maps selections
through transactions itself.

And almost the whole XSS surface, since nothing renders untrusted markdown to
HTML any more. The exception is named in the plan: the image widget, whose `src`
is a `data:` URL built from our own IndexedDB bytes, with the mime derived from
the extension against a fixed allowlist that never includes `image/svg+xml`.

### Costs accepted, if it lands

- **~200–250 KB minified**, fetched once and held by the service worker. Measure
  on the real build rather than trusting that figure.
- **A contenteditable surface on mobile.** CodeMirror 6 was rewritten with mobile
  as a goal and Obsidian ships it at scale, so this is a risk to test rather than
  a known problem — but it is the risk.
- **Accessibility.** A `<textarea>` is natively accessible; CodeMirror relies on
  its own ARIA. Check with a screen reader *before* deleting the textarea path.
- **Two editors during rollout**, behind a device-local flag. The trigger for
  removing it is written into the plan, because drifting into keeping both is the
  likeliest bad outcome — worse than either editor alone.

### The condition

An hour-long spike on a real phone decides it: drag-select across an inline
image, copy, paste. If that fails on a touch device the decision is void and the
textarea stays, with the cheap consolation prize of dimming markup and colouring
headings via an overlay — no size hierarchy, no inline images, no library.

The mobile question has already been asserted in both directions in this project
without evidence. It gets answered by a thumb, not by argument.


## Repo layout

**One repo, two branches with no shared history.**

- `main` — the app. Normal code history.
- `vault` — an **orphan branch** holding the notes. Nothing else.

One clone, one token, one privacy switch: if privacy is ever wanted, the whole
repo goes private in one click. But `main`'s log stays readable, because the
app's auto-commits land on a branch that shares no history with it.

Notes live in folders at the **root of `vault`**, one `.md` per note, plus a
daily dump for quick capture.

```
main                           # the app
  src/
  package.json
  DECISIONS.md

vault                          # orphan branch — notes only, at the root
  inbox/
    some-thought.md
  projects/
    gafu/
      adaptive-media.md
  reference/
    japanese-grammar.md
  dump/
    2026-09-06.md              # today
    2026-09-05.md              # immutable once the day ends
  attachments/
    2026-09-06-a3f19c.webp
```

**No path prefix, no manifest filtering.** Because the notes have a branch to
themselves, everything the Trees API returns for `vault` *is* a note. The sync
does not have to filter its own source out of the manifest — the branch is the
boundary. This is the main reason to prefer a branch over a `vault/` directory.

The cost is one extra parameter on two calls:

| Call | Parameter |
|---|---|
| Trees — `GET /git/trees/vault?recursive=1` | branch name as the tree ref |
| Contents GET | `?ref=vault` |
| Contents PUT | `"branch": "vault"` in the body |

**Never merge `vault` into `main`.** GitHub will offer a PR after the first
push; decline it. They are separate histories on purpose.

**Folders are not a data structure.** They are a path prefix. There is no folder
entity, no tree table, no parent pointers — the Trees API manifest already
returns every path, so the tree is derived from the paths on read. Creating a
folder is creating a note inside it.

**Nesting is arbitrary-depth and free.** `projects/gafu/runtime/notes.md` needs
no more machinery than `inbox/thought.md`, because nothing in the model knows
what a folder is. Depth is a rendering concern only — the tree view splits paths
on `/`. Storage, sync and the manifest are unaffected.

**Moving a note is a delete + a create.** The Contents API has no move, so a move
is two calls and two commits. Links match on basename, so a move breaks nothing —
see note identity below.

### The daily dump

One day per file, under `dump/`. Presented in the UI as one continuous scroll
split by day heading — **the view and the storage do not have to be the same
shape**, and here they shouldn't be.

Why not literally one `dump.md` split by `## 2026-09-06` headings, which is the
more obvious reading:

- It would be **the single highest-contention object in the repo.** Every quick
  thought from every device writes the same file. Everything else is touched by
  one device at a time; this is the one thing that isn't.
- **The Contents API sends whole file contents on `PUT`.** Appending one line
  means uploading the entire dump history, every time, forever.
- **A conflict copy would be catastrophic rather than annoying.** A conflicted
  note gives you `note (conflict).md` and a one-minute reconcile. A conflicted
  `dump.md` gives you a duplicate of your entire capture history.

One file per day fixes all three at once, and buys something extra: yesterday's
files are immutable, so they can never conflict. Only today's file is ever hot,
and it is small.

It also makes the dump uniform with everything else — a dump entry is just a
file, so search, backlinks, and `[[dump/2026-09-06]]` links all work with no
special cases. A single `dump.md` would need anchor links and its own search
handling.

**Append-only files also merge well.** If today's file does conflict, the entries
are timestamped and order-independent, so union-the-lines and sort is usually a
correct automatic resolution — the one place in this design where auto-merge is
safe. Worth doing, since this is the file most likely to conflict.

#### It must feel like one file

The storage is many files. The UI is one continuous scroll, oldest to newest,
with a date header between days — open it and you land at the bottom, in today,
ready to type. It should read like a single long document.

That illusion has four requirements, and getting them wrong is how the illusion
turns into a data model.

**One textarea per day, not one textarea over everything.** A single editor
holding all days would have to parse file boundaries back out of the text on
save, inferring them from `## 2026-09-06` lines. That is the WYSIWYG round-trip
trap wearing a different hat — and it breaks the moment a note contains a line
that looks like a date header. One editor per day keeps each save mapped to
exactly one file with its own `sha`, so editing an old day can never corrupt
today.

**Past days render read-only until clicked.** They are settled. This matches
reality, keeps the scroll cheap to render, and leaves the hot path — typing into
today — a single focused textarea.

**Date headers are rendered from filenames, never stored in the files.** A file
must not begin with `## 2026-09-06`; that duplicates its own name. One source of
truth for the date, clean files for the agent and for `git diff`. (Principle 4:
never duplicate rules.)

**Lazy load from the manifest.** After a year there are 365 files, and the scroll
must not fetch them all. The Trees API manifest already lists every path with its
SHA in one call, so the app knows what exists without reading any of it — the
manifest *is* the index. Load today plus recent days; fetch older ones as the
user scrolls up.

**Entries carry a time.** Something like a leading `14:32`. This is not
decoration: the auto-merge claim above depends on it. Untimestamped free text
cannot be union-and-sorted back into a correct order, so without per-entry times
the one safe auto-merge in the design stops working.

#### The day rolls over at 04:00, not midnight

A thought at 01:30 belongs to the night before, so it goes in the previous day's
file. The rule is `dumpDate(t) = localDate(t - 4h)`, device-local, and it comes
from the injected clock — never `Date.now()` inline (principle 5).

Two consequences that are easy to get wrong.

**The same rule orders entries, and must be reused rather than reimplemented.** A
day now runs 04:00 → 03:59, so a naive sort on `HH:MM` puts a 01:30 entry *above*
the 09:00 ones. Sort on the shifted hour, `(h - 4 + 24) % 24`, using the same
function that picks the file — one rule, one place (principle 4). This also keeps
the files simple: an entry displays a plain `01:30` and stores no extra timestamp.

**The auto-merge this was written for does not exist yet.** A conflicted dump day
gets a conflict copy like anything else; nothing unions and sorts two versions.
The comparator is specified here because when that merge is built it must use
the shifted hour — sorting raw `HH:MM` would silently reorder the day — but it is
a rule waiting for its caller, not a description of running code.

**Trigger: the first time a conflict copy of a dump day is annoying enough to
merge by hand.**

**The bottom day is labelled "Today", not its date.** At 02:00 the current dump
day carries yesterday's date, which would otherwise read as a bug. Labelling the
live day "Today" sidesteps it, and is nicer anyway.

### Note identity: the filename is the identity

`[[japanese-grammar]]` resolves to `reference/japanese-grammar.md`. Readable,
greppable, browsable on github.com, obvious to an agent reading raw files. That
legibility is the reason files were chosen at all, so it is not traded away to
avoid a rename bug.

**Rename is an operation, not a filesystem event.** The app finds every note
containing `[[old-name]]`, rewrites them, and moves the file. Obsidian works this
way. Two consequences:

- **Links match on basename, not full path.** So *moving* a note between folders
  breaks nothing and needs no rewrite at all — and moving is far more common than
  renaming in practice. Only a genuine rename touches other files. If two notes
  ever share a basename, that link needs a path to disambiguate.
- **Rename is the first operation that needs the Git Data API.** It writes N
  files atomically; N separate Contents API calls would leave links broken if one
  failed halfway. The fallback is accepting transient breakage, but a batched
  commit is the right shape.

Filenames are lowercase-hyphenated slugs. The UI displays them prettified
(hyphens to spaces). The mapping is deterministic, so this is a display rule and
not a hidden identifier — renaming the title *is* renaming the file.

### Attachments: shrink on paste, then commit

Paste a screenshot, the browser canvas-resizes it to ~2000px and re-encodes to
WebP before upload. A 4 MB screenshot lands at roughly 200 KB. Around 20 lines.

Everything stays self-contained: `git clone` still gets the notes *and* the
images, and standard `![](attachments/...)` markdown means notes render with
their images on github.com for free.

`attachments/YYYY-MM-DD-<shorthash>.webp` — date-prefixed so it sorts, hashed so
it never collides.

At 1,000 images that is ~200 MB accumulated over years. Fine.

**The rule that actually matters: never commit a raw screenshot, not even once.**
Undoing that means rewriting history. Cap the post-resize size (~1 MB) and refuse
anything pathological — large animated GIFs, video — rather than letting one
paste bloat the repo permanently.

Two rejected alternatives, recorded so they are not revisited:

- **Git LFS** is the textbook answer and does not work here. The Contents API
  does not speak LFS — a browser `PUT` commits raw bytes, not a pointer.
- **External hosting** (S3, imgur) keeps the repo small but makes notes depend on
  a service that can rot, and "export is `git clone`" stops being true.

Deleting a note leaves its images orphaned, and git keeps them regardless, so
cleanup is cosmetic rather than a space saving. Not worth building.

---

---

## Deliberately not building

No server. No database. No ORM. No migrations. No login. No sync engine.
No CRDT. No HLC. No Effect. No fibers. No web components. No export feature.

This list is the design. Everything above is detail.

---

## The kernel

```ts
// ---- errors ----
type Result<T, E> =
  | { readonly ok: true;  readonly value: T }
  | { readonly ok: false; readonly error: E };

const ok  = <T>(value: T): Result<T, never> => ({ ok: true,  value });
const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

// Takes a thunk, not a promise: an expression that throws before it produces a
// promise is then caught too.
const attemptAsync = async <T, E>(
  run: () => Promise<T>,
  onThrow: (u: unknown) => E,
): Promise<Result<T, E>> => {
  try { return ok(await run()); } catch (e) { return err(onThrow(e)); }
};

// A synchronous attempt() and a combine() collecting every error are the obvious
// next two. They are not written until something needs them (principle 8).

type SyncError =
  | { kind: "offline" }
  | { kind: "conflict"; path: string }
  | { kind: "auth" }
  | { kind: "github"; status: number };

// ---- model: only present() touches this ----
const M = {
  notes: new Map<string, { body: string; baseSha: string }>(),
  outbox: [] as string[],
  online: navigator.onLine,
  syncing: false,
  dirty: false,
  error: null as SyncError | null,
};

// ---- present: accepts or rejects ----
function present(p: Proposal) {
  switch (p.kind) {
    case "edited":
      if (!M.notes.has(p.path)) return;                    // reject
      M.notes.get(p.path)!.body = p.body;
      if (!M.outbox.includes(p.path)) M.outbox.push(p.path);
      M.dirty = true;
      break;
    case "push-ok":
      M.outbox = M.outbox.filter(x => x !== p.path);
      M.notes.get(p.path)!.baseSha = p.sha;
      M.syncing = false;
      break;
    case "push-failed":
      M.syncing = false;
      if (p.error.kind === "conflict")      saveConflictCopy(p.path);
      else if (p.error.kind === "offline")  M.online = false;
      else                                  M.error = p.error;
      break;
  }
  scheduleRender();
  nap();
}

// ---- nap: every automatic behaviour, one place. this is the sync engine. ----
function nap() {
  if (M.dirty)                                   { M.dirty = false;   void persistLocal(); }
  if (M.online && !M.syncing && M.outbox.length) { M.syncing = true;  void pushNext(); }
}

// ---- action: async, ends in a proposal ----
async function pushNext() {
  const path = M.outbox[0], n = M.notes.get(path)!;
  const r = await push(path, n.body, n.baseSha);           // Result<string, SyncError>
  present(r.ok ? { kind: "push-ok",     path, sha: r.value }
               : { kind: "push-failed", path, error: r.error });
}
```

`nap()` is the entire sync engine. The `409` branch is the entire conflict
resolution.

---

## Accepted costs

Stated up front so they aren't surprises later.

- **Married to GitHub.** Exit is a small server owning a real working tree,
  exposing `list / get / put`. Storage format is unchanged, so the migration is
  contained.
- **Git is batch, not real-time.** Fine for the actual pattern (laptop morning,
  phone lunch, desktop evening). Mitigate by pulling on focus and pushing on
  idle, so conflicts rarely form at all.
- **Git merges by line.** Write with **semantic line breaks** — one sentence per
  line, blank line between paragraphs. Renders identically, makes diffs
  sentence-level, makes auto-merge succeed far more often. Reflow on save.
- **Never show a conflict marker.** On `409`, write
  `note (conflict 2026-09-06).md` and let the human reconcile in the app's own UI.
- **iOS will evict PWA storage.** Seven days of non-use can clear IndexedDB. Call
  `navigator.storage.persist()`, prompt to install to home screen, and treat the
  local cache as genuinely disposable — push aggressively so nothing lives only
  on the device.
- **Contents API is one commit per file.** History gets noisy. If that starts to
  bother, switch to the Git Data API (blob → tree → commit → ref) to batch a
  commit across files.
- **Attachments.** Git never forgets a 4 MB pasted screenshot. Decide a policy
  before the first paste.
- **The GitHub API is not read-your-writes across endpoints.** The Trees API can
  lag seconds behind a Contents write, so a manifest may omit a file that was
  just created. Consequence: a manifest omission is never enough to delete a
  note locally — every disappearance is confirmed against the Contents API
  first. Deleting is the most destructive thing here and deserves the second
  signal.
- **Two O(n)-per-render scans, left in deliberately.** `nap()` walks every note
  twice per proposal to find dirty and pending ones, and `backlinksTo` runs the
  wikilink regex over every body on every paint. Both are imperceptible at the
  sizes this has seen, and fixing them early would be exactly the speculation
  principle 8 warns about. **Trigger: typing feels laggy.** The answers are a
  dirty/pending count kept on the model and a memoised backlink pass — not a
  rewrite.
- **A pull is one round trip per changed file, in series.** `pull` fetches each
  changed file one at a time, then makes a second sequential pass confirming any
  file the manifest omitted. A first sync of a thousand-note vault is therefore a
  thousand sequential round trips. Correct, and fine at the sizes this has seen.

  The escape hatch is **bounded concurrency**, not lazy loading. The wall here is
  latency, not data volume: a `Promise.all` over a small pool fixes it in about
  fifteen lines with no change to the model. Lazy bodies (`body: string | null`
  threaded everywhere) is the answer to a different problem and should not be
  reached for first. **Trigger: a first sync you notice waiting for.**
- **Authenticated API responses carry `Cache-Control: private, max-age=60`.**
  Every request is therefore `cache: "no-store"`. Without it the browser serves
  a minute-old tree and a note written on another device simply appears not to
  exist, which reads as sync being broken.
- **`git clone` no longer gets the notes.** It gets `main`. Export is
  `git clone -b vault <repo>`, or `git fetch origin vault` in an existing clone.
  Slightly worse than the one-command story, and the price of a clean `main`.
- **CI needs the right branch filter.** A workflow scoped to `main` will not fire
  on note commits, which is the desired behaviour — but a workflow with a bare
  `on: push` will fire on every captured thought. Scope it explicitly.
- **Splitting into two repos later is now trivial**, if it ever comes to that:
  `vault` is already an independent history, so it is one `git push` to a new
  remote.

---

## Open questions

1. **Dump shape — decide first, it is cheap now and annoying later.** One file
   per day under `dump/` (recommended, see Repo layout) versus a single
   `dump.md` split by day headings. The UI is identical either way.
2. CodeMirror 6 on desktop later, or textarea forever? Ship textarea first and
   find out whether it's actually missed.


## Agent-native

**Goal:** an agent should be able to achieve anything the UI can achieve. Features
are outcomes described in prompts, not code paths. Reference: Shipper & Claude,
*Agent-native Architectures* (Every).

### Most of this is already paid for

The article's central claim is that files are the best agent interface —
inspectable, portable, self-documenting, and the primitives agents are most
fluent with. This design landed on `.md` files in a git repo for entirely
separate reasons, which means the substrate is already right:

| Article principle | Status here |
|---|---|
| Files as the universal interface | The whole design |
| Shared workspace, not a sandbox | Agent and user both write the `vault` branch |
| Self-documenting structure | `projects/gafu/adaptive-media.md` |
| Inspectable, portable, no black box | `git clone -b vault` |
| Conflict model | Already stronger than the article's: `sha` is a real
compare-and-swap, not last-write-wins |

### The one real conflict: an agent needs a key, and there is no backend

An LLM call needs an API key. A public client-side PWA cannot hold one. This is
the only place agent-native genuinely collides with "no server", so it is the
decision to make rather than drift into.

**Decided: A — the agent edits the files directly, on a clone of `vault`.**

Claude Code (or any CLI agent) in a checkout. It reads and writes `.md` files
with bash, exactly as the human does. No tools to write, no key in a browser, no
server, nothing to build. `AGENTS.md` at the vault root carries the conventions,
with `CLAUDE.md` symlinked to it so Claude Code picks it up either way.

Deferred, not rejected:

**B. Bring-your-own key in the browser.** Same precedent as the GitHub PAT in
localStorage. The expensive one: agent loop, tool definitions, streaming, and
mobile's checkpoint/resume problem, since a PWA is backgrounded within seconds.
Also questionable on its merits — phone use is mostly *capture*, which needs no
agent. Revisit only if A proves an in-app agent is genuinely wanted.

**C. GitHub Actions as the agent runtime.** Cron, push to `vault`, or
`workflow_dispatch` — which is a manual button reachable from the GitHub mobile
app. Secrets live in GitHub, no server. The natural fit for unattended work:
nightly filing, weekly review, link repair. The obvious next step after A.
⚠ The repo is public, so Actions logs are public — an agent that echoes note
contents publishes them.

**D. A key-proxy function** (Worker or serverless) keeps the key off the client
but reintroduces infrastructure: something to deploy, keep alive, and remember
exists. Rejected for now on those grounds, not technical ones.

### Why option A costs the architecture nothing

The sync already treats "someone else changed this file" as a first-class case —
that is exactly what the `409` branch is for. **An agent is just another
writer.** It is indistinguishable from editing a note on github.com, which is
already a supported path.

So the agent stays entirely outside the loop: it never violates principle 2,
because it is not impure code inside the app, it is a separate process acting on
the repo. Agent-nativeness on day one costs zero changes to `present()`, `nap()`
or the sync.

### Parity map

Every user action is a file operation, which is what makes parity nearly free:

| User action | Agent path |
|---|---|
| Create a note | write a file at a path |
| Edit a note | read, write with `sha` |
| Delete a note | delete the file |
| Move / rename | delete + create (see open question on identity) |
| Capture to today's dump | append to `dump/YYYY-MM-DD.md` |
| Search | `grep` the tree |
| Follow a `[[link]]` | resolve to a path, read it |
| Browse folders | list the tree |

### Rules that follow

- **Atomic tools only, if tools are ever written.** `read_note`, `write_note`,
  `list_notes`, `delete_note`, `search`. Never `organize_my_notes` — that puts
  judgement in code, and changing behaviour becomes a refactor instead of a
  prompt edit.
- **CRUD completeness.** Whatever the entity list becomes, audit all four
  operations. The article's named failure is shipping create and read, then
  forgetting update and delete.
- **Agent writes must be legible.** Distinct commit author or trailer, so agent
  work is visible in `git log` and revertible in one command. Git already gives
  the audit log and the rollback for free.
- **`context.md` at the vault root**, holding what exists and what the user
  prefers. Derived state, so it must be regenerable from the notes — principle 7
  still applies.
- **The dump is the natural agent log.** Append-only, timestamped, day-scoped.
- **Commit before prompting.** Git is the undo button for a destructive prompt;
  a clean tree beforehand turns a bad result into `git reset --hard`.
- **The agent never touches today's dump file.** It is the one file with
  concurrent writers — the human may be capturing to it from their phone. Cold
  days are safe. This falls out of the per-day split for free.
- **No inventory in `AGENTS.md`.** It would go stale and start lying. Conventions
  belong there; current state is discovered by reading the files (principle 7).

### The anti-pattern to actively avoid

The article names it: *build the app, then add the agent* — the agent can then
only do what the features already do, and emergent capability never appears.

This document is currently a full app design with no agent in it, so that is the
live risk. The mitigation is cheap: **option A is available before any app code
exists.** Clone `vault`, point Claude Code at it, and use it. Whatever it turns
out to need is real evidence rather than a guess, and it arrives before the UI
has calcified around a different shape.

---

## Principles

### 1. No classes unless a library forces it

A bright line, which is the point — it needs no judgement at 11pm. It also falls
out naturally here: errors are plain tagged objects (`{ kind: "offline" }`), not
`Error` subclasses, so `instanceof` narrowing never comes up. The one thing that
normally forces classes on you — throwing — is already designed out.

Not a real exception: `Map`, `Set`, `URL`. The rule means "don't write
`class Foo`", not "avoid built-ins".

### 2. Impure code lives only in actions, and every action ends in `present()`

This is the effects discipline. **Do not build an IO wrapper** — no
`type IO<T> = () => T`, no descriptor you interpret later. That is Effect with
worse ergonomics, no docs and no ecosystem, and it is the most likely way this
project ends up where gafu is.

You don't need one, because the loop already quarantines effects structurally:

- **Pure:** `present()`'s note handling, the manifest diff, the view functions.
- **Impure:** the async actions — whose only job is to end in a `present()` call.

`nap()` is *not* pure, and an earlier version of this document claimed it was.
It sets `persisting`, `syncing` and `lastSyncedAt`; `propose()` sets `retryAt`
and `retryDelay`. The honest boundary is not "one writer" but **note state
versus loop state**:

> `present()` owns note state. `loop.ts` additionally writes the in-flight flags
> — facts about what the loop is doing, not about what a note is. Nothing
> outside those two files touches the model at all.

That last clause is the part that is genuinely enforced: actions return
proposals and never see the model. Stating it accurately keeps it a rule; a
principle known to be violated stops being a bright line and becomes a vibe.

Functional core, imperative shell. The boundary is marked by *position in the
loop*, not by a type — which is stronger, because you cannot cast your way out of
a position. And it is checkable by reading.

### 3. Everything is immutable except inside `present()` and the loop

The original phrasing was "immutability wherever suitable". "Wherever suitable"
was doing a lot of work, and in this design "suitable" has a precise boundary —
so it is stated as the boundary instead.

Proposals, Results, manifests, view inputs: all `readonly`.

`present()` mutates `M` in place, deliberately, and `loop.ts` writes the
in-flight flags beside it — see principle 2 for why that is a boundary rather
than an exception. With exactly one writer,
`M = {...M, notes: new Map(...)}` buys nothing and allocates on every keystroke.
The single-writer discipline is what immutability was protecting you from in the
first place, and SAM already gives you that.

`readonly` in types is free and catches real bugs. `Object.freeze` at runtime
mostly doesn't earn its cost. No immer, no structural sharing — not your problem.

### 4. WET until the abstraction is proven

Locality of behaviour over DRY. But give it a trigger, or it becomes an excuse:
**write it three times, then look at all three together.** The third instance is
what tells you which parts actually vary, and it is routinely not what you would
have guessed at instance two.

The trade is asymmetric, so split it: **duplicate shapes freely, never duplicate
rules.** Two render functions that drift apart are just different. Two copies of
the conflict rule, or of the path → identity mapping, is a bug with a delay fuse.

### 5. Injectable clock and IDs

`now: () => number` as a parameter, never `Date.now()` inline. Same for
`crypto.randomUUID`.

Every module in gafu worth keeping did this; it is why they were testable. It
matters more here, because this app is made of dates — dump filenames, conflict
copy names, entry timestamps.

### 6. Parse at the boundary, trust inside

GitHub's JSON is untrusted input. Convert it once, at the edge, into your own
types. A raw API shape must never reach the model.

### 7. The files are the truth

If any state can exist only in IndexedDB, the design is broken. The local cache
is a cache. Easy to drift on, so it is written down.

### 8. Add a dependency when you hit the wall, not when you anticipate it

gafu finished with 18 runtime dependencies that were never imported once —
roughly 90 MB installed, added on speculation for features that never landed.

### 9. Frameworks cover the part that was already easy

Budget attention for the part that isn't. Here that is sync and durability —
which is also where gafu's one real bug lives, having sailed straight through
22k lines of Effect untouched.

---

## Build order

1. `Result` + the three helpers.
2. The loop — `present` / `render` / `nap` — with two hardcoded notes, no editor.
3. Sync: Trees API → diff → outbox → `PUT` → handle `409`.
4. **Prove it.** Edit the same note in the GitHub web UI *and* in the app while
   offline, then reconnect. Expected: a conflict copy. Not a lost edit.
5. Only then: textarea, markdown rendering, links, search.

If step 4 works, the rest is a text box and some CSS.

