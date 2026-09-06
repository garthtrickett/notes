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
import { view } from "./view.ts";

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
}

const FIRST_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

// Replaces the text without throwing the caret away. Text inserted at or before
// the caret carries it along; a change after it leaves it where it was.
const syncEditorValue = (editor: HTMLTextAreaElement, body: string): void => {
  const previous = editor.value;
  const caret = editor.selectionStart ?? previous.length;

  let shared = 0;
  while (
    shared < previous.length &&
    shared < body.length &&
    previous[shared] === body[shared]
  ) {
    shared += 1;
  }

  // The trailing match matters as much as the leading one. A rename rewriting
  // [[old]] far above the caret changes length in the middle, and a prefix-only
  // test would drag the caret by that delta and look like a phantom jump.
  let tail = 0;
  while (
    tail < previous.length - shared &&
    tail < body.length - shared &&
    previous[previous.length - 1 - tail] === body[body.length - 1 - tail]
  ) {
    tail += 1;
  }

  const changeEnds = previous.length - tail;
  // `caret < shared`, not `<=`: text inserted *at* the caret should carry it
  // along, which is what makes typing continue after a pasted image reference
  // rather than in front of it.
  const moved =
    caret < shared
      ? caret // the change is entirely after the caret
      : caret >= changeEnds
        ? caret + (body.length - previous.length) // entirely before it
        : shared; // the caret sat inside what changed
  const next = Math.max(0, Math.min(moved, body.length));

  editor.value = body;
  if (document.activeElement === editor) editor.setSelectionRange(next, next);
};

export const createLoop = (deps: Deps, root: HTMLElement): Loop => {
  const { db, github, now, schedule, shrink } = deps;
  const model = createModel();
  let wakeScheduled = false;

  let renderQueued = false;
  // The editor is uncontrolled, so its value is pushed in only when the element
  // it lives in has been replaced. That happens on more than an open-note change:
  // toggling preview destroys and recreates the textarea, and without this it
  // would come back empty.
  let lastEditorKey: string | null = null;
  let wasCapturing = false;
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

  const onPaste = (event: ClipboardEvent, path: string) => {
    const file = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .find((f): f is File => f !== null);
    if (!file) return; // a normal text paste; let the textarea handle it

    event.preventDefault();
    const note = model.notes.get(path);
    if (!note) return;
    const cursor = (event.target as HTMLTextAreaElement).selectionStart ?? note.body.length;
    track(actions.attach(file, note, cursor, now, shrink).then(propose));
  };

  const paint = () => {
    render(view(model, propose, now, capture, onPaste), root);

    // The editor is uncontrolled: its value is set when the open note changes,
    // never on every render. Binding it to model state would fight the cursor,
    // and worst on a mobile keyboard.
    // Focus quick capture as it opens, and only then — refocusing on every paint
    // would fight the caret while typing.
    if (model.capturing !== wasCapturing) {
      wasCapturing = model.capturing;
      if (model.capturing) {
        root.querySelector<HTMLInputElement>("#quick-capture")?.focus();
      }
    }

    const editorKey = `${model.mode}|${model.preview}|${model.openPath ?? ""}`;
    const editor = root.querySelector<HTMLTextAreaElement>("#editor");
    const body = model.openPath
      ? (model.notes.get(model.openPath)?.body ?? "")
      : "";

    if (editor) {
      // Two reasons to push a value in. The element was replaced — a different
      // note, or preview toggled — or the model changed the body underneath a
      // live textarea, which is what pasting an image, pulling a remote edit and
      // rewriting links on rename all do.
      //
      // Typing is unaffected: present() stores exactly what the DOM had, so by
      // the time this runs the two already agree and nothing is written.
      if (editorKey !== lastEditorKey) {
        lastEditorKey = editorKey;
        editor.value = body;
      } else if (editor.value !== body) {
        syncEditorValue(editor, body);
      }
    } else {
      lastEditorKey = editorKey;
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
      model.retryDelay = Math.min(
        model.retryDelay === 0 ? FIRST_BACKOFF_MS : model.retryDelay * 2,
        MAX_BACKOFF_MS,
      );
      model.retryAt = now() + model.retryDelay;
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
  // It must check every in-flight flag. Checking only `persisting` meant it
  // returned while a push or pull was still running, which is why callers were
  // adding their own microtask hop afterwards — a flake waiting for a slow day.
  const flush = async (): Promise<void> => {
    if (import.meta.env.PROD) return;
    for (let i = 0; i < 40; i += 1) {
      await idle;
      await new Promise<void>((r) => queueMicrotask(() => r()));
      if (!model.persisting && !model.syncing) return;
    }
    throw new Error("Loop did not settle");
  };

  return { model, propose, flush };
};

export const boot = async (deps: Deps, root: HTMLElement): Promise<Loop> => {
  const loop = createLoop(deps, root);
  loop.propose(await actions.hydrate(deps.db));
  return loop;
};
