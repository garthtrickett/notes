import { describe, expect, it } from "bun:test";
import { isTyping, keyProposal } from "./keys.ts";
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
    expect(keyProposal(press("n"), m)).toEqual({ kind: "modeChanged", mode: "notes" });
  });

  it("D goes to the dump", () => {
    expect(keyProposal(press("d"), model())).toEqual({
      kind: "modeChanged",
      mode: "dump",
    });
  });

  it("E toggles preview", () => {
    expect(keyProposal(press("e"), model())).toEqual({ kind: "previewToggled" });
  });

  it("accepts uppercase, so caps lock is not a trap", () => {
    expect(keyProposal(press("N"), model({ mode: "dump" }))).not.toBeNull();
  });

  it("does nothing when already in that mode", () => {
    expect(keyProposal(press("n"), model({ mode: "notes" }))).toBeNull();
  });

  it("does not toggle preview from the dump", () => {
    expect(keyProposal(press("e"), model({ mode: "dump" }))).toBeNull();
  });

  it("does not toggle preview with no note open", () => {
    expect(keyProposal(press("e"), model({ openPath: null }))).toBeNull();
  });

  it("ignores other keys", () => {
    expect(keyProposal(press("x"), model())).toBeNull();
  });
});

describe("shortcuts stay out of the way", () => {
  it("does nothing while typing in a textarea", () => {
    const editor = document.createElement("textarea");
    // Otherwise typing "note" inside a note jumps to the dump halfway through.
    expect(keyProposal(at(press("d"), editor), model())).toBeNull();
  });

  it("does nothing while typing in an input", () => {
    const search = document.createElement("input");
    expect(keyProposal(at(press("n"), search), model({ mode: "dump" }))).toBeNull();
  });

  it("leaves the browser's own chords alone", () => {
    const m = model({ mode: "dump" });
    expect(keyProposal(press("n", { metaKey: true }), m)).toBeNull();
    expect(keyProposal(press("n", { ctrlKey: true }), m)).toBeNull();
    expect(keyProposal(press("n", { altKey: true }), m)).toBeNull();
  });

  it("ignores a held key", () => {
    expect(keyProposal(press("d", { repeat: true }), model())).toBeNull();
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
