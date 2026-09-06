// Keyboard shortcuts, as a pure function from an event to a proposal.
//
// Kept out of the listener so the rules are testable without dispatching events,
// and so main.ts stays a wiring file.

import type { Model, Proposal } from "./model.ts";

// A single-letter shortcut must never fire while the user is writing, or typing
// "note" in a note jumps to the dump halfway through the word.
export const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.matches("input, textarea, select") || target.isContentEditable);

export const keyProposal = (
  event: KeyboardEvent,
  model: Model,
): Proposal | null => {
  // Leave the browser's own chords alone, and ignore held keys.
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return null;
  if (isTyping(event.target)) return null;

  switch (event.key.toLowerCase()) {
    case "n":
      return model.mode === "notes" ? null : { kind: "modeChanged", mode: "notes" };
    case "d":
      return model.mode === "dump" ? null : { kind: "modeChanged", mode: "dump" };
    case "e":
      // Only where there is something to preview.
      return model.mode === "notes" && model.openPath !== null
        ? { kind: "previewToggled" }
        : null;
    default:
      return null;
  }
};
