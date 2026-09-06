// Every keyboard rule, in one place, as a pure function from an event to an
// intent. Kept out of the listener so the rules are testable without dispatching
// anything, and so main.ts stays a wiring file.

import type { Model, Proposal } from "./model.ts";

export type KeyAction =
  | { readonly kind: "propose"; readonly proposal: Proposal }
  | { readonly kind: "focus"; readonly selector: string }
  | { readonly kind: "blur" };

// A single-letter shortcut must never fire while the user is writing, or typing
// "note" in a note jumps to the dump halfway through the word.
export const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.matches("input, textarea, select") || target.isContentEditable);

const propose = (proposal: Proposal): KeyAction => ({ kind: "propose", proposal });

export const keyAction = (
  event: KeyboardEvent,
  model: Model,
): KeyAction | null => {
  // Leave the browser's own chords alone, and ignore held keys.
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return null;

  if (event.key === "Escape") {
    // Dismissing quick capture beats blurring its own field — otherwise Escape
    // in the box you just opened does nothing visible.
    if (model.capturing) return propose({ kind: "captureClosed" });
    if (isTyping(event.target)) return { kind: "blur" };
    return null;
  }

  if (isTyping(event.target)) return null;

  switch (event.key.toLowerCase()) {
    case "n":
      return model.mode === "notes"
        ? null
        : propose({ kind: "modeChanged", mode: "notes" });
    case "d":
      return model.mode === "dump"
        ? null
        : propose({ kind: "modeChanged", mode: "dump" });
    case "e":
      // Only where there is something to preview.
      return model.mode === "notes" && model.openPath !== null
        ? propose({ kind: "previewToggled" })
        : null;
    case "a":
      // In the dump the box is already on screen, so a modal over the top of it
      // would be theatre. Everywhere else, floating it is the whole point.
      return model.mode === "dump"
        ? { kind: "focus", selector: "#capture" }
        : propose({ kind: "captureOpened" });
    default:
      return null;
  }
};
