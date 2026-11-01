import { beforeEach, describe, expect, it } from "bun:test";
import { render } from "lit-html";
import { createModel, present, type Model, type Note, type Proposal } from "./model.ts";
import { newNoteForm } from "./view-new-note.ts";
import { dumpPathOf } from "./dump.ts";

let model: Model;
let root: HTMLElement;
const note = (path: string, extra: Partial<Note> = {}): Note => ({
  path, body: "", baseSha: "base", dirty: false, pending: false, deleted: false, encoding: "utf8", ...extra,
});
const paint = () => render(newNoteForm(model, propose), root);
const propose = (p: Proposal) => { present(model, p); paint(); };
const input = () => root.querySelector<HTMLInputElement>("input")!;
const type = (path: string) => {
  input().value = path;
  input().setSelectionRange(path.length, path.length);
  input().dispatchEvent(new Event("input", { bubbles: true }));
};
const press = (key: string, extra: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
  input().dispatchEvent(e);
  return e;
};
const options = () => [...root.querySelectorAll<HTMLButtonElement>('[role="option"]')];
const submit = () => root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

beforeEach(() => {
  model = createModel();
  present(model, { kind: "hydrated", notes: [note("surfing/spots/indo/a.md"), note("surfing/gear/a.md"), note("reading/a.md")] });
  present(model, { kind: "modalOpened", modal: { kind: "newNote" } });
  document.body.innerHTML = '<div id="test-root"></div>';
  root = document.getElementById("test-root")!;
  paint();
  input().focus();
});

describe("new-note folder suggestions", () => {
  it("completes the highlighted folder with Tab and continues one level at a time", () => {
    type("sur");
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(input().value).toBe("surfing/");
    expect(options().map(b => b.textContent)).toEqual(["surfing/gear/", "surfing/spots/"]);
    press("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe("note-folder-1");
    press("Tab");
    expect(input().value).toBe("surfing/spots/");
    press("Tab");
    expect(input().value).toBe("surfing/spots/indo/");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("bounds arrow selection and resets it when the path changes", () => {
    type("surfing/");
    press("ArrowUp");
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
    press("ArrowDown"); press("ArrowDown");
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
    type("surfing/g");
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("tap fills the folder and returns focus to the input without creating a note", async () => {
    type("surfing/");
    const before = model.notes.size;
    options()[1]!.click();
    await Promise.resolve();
    expect(input().value).toBe("surfing/spots/");
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(input().value.length);
    expect(model.notes.size).toBe(before);
    expect(model.modal?.kind).toBe("newNote");
  });

  it("does not trap Tab without a match or Shift+Tab with a match", () => {
    type("brand-new/note");
    expect(press("Tab").defaultPrevented).toBe(false);
    type("sur");
    expect(press("Tab", { shiftKey: true }).defaultPrevented).toBe(false);
  });

  it("does not overwrite a name while editing in the middle or composing text", () => {
    type("surfing/sp");
    input().setSelectionRange(2, 2);
    expect(press("Tab").defaultPrevented).toBe(false);
    expect(input().value).toBe("surfing/sp");
    input().setSelectionRange(10, 10);
    expect(press("ArrowDown", { isComposing: true }).defaultPrevented).toBe(false);
  });

  it("requires a note name after an accepted folder", () => {
    type("surfing/");
    submit();
    expect(model.notes.has("surfing.md")).toBe(false);
    expect(model.modal?.kind).toBe("newNote");
    expect(input().validationMessage).toBe("Add a note name after the folder.");
    type("surfing/new-spot");
    expect(input().validationMessage).toBe("");
    submit();
    expect(model.notes.has("surfing/new-spot.md")).toBe(true);
    expect(model.openPath).toBe("surfing/new-spot.md");
    expect(model.modal).toBeNull();
  });

  it("allows a completely new nested path and keeps ordinary creation validation", () => {
    type("new-folder/deeper/new-note"); submit();
    expect(model.notes.has("new-folder/deeper/new-note.md")).toBe(true);
    present(model, { kind: "modalOpened", modal: { kind: "newNote" } }); paint();
    type("new-folder/deeper/new-note"); submit();
    expect(model.error).toContain("already exists");
  });

  it("does not suggest deleted, archived, Dump or attachment-only folders", () => {
    for (const n of [note("old/a.md", { deleted: true }), note(".archive/filed/a.md"), note(".trash/trash/a.md"), note("pictures/photo.png", { encoding: "base64" }), note(dumpPathOf(Date.now()))]) model.notes.set(n.path, n);
    paint();
    expect(options().map(b => b.textContent)).toEqual(["reading/", "surfing/"]);
  });

  it("preserves the draft and caret through unrelated model paints", () => {
    type("surfing/sp");
    input().setSelectionRange(3, 3);
    const original = input();
    propose({ kind: "woke" });
    expect(input()).toBe(original);
    expect(input().value).toBe("surfing/sp");
    expect(input().selectionStart).toBe(3);
  });

  it("advertises a single active option and keeps suggestions out of the Tab order", () => {
    expect(input().getAttribute("role")).toBe("combobox");
    expect(input().getAttribute("aria-controls")).toBe("note-folders");
    expect(options().filter(b => b.getAttribute("aria-selected") === "true").length).toBe(1);
    expect(options().every(b => b.tabIndex === -1)).toBe(true);
  });

  it("ignores a late folder choice after closing or after its prefix changed", () => {
    type("reading/");
    expect(present(model, { kind: "noteFolderCompleted", path: "surfing/" })).not.toBeNull();
    expect(input().value).toBe("reading/");
    propose({ kind: "modalClosed" });
    expect(present(model, { kind: "noteFolderMoved", delta: 1 })).not.toBeNull();
    expect(present(model, { kind: "notePathChanged", path: "a" })).not.toBeNull();
    expect(model.modal).toBeNull();
  });
});
