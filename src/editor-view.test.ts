// The parts of the editor that only exist once there is a real view: what the
// caret is allowed to walk through, and which direction it moves when the model
// writes underneath it. Both were bugs before they were tests.

import { describe, expect, test } from "bun:test";
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { createEditor, type EditorHandle } from "./editor.ts";

const openEditor = (
  body: string,
  resolveImage = (src: string) => `data:image/png;base64,${src}`,
  hooks: Partial<{ onEdit: (body: string) => void }> = {},
): { handle: EditorHandle; view: EditorView } => {
  const handle = createEditor({
    resolveImage,
    onEdit: hooks.onEdit ?? (() => {}),
    onPaste: () => {},
    onWikilink: () => {},
  });
  document.body.appendChild(handle.dom);
  handle.reset(body);
  const view = EditorView.findFromDOM(handle.dom);
  if (view === null) throw new Error("no view");
  return { handle, view };
};

const atomicRanges = (view: EditorView): Array<[number, number]> => {
  const found: Array<[number, number]> = [];
  for (const provide of view.state.facet(EditorView.atomicRanges)) {
    provide(view).between(0, view.state.doc.length, (from, to) => {
      found.push([from, to]);
    });
  }
  return found;
};

describe("a replaced image is one thing to the caret", () => {
  test("its whole range is atomic", () => {
    const { handle, view } = openEditor("top\n![](a.png)\nend");
    // Without this the caret walks through the hidden `![](a.png)` a character
    // at a time, so a selection that looks like it stops above the picture
    // reaches into it and deleting leaves broken markdown behind.
    expect(atomicRanges(view)).toEqual([[4, 14]]);
    handle.destroy();
  });

  test("an image that cannot be resolved is not atomic — it is just text", () => {
    const { handle, view } = openEditor("top\n![](gone.png)\nend", () => null);
    expect(atomicRanges(view)).toEqual([]);
    handle.destroy();
  });

  test("moving left from after the picture clears it in one step", () => {
    const { handle, view } = openEditor("top\n![](a.png)\nend");
    view.dispatch({ selection: EditorSelection.cursor(14) });
    view.dispatch(view.state.replaceSelection("")); // no-op, keeps the selection
    const moved = view.moveByChar(view.state.selection.main, false);
    expect(moved.head).toBeLessThanOrEqual(4);
    handle.destroy();
  });
});

describe("the model writing underneath the caret", () => {
  test("carries the caret past text inserted at it", () => {
    const { handle, view } = openEditor("before ");
    view.dispatch({ selection: EditorSelection.cursor(7) });
    // What pasting an image does: the model inserts at the caret and the paint
    // pushes the new body in. Typing must continue after the picture.
    handle.setDoc("before ![](a.png)");
    expect(view.state.selection.main.head).toBe(17);
    handle.destroy();
  });

  test("leaves the caret alone when the change is after it", () => {
    const { handle, view } = openEditor("head tail");
    view.dispatch({ selection: EditorSelection.cursor(4) });
    handle.setDoc("head tail more");
    expect(view.state.selection.main.head).toBe(4);
    handle.destroy();
  });

  test("shifts the caret by the delta when the change is before it", () => {
    const { handle, view } = openEditor("a [[old]] b");
    view.dispatch({ selection: EditorSelection.cursor(11) });
    handle.setDoc("a [[a longer name]] b");
    expect(view.state.selection.main.head).toBe(21);
    handle.destroy();
  });

  test("is not reported back as an edit", () => {
    const edits: string[] = [];
    const { handle } = openEditor("start", undefined, { onEdit: (b) => edits.push(b) });
    handle.setDoc("start changed");
    expect(edits).toEqual([]);
    handle.destroy();
  });

  test("but a real edit is", () => {
    const edits: string[] = [];
    const { handle, view } = openEditor("start", undefined, { onEdit: (b) => edits.push(b) });
    view.dispatch({ changes: { from: 5, insert: "!" } });
    expect(edits).toEqual(["start!"]);
    handle.destroy();
  });
});
