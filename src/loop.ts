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
import { createModel, present, type Model, type Proposal } from "./model.ts";
import * as actions from "./actions.ts";
import type { Github } from "./github.ts";
import { createPreviewCache, localImage, view } from "./view.ts";
import { createEditor, type EditorHandle } from "./editor.ts";
import { followLink } from "./links.ts";

export interface Deps {
  readonly db: IDBDatabase;
  readonly shrink: import("./attachments.ts").Shrinker;
  readonly github: Github | null;
  readonly now: () => number;
  // Injected so tests can drive the cooldown without waiting for real seconds.
  readonly schedule: (ms: number, fire: () => void) => void;
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

export const createLoop = (deps: Deps, root: HTMLElement): Loop => {
  const { db, github, now, schedule, shrink } = deps;
  const model = createModel();
  let wakeScheduled = false;

  let renderQueued = false;
  // A change of note, or of preview, replaces the editor's contents wholesale.
  // Anything else is a change dispatched into the state that is already there.
  let lastEditorKey: string | null = null;
  let lastModal: string | null = null;
  const previewCache = createPreviewCache();
  // Everything currently in flight, not merely the most recent thing started.
  // A push can begin while a persist is still running — the first block is
  // skipped rather than returned from — so assigning would drop the persist's
  // promise on the floor.
  let idle: Promise<void> = Promise.resolve();
  const track = (work: Promise<unknown>): void => {
    idle = Promise.all([idle, work]).then(() => undefined);
  };

  const capture = (text: string) => {
    for (const p of actions.captureProposals(model.notes, text, now)) propose(p);
  };

  // Where the caret is differs by surface; what to do with a pasted image does
  // not (never duplicate rules).
  const pasteImage = (event: ClipboardEvent, path: string, caret: number | null) => {
    const file = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .find((f): f is File => f !== null);
    if (!file) return; // a normal text paste; let the editor handle it

    event.preventDefault();
    const note = model.notes.get(path);
    if (!note) return;
    track(actions.attach(file, note, caret ?? note.body.length, now, shrink).then(propose));
  };

  // Created once, before the first paint, and outlives every one of them. lit is
  // handed an empty container and never touches what is inside it.
  const cm: EditorHandle = createEditor({
          resolveImage: (src) => localImage(model, src),
          onEdit: (body) => {
            if (model.openPath !== null) {
              propose({ kind: "edited", path: model.openPath, body });
            }
          },
          onPaste: (event, caret) => {
            if (model.openPath !== null) pasteImage(event, model.openPath, caret);
          },
          onWikilink: (target) => {
      const proposal = followLink(target, model.notes);
      if (proposal !== null) propose(proposal);
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
    return key;
  };

  const paint = () => {
    render(
      view(model, {
        propose,
        now,
        onCapture: capture,
        previewCache,
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

    const editorKey = `${model.mode}|${model.preview}|${model.openPath ?? ""}`;
    const body = model.openPath
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
    //    nowhere else.
    const pending = [...model.notes.values()].find((n) => n.pending && !n.dirty);
    if (pending) {
      model.syncing = true;
      track(actions.push(github, pending, now, model.notes).then(propose));
      return;
    }

    // 4. Pull once per session; phase 3 adds a trigger on window focus.
    if (model.lastSyncedAt === null) {
      model.syncing = true;
      model.lastSyncedAt = now();
      track(actions.pull(github, model.notes).then(propose));
    }
  };

  function propose(p: Proposal): void {
    // Backoff is bookkeeping about the loop rather than about notes, so it lives
    // here instead of leaking a clock into present().
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

export const boot = async (deps: Deps, root: HTMLElement): Promise<Loop> => {
  const loop = createLoop(deps, root);
  loop.propose(await actions.hydrate(deps.db));
  return loop;
};
