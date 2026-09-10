import { describe, expect, it } from "bun:test";
import { isTyping, keyAction } from "./keys.ts";
import { createModel, present, type Model } from "./model.ts";

const model = (over: Partial<Model> = {}): Model => {
  const m = createModel();
  present(m, {
    kind: "hydrated",
    notes: [
      {
        path: "a.md",
        body: "",
        baseSha: "s",
        pending: false,
        deleted: false,
        dirty: false,
        encoding: "utf8",
      },
    ],
  });
  return Object.assign(m, over);
};

const press = (key: string, init: KeyboardEventInit = {}): KeyboardEvent =>
  new KeyboardEvent("keydown", { key, ...init });

const at = (event: KeyboardEvent, target: EventTarget): KeyboardEvent => {
  Object.defineProperty(event, "target", { value: target });
  return event;
};

describe("shortcuts", () => {
  it("N goes to notes", () => {
    const m = model({ mode: "dump" });
    expect(keyAction(press("n"), m)).toEqual({ kind: "propose", proposal: { kind: "modeChanged", mode: "notes" } });
  });

  it("D goes to the dump", () => {
    expect(keyAction(press("d"), model())).toEqual({ kind: "propose", proposal: {
      kind: "modeChanged",
      mode: "dump",
    } });
  });

  it("K goes to tasks", () => {
    expect(keyAction(press("k"), model())).toEqual({ kind: "propose", proposal: {
      kind: "modeChanged",
      mode: "tasks",
    } });
  });

  it("E toggles preview", () => {
    expect(keyAction(press("e"), model())).toEqual({ kind: "propose", proposal: { kind: "previewToggled" } });
  });

  it("accepts uppercase, so caps lock is not a trap", () => {
    expect(keyAction(press("N"), model({ mode: "dump" }))).not.toBeNull();
  });

  it("does nothing when already in that mode", () => {
    expect(keyAction(press("n"), model({ mode: "notes" }))).toBeNull();
  });

  it("does not toggle preview from the dump", () => {
    expect(keyAction(press("e"), model({ mode: "dump" }))).toBeNull();
  });

  it("does not toggle preview with no note open", () => {
    expect(keyAction(press("e"), model({ openPath: null }))).toBeNull();
  });

  it("ignores other keys", () => {
    expect(keyAction(press("x"), model())).toBeNull();
  });
});

describe("shortcuts stay out of the way", () => {
  it("does nothing while typing in a textarea", () => {
    const editor = document.createElement("textarea");
    // Otherwise typing "note" inside a note jumps to the dump halfway through.
    expect(keyAction(at(press("d"), editor), model())).toBeNull();
  });

  it("does nothing while typing in an input", () => {
    const search = document.createElement("input");
    expect(keyAction(at(press("n"), search), model({ mode: "dump" }))).toBeNull();
  });

  it("leaves the browser's own chords alone", () => {
    const m = model({ mode: "dump" });
    expect(keyAction(press("n", { metaKey: true }), m)).toBeNull();
    expect(keyAction(press("n", { ctrlKey: true }), m)).toBeNull();
    expect(keyAction(press("n", { altKey: true }), m)).toBeNull();
  });

  it("ignores a held key", () => {
    expect(keyAction(press("d", { repeat: true }), model())).toBeNull();
  });
});

describe("isTyping", () => {
  it("recognises the fields a shortcut must not interrupt", () => {
    expect(isTyping(document.createElement("textarea"))).toBe(true);
    expect(isTyping(document.createElement("input"))).toBe(true);
    expect(isTyping(document.createElement("select"))).toBe(true);
    expect(isTyping(document.createElement("div"))).toBe(false);
    expect(isTyping(null)).toBe(false);
  });

  it("recognises a contenteditable", () => {
    const el = document.createElement("div");
    el.contentEditable = "true";
    expect(isTyping(el)).toBe(true);
  });
});

describe("quick capture", () => {
  it("A focuses the box when the dump is already on screen", () => {
    // A modal over a visible input would be theatre.
    expect(keyAction(press("a"), model({ mode: "dump" }))).toEqual({
      kind: "focus",
      selector: "#capture",
    });
  });

  it("A floats the box everywhere else", () => {
    expect(keyAction(press("a"), model())).toEqual({
      kind: "propose",
      proposal: { kind: "modalOpened", modal: { kind: "capture" } },
    });
  });

  it("A does nothing while typing", () => {
    const editor = document.createElement("textarea");
    expect(keyAction(at(press("a"), editor), model())).toBeNull();
  });

  it("Escape dismisses capture, even from inside its own field", () => {
    const box = document.createElement("input");
    // Blurring instead would look like Escape did nothing.
    expect(keyAction(at(press("Escape"), box), model({ modal: { kind: "capture" } }))).toEqual({
      kind: "propose",
      proposal: { kind: "modalClosed" },
    });
  });

  it("Escape still leaves a field when capture is closed", () => {
    const editor = document.createElement("textarea");
    expect(keyAction(at(press("Escape"), editor), model())).toEqual({
      kind: "blur",
    });
  });

  it("Escape does nothing with no field focused and nothing open", () => {
    expect(keyAction(press("Escape"), model())).toBeNull();
  });
})

describe("new note and open", () => {
  it("Space opens the new-note box from anywhere", () => {
    expect(keyAction(press(" "), model({ mode: "dump" }))).toEqual({
      kind: "propose",
      proposal: { kind: "modalOpened", modal: { kind: "newNote" } },
    });
  });

  it("O opens the palette", () => {
    expect(keyAction(press("o"), model())).toEqual({
      kind: "propose",
      proposal: { kind: "modalOpened", modal: { kind: "open" } },
    });
  });

  it("neither fires while typing, so a space stays a space", () => {
    const editor = document.createElement("textarea");
    expect(keyAction(at(press(" "), editor), model())).toBeNull();
    expect(keyAction(at(press("o"), editor), model())).toBeNull();
  });

  it("N still goes to notes", () => {
    expect(keyAction(press("n"), model({ mode: "dump" }))).toEqual({
      kind: "propose",
      proposal: { kind: "modeChanged", mode: "notes" },
    });
  });

  it("Escape closes whichever modal is open", () => {
    for (const kind of ["capture", "newNote", "open"] as const) {
      expect(keyAction(press("Escape"), model({ modal: { kind } }))).toEqual({
        kind: "propose",
        proposal: { kind: "modalClosed" },
      });
    }
  });
});

describe("number shortcuts", () => {
  it("proposes a jump for every digit, zero first", () => {
    const m = model();
    for (const digit of "0123456789") {
      expect(keyAction(press(digit), m)).toEqual({
        kind: "propose",
        proposal: { kind: "jumped", index: Number(digit) },
      });
    }
  });

  it("stands down while a field has focus", () => {
    const search = document.createElement("input");
    expect(keyAction(at(press("3"), search), model())).toBeNull();
  });
});

describe("i to start writing", () => {
  it("goes back into the editor when a note is open", () => {
    expect(keyAction(press("i"), model({ openPath: "a.md" }))).toEqual({
      kind: "enterEditor",
    });
  });

  it("does nothing in preview, where there is no editor to enter", () => {
    expect(keyAction(press("i"), model({ openPath: "a.md", preview: true }))).toBeNull();
  });

  it("does nothing in the dump", () => {
    expect(keyAction(press("i"), model({ mode: "dump", openPath: "a.md" }))).toBeNull();
  });

  it("does nothing with no note open", () => {
    expect(keyAction(press("i"), model({ openPath: null }))).toBeNull();
  });

  it("stands down while a field has focus", () => {
    const search = document.createElement("input");
    expect(keyAction(at(press("i"), search), model({ openPath: "a.md" }))).toBeNull();
  });
});

describe("a dialog is modal", () => {
  // isTyping is not enough: the confirm dialog focuses a button, so every
  // shortcut used to sail past it. `d` moved the app to the dump behind an open
  // "Delete alpha.md?", and Space swapped the pending question for a different
  // dialog.
  const asking = () =>
    model({ modal: { kind: "confirmDelete", path: "a.md", folder: false } });

  for (const key of ["d", "n", "e", "a", "i", "o", " ", "3"]) {
    it(`ignores ${JSON.stringify(key)} while a dialog is open`, () => {
      expect(keyAction(press(key), asking())).toBeNull();
    });
  }

  it("still lets Escape dismiss it", () => {
    expect(keyAction(press("Escape"), asking())).toEqual({
      kind: "propose",
      proposal: { kind: "modalClosed" },
    });
  });
});

describe("shortcuts for the other views", () => {
  it("v opens the archive", () => {
    expect(keyAction(press("v"), model())).toEqual({
      kind: "propose",
      proposal: { kind: "modeChanged", mode: "archive" },
    });
  });

  it("t opens the bin", () => {
    expect(keyAction(press("t"), model())).toEqual({
      kind: "propose",
      proposal: { kind: "modeChanged", mode: "trash" },
    });
  });

  it("does nothing when already there", () => {
    expect(keyAction(press("v"), model({ mode: "archive" }))).toBeNull();
    expect(keyAction(press("t"), model({ mode: "trash" }))).toBeNull();
  });

  it("h opens the history of the note in front of you", () => {
    expect(keyAction(press("h"), model({ openPath: "a.md" }))).toEqual({
      kind: "propose",
      proposal: { kind: "historyOpened", path: "a.md" },
    });
  });

  it("h does nothing where there is no note to have a history", () => {
    expect(keyAction(press("h"), model({ openPath: null }))).toBeNull();
    expect(keyAction(press("h"), model({ mode: "dump", openPath: "a.md" }))).toBeNull();
  });
})
