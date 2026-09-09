// The loop. Everything enters through propose() and leaves through nap().
//
//   proposal -> present() -> render() -> nap() -> action -> proposal -> ...
//
// present() owns note state; nap() and propose() additionally write the in-flight
// flags beside it — persisting, syncing, retryAt, lastSyncedAt. That is a
// deliberate boundary, not an oversight: the loop *starts* an operation, present
// *concludes* it, so the fields do not partition by owner.
//
// The safety property does not rest on there being one writer. It rests on every
// write happening synchronously inside one turn — nap() is called from propose(),
// never from a callback — and on no async code ever seeing a Model. Actions take
// notes and a client; none of them receives one.

import { render } from "lit-html";
import {
  createModel,
  dumpDays,
  present,
  type Model,
  type Note,
  type Proposal,
} from "./model.ts";
import { loadDone, saveDone } from "./checkins.ts";
import { canInstall, downloadUpdate, installUpdate, openInstallSettings, trace } from "./update.ts";
import { composeDump, dumpEdits, dumpSpotAt } from "./dump.ts";
import * as actions from "./actions.ts";
import type { Github } from "./github.ts";
import { createPreviewCache, localImage, view } from "./view.ts";
import { createMedia } from "./media.ts";
import type { VaultConfig } from "./view-settings.ts";
import { createEditor, type EditorHandle } from "./editor.ts";
import { followLink, resolveLink } from "./links.ts";
import { titleFor, urlFor } from "./url.ts";

export interface Deps {
  readonly db: IDBDatabase;
  readonly shrink: import("./attachments.ts").Shrinker;
  readonly github: Github | null;
  readonly now: () => number;
  // Injected so tests can drive the cooldown without waiting for real seconds.
  readonly schedule: (ms: number, fire: () => void) => void;
  // Reading and writing the stored vault config is ambient, so it is injected
  // rather than reached for.
  readonly config?: VaultConfig | null;
  readonly saveConfig?: (config: VaultConfig) => void;
  // Check-in done-ness is per-device state in localStorage. Injected like the
  // config rather than reached for; absent (as in most tests) it simply does
  // not persist.
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
  // Where the app now is. The loop says it; whether that becomes a new history
  // entry or replaces the current one is not a decision it can make, so it
  // does not try to.
  readonly navigate?: (url: string, title: string) => void;
}

export interface Loop {
  readonly model: Model;
  readonly propose: (p: Proposal) => void;
  readonly flush: () => Promise<void>;
  // Focus is not model state, so it is not a proposal. The loop holds the
  // editor, so it is the only thing that can offer this.
  readonly enterEditor: () => void;
}

const FIRST_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

// How long a note has to sit untouched before it is worth pushing. Nothing is
// at risk while it waits: phase 1 has already put the edit on the device, and
// only the trip to GitHub is held back. Without it every keystroke that settles
// became its own commit, so a sentence arrived as a dozen of them.
const QUIET_MS = 1_500;

export const createLoop = (deps: Deps, root: HTMLElement): Loop => {
  const { db, github, now, schedule, shrink, storage } = deps;
  const model = createModel();
  if (storage !== undefined) model.checkinsDone = loadDone(storage, now());
  let wakeScheduled = false;
  // When each note was last typed into. Bookkeeping about the loop rather than
  // about notes — the same reason the backoff lives here and not in present(),
  // which has no clock and should not be given one.
  const touched = new Map<string, number>();

  let renderQueued = false;
  // A change of note, or of preview, replaces the editor's contents wholesale.
  // Anything else is a change dispatched into the state that is already there.
  let lastEditorKey: string | null = null;
  let lastModal: string | null = null;
  let lastPaletteIndex: number | null = null;
  let lastUrl: string | null = null;
  const previewCache = createPreviewCache();
  // Bytes are read from the blob store when something needs to show them, and
  // held as object URLs rather than on the notes themselves.
  const media = createMedia(db, () => scheduleRender());
  // Everything currently in flight, not merely the most recent thing started.
  // A push can begin while a persist is still running — the first block is
  // skipped rather than returned from — so assigning would drop the persist's
  // promise on the floor.
  let idle: Promise<void> = Promise.resolve();
  const track = (work: Promise<unknown>): void => {
    idle = Promise.all([idle, work]).then(() => undefined);
  };

  // One place that starts (or restarts) the update machine. Permission first:
  // downloading without it is what produced the original silent nothing.
  const beginUpdate = async (): Promise<void> => {
    // A bridge that throws instead of answering is a failure with a name,
    // not an unhandled rejection in the console.
    trace("beginUpdate entered");
    let allowed: boolean;
    try {
      allowed = await canInstall();
    } catch (error) {
      propose({ kind: "updateFailed", error: `Install check failed: ${String(error)}` });
      return;
    }
    if (!allowed) {
      propose({ kind: "updatePermissionNeeded" });
      return;
    }
    trace(`beginUpdate allowed=${String(allowed)}, downloading ${model.update.url}`);
    const found = await downloadUpdate(model.update.url);
    trace(`beginUpdate got ${found.kind}`);
    propose(found);
  };

  const capture = (text: string) => {
    for (const p of actions.captureProposals(model.notes, text, now)) propose(p);
  };

  // Where the caret is differs by surface; what to do with a pasted image does
  // not (never duplicate rules).
  // The clipboard and a drag hand over an image differently; what happens to it
  // afterwards is the same (never duplicate rules).
  const attachImage = (file: File, path: string, caret: number | null) => {
    const note = model.notes.get(path);
    if (!note) return;
    track(
      actions
        .attach(file, note, caret ?? note.body.length, now, shrink)
        .then(async (p) => {
          // Store the bytes first. The proposal that follows describes a record
          // whose bytes are already somewhere the renderer can find them.
          if (p.kind === "attached") {
            await actions.storeBlobs(db, [
              { path: p.path, body: p.base64, encoding: "base64" },
            ]);
          }
          return p;
        })
        .then(propose),
    );
  };

  const pasteImage = (event: ClipboardEvent, path: string, caret: number | null) => {
    const file = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .find((f): f is File => f !== null);
    if (!file) return; // a normal text paste; let the editor handle it

    event.preventDefault();
    attachImage(file, path, caret);
  };

  // Which file a picture dropped at this position belongs in, and where in it.
  //
  // In the dump that is not the open note: openPath still names whichever note
  // the tree had open behind it, and attaching there would file the picture
  // somewhere you are not looking. It is the day under the caret, which needs
  // the document offset turned back into one in that day's file.
  const attachSpot = (caret: number | null): { path: string; offset: number } | null => {
    if (model.mode === "dump") return dumpSpotAt(dumpDays(model), caret ?? 0);
    if (model.openPath === null) return null;
    const note = model.notes.get(model.openPath);
    return { path: model.openPath, offset: caret ?? note?.body.length ?? 0 };
  };

  // Created once, before the first paint, and outlives every one of them. lit is
  // handed an empty container and never touches what is inside it.
  const cm: EditorHandle = createEditor({
    resolveImage: (src) => localImage(model, media, src),
    // Asked at paint time, so a link starts working the moment the note it
    // points at exists.
    resolveWikilink: (target) => resolveLink(target, model.notes).kind,
    onEdit: (body) => {
      // The dump is many files behind one document, so an edit is however many
      // of them the text now disagrees with — usually one, and none at all
      // while you are typing inside a day that has not changed shape.
      if (model.mode === "dump") {
        for (const day of dumpEdits(body, dumpDays(model))) {
          propose({ kind: "edited", path: day.path, body: day.body });
        }
        return;
      }
      if (model.openPath !== null) {
        propose({ kind: "edited", path: model.openPath, body });
      }
    },
    onPaste: (event, caret) => {
      const spot = attachSpot(caret);
      if (spot !== null) pasteImage(event, spot.path, spot.offset);
    },
    onDropFiles: (files, caret) => {
      const image = [...files].find((f) => f.type.startsWith("image/"));
      // Anything else is left to CodeMirror, which will drop its text in.
      const spot = attachSpot(caret);
      if (image === undefined || spot === null) return false;
      attachImage(image, spot.path, spot.offset);
      return true;
    },
    onWikilink: (target) => {
      const proposal = followLink(target, model.notes);
      if (proposal !== null) {
        propose(proposal);
        return;
      }
      // followLink says nothing for an ambiguous target, and a click that
      // silently does nothing is how someone concludes the app is broken.
      propose({ kind: "linkRefused", target });
    },
  });

  // Whether a picture can be drawn at all is what the decorations depend on, and
  // it changes when an attachment arrives or goes. Cheaper than re-parsing on
  // every paint, and it moves for both.
  let lastImageKey = "";
  const imageKey = (): string => {
    let key = "";
    for (const note of model.notes.values()) {
      if (note.encoding === "base64" && !note.deleted) key += `${note.path};`;
    }
    // How many attachments have their bytes to hand, which changes as they
    // arrive. A repaint alone does not rebuild decorations, so without this the
    // widget asked once, got null, and never asked again — the picture stayed
    // missing until the note was edited.
    return `${key}|${media.size()}`;
  };

  const paint = () => {
    render(
      view(model, {
        propose,
        now,
        onCapture: capture,
        previewCache,
        media,
        config: deps.config ?? null,
        onSaveConfig: (next) => deps.saveConfig?.(next),
      }),
      root,
    );

    // Focus a modal as it opens, and only then — refocusing on every paint would
    // fight the caret while typing. One rule, whichever modal it is.
    // By kind, not by object: what matters is that a different dialog appeared.
    const modalKind = model.modal?.kind ?? null;
    if (modalKind !== lastModal) {
      lastModal = modalKind;
      if (model.modal !== null) {
        // Not always an input: the confirm dialog puts it on Cancel, so the
        // safe answer is the one already under your fingers.
        root.querySelector<HTMLElement>("#modal-input")?.focus();
      }
    }

    // Arrow keys move the palette's selection, and past the tenth result it was
    // moving out of sight — you were choosing blind and Enter opened something
    // you could not see.
    const palettePos = model.modal?.kind === "open" ? model.paletteIndex : null;
    if (palettePos !== lastPaletteIndex) {
      lastPaletteIndex = palettePos;
      root.querySelector(".results .row.open")?.scrollIntoView({ block: "nearest" });
    }

    // The path box is uncontrolled while it has focus, so lit will not rewrite
    // what was typed into it. Once focus leaves, it has to agree with the note
    // that is actually open — otherwise a refused rename leaves it naming a
    // note you are not looking at.
    const field = root.querySelector<HTMLInputElement>(".pathfield");
    if (field !== null && document.activeElement !== field) {
      const shown = model.openPath ?? "";
      if (field.value !== shown) field.value = shown;
    }

    const editorKey = `${model.mode}|${model.preview}|${model.openPath ?? ""}`;
    const days = model.mode === "dump" ? dumpDays(model) : null;
    const body =
      days !== null
        ? composeDump(days)
        : model.openPath
          ? (model.notes.get(model.openPath)?.body ?? "")
          : "";

    const host = root.querySelector<HTMLElement>("#editor-host");
    if (host) {
      // lit rebuilds the host when the surrounding template changes shape, so
      // re-attach rather than assume. Moving the same node is a no-op.
      if (cm.dom.parentElement !== host) host.appendChild(cm.dom);

      // A new note gets a whole new state so undo stops at the note boundary.
      // Anything else — a pull, a rename rewriting links, a pasted image — is a
      // change dispatched into the state we have, and CodeMirror maps the
      // selection through it.
      if (editorKey !== lastEditorKey) {
        lastEditorKey = editorKey;
        cm.reset(body);
      } else if (days !== null) {
        // Through the split, not as text. Composing normalises whitespace, so
        // comparing the strings would rewrite the document on every keystroke —
        // and a blank line typed at the end of a day would be trimmed away
        // under the caret as it was typed. What matters is whether the document
        // still says what the files say.
        if (dumpEdits(cm.doc(), days).length > 0) cm.setDoc(body);
      } else if (cm.doc() !== body) {
        cm.setDoc(body);
      }

      const images = imageKey();
      if (images !== lastImageKey) {
        lastImageKey = images;
        cm.redecorate();
      }
    } else {
      lastEditorKey = editorKey;
    }

    // Last, because everything above can still change which note is open.
    const url = urlFor(model);
    if (url !== lastUrl) {
      lastUrl = url;
      deps.navigate?.(url, titleFor(model));
    }
  };

  // The history panel asks for two things, in order: the list of revisions, then
  // the body of whichever one is selected. Both are read-only and neither
  // touches note state, so a failure shows in the panel and nowhere else.
  const napHistory = (): void => {
    const h = model.history;
    if (h === null || github === null || h.loading) return;
    if (h.revisions === null) {
      h.loading = true;
      track(actions.loadHistory(github, h.path).then(propose));
      return;
    }
    if (h.viewingSha !== null && h.viewingBody === null) {
      h.loading = true;
      track(actions.loadRevision(github, h.path, h.viewingSha).then(propose));
    }
  };

  const scheduleRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      paint();
    });
  };

  // Every automatic behaviour lives here, and every rule is a function of model
  // state rather than something a scheduler remembers.
  const nap = () => {
    // 0. Whatever the history panel is waiting for. Read-only, independent of
    //    the sync rules below, and it must not be gated behind them — a stalled
    //    push should not leave the panel spinning.
    napHistory();

    // 1. Get local edits onto the device before anything else. Losing a note to
    //    a closed tab is worse than syncing late.
    if (!model.persisting && !model.persistBlocked) {
      // Forgetting comes first: a record left behind is a note that returns from
      // the dead on the next reload, which is worse than a late save.
      if (model.forgotten.size > 0) {
        const paths = [...model.forgotten];
        model.persisting = true;
        track(actions.forget(db, paths).then(propose));
        return;
      }
      const dirty = [...model.notes.values()].filter((n) => n.dirty);
      if (dirty.length > 0) {
        model.persisting = true;
        track(actions.persist(db, dirty).then(propose));
        return;
      }
    }

    if (github === null || model.syncing || !model.hydrated) return;

    // 2. A network failure cools off. Unlike phase 1's latch, this expires on
    //    its own — nobody is typing while the train is in a tunnel.
    if (now() < model.retryAt) {
      if (!wakeScheduled) {
        wakeScheduled = true;
        schedule(Math.max(0, model.retryAt - now()), () => {
          wakeScheduled = false;
          propose({ kind: "woke" });
        });
      }
      return;
    }
    if (!model.online) return;

    // 3. Push before pulling. An unpushed edit is the only state that exists
    //    nowhere else — but not while it is still being typed into.
    const readyAt = (n: Note): number => (touched.get(n.path) ?? 0) + QUIET_MS;
    const waiting = [...model.notes.values()].filter((n) => n.pending && !n.dirty);
    // Per note, not per keystroke: a note being typed into must not hold up one
    // that was finished with a minute ago.
    const pending = waiting.find((n) => now() >= readyAt(n));
    if (pending === undefined && waiting.length > 0) {
      const soonest = Math.min(...waiting.map(readyAt));
      if (!wakeScheduled) {
        wakeScheduled = true;
        schedule(Math.max(0, soonest - now()), () => {
          wakeScheduled = false;
          propose({ kind: "woke" });
        });
      }
      return;
    }
    if (pending) {
      touched.delete(pending.path);
      model.syncing = true;
      // An attachment's bytes are not on the record, so they are fetched for
      // the push and thrown away again afterwards.
      track(
        actions
          .bodyToPush(db, pending)
          .then((body) => actions.push(github, pending, now, model.notes, body))
          .then(propose),
      );
      return;
    }

    // 4. Pull once per session, plus again immediately while a large first
    //    import still has batches to go.
    if (model.lastSyncedAt === null || model.pullRemaining > 0) {
      model.syncing = true;
      model.lastSyncedAt = now();
      track(
        actions
          .pull(github, model.notes)
          .then(async (p) => {
            if (p.kind === "pulled") await actions.storeBlobs(db, p.notes);
            return p;
          })
          .then(propose),
      );
    }
  };

  function propose(p: Proposal): void {
    // Backoff is bookkeeping about the loop rather than about notes, so it lives
    // here instead of leaking a clock into present().
    // Typing is what the quiet period measures, so it is recorded where the
    // proposal arrives rather than inferred from the note afterwards.
    if (p.kind === "edited") touched.set(p.path, now());
    // Done-ness outlives the reload, so it is written on every toggle. A write
    // here rather than in present() for the same reason as the touched map:
    // present() has no clock and should not be given one.
    if (p.kind === "syncFailed") {
      if (p.error.kind === "rateLimited") {
        // GitHub said exactly when it will answer again. Doubling from one
        // second towards a sixty-second cap would just burn requests against a
        // window that might be an hour wide.
        model.retryDelay = p.error.retryAfterMs;
        model.retryAt = now() + p.error.retryAfterMs;
      } else {
        model.retryDelay = Math.min(
          model.retryDelay === 0 ? FIRST_BACKOFF_MS : model.retryDelay * 2,
          MAX_BACKOFF_MS,
        );
        model.retryAt = now() + model.retryDelay;
      }
    }
    const rejection = present(model, p);
    // Self-update downloads follow the attachImage shape: the proposal moves
    // the state, the work after it is tracked, and whatever comes back is
    // another proposal. The installer itself is fire-and-forget — cancelling
    // it means nothing happened, which the idle state already describes.
    // Update goes permission, then download, then installer — each step a
    // proposal, so whatever stops always names itself in the banner.
    if (p.kind === "updateStarted" && rejection === null) {
      track(beginUpdate());
    }
    if (p.kind === "updateOpenSettings" && rejection === null) {
      // No state change: the answer is the user coming back, which resumed
      // observes. A settings screen that fails to open is worth hearing about.
      track(
        openInstallSettings().catch((error: unknown) =>
          propose({ kind: "updateFailed", error: `Settings failed: ${String(error)}` }),
        ),
      );
    }
    if (p.kind === "updateDownloaded" && rejection === null) {
      track(
        installUpdate(p.path).catch((error: unknown) =>
          propose({ kind: "updateFailed", error: `Install failed: ${String(error)}` }),
        ),
      );
    }
    if (p.kind === "resumed" && model.update.status === "permission") {
      // Back from the settings screen: if the toggle was flipped, carry on
      // without making them tap Update again.
      track(beginUpdate());
    }
    // Done-ness outlives the reload, so it is written on every toggle — after
    // present(), which is what actually flips the set. A write here rather
    // than in present() for the same reason as the touched map: present() has
    // no clock and should not be given one.
    if (p.kind === "checkinToggled" && rejection === null && storage !== undefined)
      saveDone(storage, now(), model.checkinsDone);
    if (rejection !== null && import.meta.env.DEV) {
      // A rejection used to vanish. It is almost always a bug in the caller —
      // proposing against a note that is gone — and finding it by watching the
      // UI do nothing is how an afternoon disappears.
      console.warn(`[notes] rejected ${p.kind}: ${rejection.reason}`);
    }
    scheduleRender();
    nap();
  }

  // A test affordance. It settles the loop: an action's proposal can start
  // another action, so it drains until nothing is in flight.
  //
  // The production build gets a no-op, so a user never runs a forty-iteration
  // spin that can throw. Checking PROD rather than DEV matters: outside Vite —
  // under `bun test` — neither is defined, and the tests need the real thing.
  //
  // It must check every in-flight flag. Returning while a push or pull is still
  // running makes callers add their own wait afterwards, which is a flake
  // waiting for a slow day.
  const flush = async (): Promise<void> => {
    if (import.meta.env.PROD) return;
    for (let i = 0; i < 40; i += 1) {
      await idle;
      await new Promise<void>((r) => queueMicrotask(() => r()));
      if (!model.persisting && !model.syncing) return;
    }
    throw new Error("Loop did not settle");
  };

  // The caret at the top, because the shortcut exists to start writing — not to
  // resume wherever the last visit left off.
  const enterEditor = () => cm.focusAt(0);

  return { model, propose, flush, enterEditor };
};

export const boot = async (
  deps: Deps,
  root: HTMLElement,
  want: string | null = null,
): Promise<Loop> => {
  const loop = createLoop(deps, root);
  loop.propose(await actions.hydrate(deps.db));
  // A cold load on a link to a particular note. Hydrating has just picked a
  // note of its own; this is the one that was actually asked for.
  //
  // Only if it is here. On a device that has not synced yet the note genuinely
  // does not exist, and an error toast for following your own bookmark reads
  // as the app being broken rather than as the vault being empty.
  if (want !== null && loop.model.notes.has(want)) {
    loop.propose({ kind: "opened", path: want });
  }
  return loop;
};
