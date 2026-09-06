// The loop. Everything enters through propose() and leaves through nap().
//
//   proposal -> present() -> render() -> nap() -> action -> proposal -> ...
//
// present() is the only mutation point and it is synchronous, so two async
// results can never interleave halfway through a state change.

import { render } from "lit-html";
import { createModel, present, type Model, type Proposal } from "./model.ts";
import * as actions from "./actions.ts";
import type { Github } from "./github.ts";
import { view } from "./view.ts";

export interface Deps {
  readonly db: IDBDatabase;
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

export const createLoop = (deps: Deps, root: HTMLElement): Loop => {
  const { db, github, now, schedule } = deps;
  const model = createModel();
  let wakeScheduled = false;

  let renderQueued = false;
  let lastRenderedPath: string | null = null;
  // Resolves when nothing is in flight and nothing is left to do. Tests await
  // it instead of sleeping.
  let idle: Promise<void> = Promise.resolve();

  const capture = (text: string) => {
    for (const p of actions.captureProposals(model.notes, text, now)) propose(p);
  };

  const paint = () => {
    render(view(model, propose, now, capture), root);

    // The editor is uncontrolled: its value is set when the open note changes,
    // never on every render. Binding it to model state would fight the cursor,
    // and worst on a mobile keyboard.
    if (model.mode === "notes" && model.openPath !== lastRenderedPath) {
      lastRenderedPath = model.openPath;
      const editor = root.querySelector<HTMLTextAreaElement>("#editor");
      if (editor) editor.value = model.openPath
        ? (model.notes.get(model.openPath)?.body ?? "")
        : "";
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
      const dirty = [...model.notes.values()].filter((n) => n.dirty);
      if (dirty.length > 0) {
        model.persisting = true;
        idle = actions.persist(db, dirty).then(propose);
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
      idle = actions.push(github, pending, now).then(propose);
      return;
    }

    // 4. Pull once per session; phase 3 adds a trigger on window focus.
    if (model.lastSyncedAt === null) {
      model.syncing = true;
      model.lastSyncedAt = now();
      idle = actions.pull(github, model.notes).then(propose);
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
    present(model, p);
    scheduleRender();
    nap();
  }

  const flush = async (): Promise<void> => {
    // Settle the loop: an action's proposal can start another action, so keep
    // draining until nothing is in flight.
    for (let i = 0; i < 20; i += 1) {
      await idle;
      await new Promise<void>((r) => queueMicrotask(() => r()));
      if (!model.persisting) return;
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
