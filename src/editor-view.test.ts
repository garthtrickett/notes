// The parts of the editor that only exist once there is a real view: what the
// caret is allowed to walk through, and which direction it moves when the model
// writes underneath it. Both were bugs before they were tests.

import { describe, expect, test } from "bun:test";
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { createEditor, type EditorHandle } from "./editor.ts";
import type { ResolveImage } from "./decorate.ts";

const openEditor = (
  body: string,
  resolveImage: ResolveImage = (src) => `data:image/png;base64,${src}`,
  hooks: Partial<{ onEdit: (body: string) => void }> = {},
): { handle: EditorHandle; view: EditorView } => {
  const handle = createEditor({
    resolveImage,
    resolveWikilink: () => "found",
    onEdit: hooks.onEdit ?? (() => {}),
    onPaste: () => {},
    onDropFiles: () => false,
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

describe("dragging a picture", () => {
  const dragstartOn = (img: Element, dt: DataTransfer): void => {
    const event = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dt });
    img.dispatchEvent(event);
  };

  test("is draggable, which is what makes the editor claim the drag", () => {
    const { handle } = openEditor("![](a.png)\nafter");
    const img = handle.dom.querySelector("img.cm-md-image") as HTMLImageElement | null;
    if (img === null) throw new Error("no image");
    // CodeMirror only treats a widget as the thing being dragged when its DOM
    // is draggable. Without it the browser drags the picture instead.
    expect(img.draggable).toBe(true);
    handle.destroy();
  });

  test("carries the markdown, not the picture's src", () => {
    const { handle } = openEditor("![](a.png)\nafter");
    const img = handle.dom.querySelector("img.cm-md-image");
    if (img === null) throw new Error("no image");
    const dt = new DataTransfer();
    // What the browser sends when it drags the picture itself: the src, which
    // for a local attachment is the entire base64 data URL.
    dt.setData("Text", "data:image/webp;base64,AAAA");
    dragstartOn(img, dt);
    // Rewritten to the range the picture stands for. This also proves the
    // widget did not swallow the event — if it had, nothing would have changed.
    expect(dt.getData("Text")).toBe("![](a.png)");
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

describe("undo and redo", () => {
  test("undo inverts the last user edit and reports it like a keystroke", () => {
    const edits: string[] = [];
    const { handle, view } = openEditor("hello", undefined, { onEdit: (b) => edits.push(b) });
    view.dispatch({ changes: { from: 5, insert: " world" } });
    expect(edits).toEqual(["hello world"]);
    expect(handle.canUndo()).toBe(true);
    expect(handle.canRedo()).toBe(false);
    expect(handle.undo()).toBe(true);
    expect(handle.doc()).toBe("hello");
    expect(edits).toEqual(["hello world", "hello"]);
    expect(handle.canUndo()).toBe(false);
    expect(handle.canRedo()).toBe(true);
    handle.destroy();
  });

  test("redo re-applies what undo took away", () => {
    const { handle, view } = openEditor("hello");
    view.dispatch({ changes: { from: 5, insert: " world" } });
    handle.undo();
    expect(handle.redo()).toBe(true);
    expect(handle.doc()).toBe("hello world");
    expect(handle.canRedo()).toBe(false);
    handle.destroy();
  });

  test("undo past the first edit is a no-op, not an error", () => {
    const { handle } = openEditor("hello");
    expect(handle.canUndo()).toBe(false);
    expect(handle.undo()).toBe(false);
    expect(handle.doc()).toBe("hello");
    handle.destroy();
  });

  test("a fresh state starts a fresh history, so undo stops at the note boundary", () => {
    const { handle, view } = openEditor("one");
    view.dispatch({ changes: { from: 3, insert: "!" } });
    expect(handle.canUndo()).toBe(true);
    handle.reset("two");
    expect(handle.doc()).toBe("two");
    expect(handle.canUndo()).toBe(false);
    expect(handle.canRedo()).toBe(false);
    handle.destroy();
  });
});

describe("entering the editor", () => {
  test("puts the caret at the top and takes focus", () => {
    const { handle, view } = openEditor("first line\nsecond line");
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    handle.focusAt(0);
    expect(view.state.selection.main.head).toBe(0);
    handle.destroy();
  });

  test("clamps a position past the end rather than throwing", () => {
    const { handle, view } = openEditor("short");
    handle.focusAt(9999);
    expect(view.state.selection.main.head).toBe(5);
    handle.destroy();
  });
});

describe("list indent reaches the DOM", () => {
  test("the line carries the class and its own hanging width", () => {
    // The span builder is unit-tested; what this catches is the adapter
    // dropping either half. A class with no `--md-indent` hangs by zero and
    // looks exactly like the bug it fixes.
    const { view } = openEditor("- outer\n  - inner\n\nplain");
    const lines = [...view.contentDOM.querySelectorAll(".cm-line")];
    expect(lines[0]?.className).toContain("cm-md-list");
    expect(lines[0]?.getAttribute("style")).toContain("--md-indent: 2ch");
    expect(lines[1]?.getAttribute("style")).toContain("--md-indent: 4ch");
    expect(lines[3]?.className).not.toContain("cm-md-list");
  });
});
