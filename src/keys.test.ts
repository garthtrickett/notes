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
      proposal: { kind: "captureOpened" },
    });
  });

  it("A does nothing while typing", () => {
    const editor = document.createElement("textarea");
    expect(keyAction(at(press("a"), editor), model())).toBeNull();
  });

  it("Escape dismisses capture, even from inside its own field", () => {
    const box = document.createElement("input");
    // Blurring instead would look like Escape did nothing.
    expect(keyAction(at(press("Escape"), box), model({ capturing: true }))).toEqual({
      kind: "propose",
      proposal: { kind: "captureClosed" },
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
