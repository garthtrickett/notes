// Every keyboard rule, in one place, as a pure function from an event to an
// intent. Kept out of the listener so the rules are testable without dispatching
// anything, and so main.ts stays a wiring file.

import type { Model, Proposal } from "./model.ts";

export type KeyAction =
  | { readonly kind: "propose"; readonly proposal: Proposal }
  | { readonly kind: "focus"; readonly selector: string }
  // Back into the editor with the caret at the top. Not a selector, because
  // placing a caret in CodeMirror takes a dispatch.
  | { readonly kind: "enterEditor" }
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
    if (model.modal !== null) return propose({ kind: "modalClosed" });
    if (isTyping(event.target)) return { kind: "blur" };
    // Escape unwinds one thing at a time, and the scoped numbers are the last
    // of them — one folder per press, rather than all the way out at once.
    if (model.numberScope !== null) return propose({ kind: "steppedOut" });
    return null;
  }

  // A dialog is asking a question, so nothing else gets to happen. `isTyping`
  // is not enough on its own: the confirm dialog focuses a *button*, so `d`
  // moved the app to the dump behind an open "Delete alpha.md?" and Space
  // swapped the pending question for a different dialog.
  if (model.modal !== null) return null;

  if (isTyping(event.target)) return null;

  // Digits jump to a top-level row, numbered from zero to match the badges in
  // the tree. Which row that is belongs to the model, which has the tree.
  if (event.key.length === 1 && event.key >= "0" && event.key <= "9") {
    return propose({ kind: "jumped", index: Number(event.key) });
  }

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
        : propose({ kind: "modalOpened", modal: { kind: "capture" } });
    case " ":
      // Space costs the browser's scroll-down. Accepted, because a new note is
      // then reachable from anywhere — including the dump, which has no button
      // for it.
      return propose({ kind: "modalOpened", modal: { kind: "newNote" } });
    case "v":
      return model.mode === "archive"
        ? null
        : propose({ kind: "modeChanged", mode: "archive" });
    case "t":
      return model.mode === "trash"
        ? null
        : propose({ kind: "modeChanged", mode: "trash" });
    case "h":
      // History is about a note, so it needs one open and something to show.
      return model.mode === "notes" && model.openPath !== null
        ? propose({ kind: "historyOpened", path: model.openPath })
        : null;
    case "i":
      // Escape leaves the editor so these shortcuts work at all; `i` is the way
      // back in, without reaching for the mouse.
      return model.mode === "notes" && model.openPath !== null && !model.preview
        ? { kind: "enterEditor" }
        : null;
    case "o":
      return propose({ kind: "modalOpened", modal: { kind: "open" } });
    default:
      return null;
  }
};
