// The parts of the editor that only exist once there is a real view: what the
// caret is allowed to walk through, and which direction it moves when the model
// writes underneath it. Both were bugs before they were tests.

import { describe, expect, test } from "bun:test";
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { findNext, SearchQuery, setSearchQuery } from "@codemirror/search";
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

describe("resizing a picture by its corner", () => {
  // happy-dom lays nothing out, so the two measurements the drag reads are
  // given: the picture is drawn 200px wide on an 800px line.
  const measured = (handle: EditorHandle) => {
    const img = handle.dom.querySelector("img.cm-md-image") as HTMLImageElement;
    const grip = handle.dom.querySelector(".cm-md-resize") as HTMLElement;
    const line = img.closest(".cm-line") as HTMLElement;
    img.getBoundingClientRect = () => ({ width: 200 }) as DOMRect;
    Object.defineProperty(line, "clientWidth", { value: 800 });
    grip.setPointerCapture = () => {};
    return { img, grip };
  };
  const pointer = (type: string, clientX: number) =>
    new PointerEvent(type, { clientX, pointerId: 1, bubbles: true, cancelable: true });

  test("draws the width the text asks for", () => {
    const { handle } = openEditor("![a|300](a.png)");
    const img = handle.dom.querySelector("img.cm-md-image") as HTMLImageElement;
    expect(img.style.width).toBe("300px");
    // The 60vh cap would squash a tall picture drawn at the width asked for.
    expect(img.style.maxHeight).toBe("none");
    expect(img.alt).toBe("a");
    handle.destroy();
  });

  test("dragging the grip writes the new width into the note", () => {
    let body = "";
    const { handle, view } = openEditor("![a](a.png)\nafter", undefined, { onEdit: (b) => { body = b; } });
    const { img, grip } = measured(handle);
    grip.dispatchEvent(pointer("pointerdown", 100));
    grip.dispatchEvent(pointer("pointermove", 150));
    // Live while dragging, before anything is written.
    expect(img.style.width).toBe("250px");
    expect(view.state.doc.toString()).toBe("![a](a.png)\nafter");
    grip.dispatchEvent(pointer("pointerup", 150));
    expect(view.state.doc.toString()).toBe("![a|250](a.png)\nafter");
    // An edit like typing, so it saves and syncs.
    expect(body).toBe("![a|250](a.png)\nafter");
    handle.destroy();
  });

  test("keeps the same picture element, so it does not reload", () => {
    const { handle } = openEditor("![a](a.png)");
    const { img, grip } = measured(handle);
    grip.dispatchEvent(pointer("pointerdown", 100));
    grip.dispatchEvent(pointer("pointermove", 160));
    grip.dispatchEvent(pointer("pointerup", 160));
    expect(handle.dom.querySelector("img.cm-md-image")).toBe(img);
    expect(img.style.width).toBe("260px");
    handle.destroy();
  });

  test("stops at the width of the line and at a usable minimum", () => {
    const { handle, view } = openEditor("![a](a.png)");
    const { grip } = measured(handle);
    grip.dispatchEvent(pointer("pointerdown", 100));
    grip.dispatchEvent(pointer("pointermove", 5000));
    grip.dispatchEvent(pointer("pointerup", 5000));
    expect(view.state.doc.toString()).toBe("![a|800](a.png)");
    const again = measured(handle);
    again.grip.dispatchEvent(pointer("pointerdown", 100));
    again.grip.dispatchEvent(pointer("pointermove", -5000));
    again.grip.dispatchEvent(pointer("pointerup", -5000));
    expect(view.state.doc.toString()).toBe("![a|48](a.png)");
    handle.destroy();
  });

  test("a click on the grip without a drag writes nothing", () => {
    const { handle, view } = openEditor("![a](a.png)");
    const { grip } = measured(handle);
    grip.dispatchEvent(pointer("pointerdown", 100));
    grip.dispatchEvent(pointer("pointerup", 100));
    expect(view.state.doc.toString()).toBe("![a](a.png)");
    handle.destroy();
  });

  test("dragging out and back to where it started writes nothing", () => {
    const { handle, view } = openEditor("![a](a.png)");
    const { grip } = measured(handle);
    grip.dispatchEvent(pointer("pointerdown", 100));
    grip.dispatchEvent(pointer("pointermove", 180));
    grip.dispatchEvent(pointer("pointermove", 100));
    grip.dispatchEvent(pointer("pointerup", 100));
    expect(view.state.doc.toString()).toBe("![a](a.png)");
    handle.destroy();
  });

  test("double-clicking the grip puts it back to its own size", () => {
    const { handle, view } = openEditor("![a|300](a.png)");
    const grip = handle.dom.querySelector(".cm-md-resize") as HTMLElement;
    grip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(view.state.doc.toString()).toBe("![a](a.png)");
    const reset = handle.dom.querySelector("img.cm-md-image") as HTMLImageElement;
    expect(reset.style.width).toBe("");
    // Back to its own size, so back under the cap that keeps it on screen.
    expect(reset.style.maxHeight).toBe("");
    handle.destroy();
  });
});

describe("finding text in a note", () => {
  test("opens the editor's own find panel", () => {
    const { handle } = openEditor("hello");
    expect(handle.dom.querySelector(".cm-search")).toBeNull();
    handle.find();
    expect(handle.dom.querySelector(".cm-search")).not.toBeNull();
    handle.destroy();
  });

  test("finds text far below what is on screen", () => {
    // The reason this exists: CodeMirror renders only the lines in view, so
    // the browser's find could not see "mindcraft" further down
    // board-design.md. The editor's find searches the document, not the page.
    const body = Array.from({ length: 600 }, (_, k) => (k === 540 ? "mindcraft ultra" : `line ${k}`)).join("\n");
    const { handle, view } = openEditor(body);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "mindcraft" })) });
    expect(findNext(view)).toBe(true);
    const at = view.state.selection.main;
    expect(view.state.sliceDoc(at.from, at.to)).toBe("mindcraft");
    expect(view.state.doc.lineAt(at.from).number).toBe(541);
    handle.destroy();
  });
});
