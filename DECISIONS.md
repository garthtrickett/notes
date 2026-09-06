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
| Editor | `<textarea>`, **uncontrolled** | Native control behaves correctly on mobile keyboards. No WYSIWYG: the markdown → doc-tree → markdown round trip is lossy exactly where people notice, and it costs more than every other feature combined. |
| Markdown → AST | `remark` / unified | Need an AST for `[[wikilinks]]`, tags, headings. Not `marked` — that's render-only. |
| Search | `Array.filter` | 1,000 notes × 2 KB is 2 MB. Add FTS when it's measurably slow, not before. |
| Toolchain | Bun | Fast install, runs TS directly, built-in test runner and `.env`. Low stakes — there is no production runtime, so the compat surface is Vite + tests. `npm i && node` is a one-command exit. |
| Build | Vite → PWA | |

---

## Repo layout

Notes live in folders, one `.md` per note. Plus a daily dump for quick capture.

```
notes/                       # the git repo
  inbox/
    some-thought.md
  projects/
    gafu/
      adaptive-media.md
  reference/
    japanese-grammar.md
  dump/
    2026-09-06.md            # today
    2026-09-05.md            # immutable once the day ends
```

**Folders are not a data structure.** They are a path prefix. There is no folder
entity, no tree table, no parent pointers — the Trees API manifest already
returns every path, so the tree is derived from the paths on read. Creating a
folder is creating a note inside it.

**Moving a note is a delete + a create.** The Contents API has no move, so a move
is two calls and two commits, and the `sha` compare-and-swap covers each half
separately. If that starts to feel wrong, the Git Data API does it as one commit.
Also: a move changes the path, which is the identity — see open question 1.

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

const attempt = <T, E>(fn: () => T, onThrow: (u: unknown) => E): Result<T, E> => {
  try { return ok(fn()); } catch (e) { return err(onThrow(e)); }
};

const attemptAsync = async <T, E>(p: Promise<T>, onThrow: (u: unknown) => E): Promise<Result<T, E>> => {
  try { return ok(await p); } catch (e) { return err(onThrow(e)); }
};

const combine = <T, E>(rs: readonly Result<T, E>[]): Result<T[], E[]> => {
  const values: T[] = [], errors: E[] = [];
  for (const r of rs) r.ok ? values.push(r.value) : errors.push(r.error);
  return errors.length ? err(errors) : ok(values);
};

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

---

## Open questions

1. **Dump shape — decide first, it is cheap now and annoying later.** One file
   per day under `dump/` (recommended, see Repo layout) versus a single
   `dump.md` split by day headings. The UI is identical either way.
2. **Filename vs. identity.** If filename *is* the title, renaming breaks every
   `[[wikilink]]` (Obsidian's long-running pain). Stable ID in frontmatter with
   links by ID survives renames but makes the repo less human-browsable. Git
   tracks renames fine; the link graph doesn't. **Decide before 500 notes.**
3. Attachment policy — separate dir, size threshold, or don't commit binaries.
4. CodeMirror 6 on desktop later, or textarea forever? Ship textarea first and
   find out whether it's actually missed.

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

- **Pure:** `present()`, `nap()`, the manifest diff, the view functions.
- **Impure:** the async actions — whose only job is to end in a `present()` call.

Functional core, imperative shell. The boundary is marked by *position in the
loop*, not by a type — which is stronger, because you cannot cast your way out of
a position. And it is checkable by reading.

### 3. Everything is immutable except inside `present()`

The original phrasing was "immutability wherever suitable". "Wherever suitable"
was doing a lot of work, and in this design "suitable" has a precise boundary —
so it is stated as the boundary instead.

Proposals, Results, manifests, view inputs: all `readonly`.

`present()` mutates `M` in place, deliberately. With exactly one writer,
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

