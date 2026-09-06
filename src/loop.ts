// The loop. Everything enters through propose() and leaves through nap().
//
//   proposal -> present() -> render() -> nap() -> action -> proposal -> ...
//
// present() is the only mutation point and it is synchronous, so two async
// results can never interleave halfway through a state change.

import { render } from "lit-html";
import { createModel, present, type Model, type Proposal } from "./model.ts";
import * as actions from "./actions.ts";
import { view } from "./view.ts";

export interface Loop {
  readonly model: Model;
  readonly propose: (p: Proposal) => void;
  readonly flush: () => Promise<void>;
}

export const createLoop = (db: IDBDatabase, root: HTMLElement): Loop => {
  const model = createModel();

  let renderQueued = false;
  let lastRenderedPath: string | null = null;
  // Resolves when nothing is in flight and nothing is left to do. Tests await
  // it instead of sleeping.
  let idle: Promise<void> = Promise.resolve();

  const paint = () => {
    render(view(model, propose), root);

    // The editor is uncontrolled: its value is set when the open note changes,
    // never on every render. Binding it to model state would fight the cursor,
    // and worst on a mobile keyboard.
    if (model.openPath !== lastRenderedPath) {
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

  // Every automatic behaviour lives here, and it is a function of model state
  // rather than a scheduler. Phase 1 has one rule.
  const nap = () => {
    if (model.persisting || model.persistBlocked) return;
    const dirty = [...model.notes.values()].filter((n) => n.dirty);
    if (dirty.length === 0) return;

    model.persisting = true;
    idle = actions.persist(db, dirty).then(propose);
  };

  function propose(p: Proposal): void {
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

export const boot = async (db: IDBDatabase, root: HTMLElement): Promise<Loop> => {
  const loop = createLoop(db, root);
  loop.propose(await actions.hydrate(db));
  return loop;
};
