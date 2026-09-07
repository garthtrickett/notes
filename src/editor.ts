// The CodeMirror adapter. It holds no decisions about what markdown should look
// like — decorate.ts owns those — only the mechanics of getting them onto the
// screen and getting edits back out.
//
// The instance is created once and handed to the loop. lit is given a stable
// container to render and never rebuilds it, which is the same rule that fixed
// the preview flash: an imperative component must outlive the paint.

import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  Annotation,
  EditorSelection,
  EditorState,
  StateEffect,
  type Range,
} from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  spansFor,
  wikilinkAt,
  type ResolveImage,
  type ResolveWikilink,
} from "./decorate.ts";

export interface EditorHooks {
  // Live, because an attachment can arrive while the note is open.
  readonly resolveImage: ResolveImage;
  readonly resolveWikilink: ResolveWikilink;
  readonly onEdit: (body: string) => void;
  readonly onPaste: (event: ClipboardEvent, caret: number) => void;
  // A file dragged in from outside. Same destination as a paste; only the
  // gesture differs.
  readonly onDropFiles: (files: FileList, caret: number) => boolean;
  readonly onWikilink: (target: string) => void;
}

export interface EditorHandle {
  readonly dom: HTMLElement;
  readonly doc: () => string;
  // A different note gets a fresh state, so undo stops at the note boundary
  // instead of walking backwards into the one before it.
  readonly reset: (body: string) => void;
  readonly setDoc: (body: string) => void;
  readonly redecorate: () => void;
  readonly focus: () => void;
  // Focus with the caret placed, which is a dispatch and therefore something
  // only the editor can do.
  readonly focusAt: (pos: number) => void;
  readonly destroy: () => void;
}

// A change this file made, so the update listener can tell a pull from a
// keystroke and not report the model's own writes back to it as edits.
const fromModel = Annotation.define<boolean>();

const rebuild = StateEffect.define<null>();

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly video: boolean,
  ) {
    super();
  }

  // Without this every rebuild would swap the element and the browser would
  // re-decode the picture, which is visible as a flicker while typing.
  override eq(other: ImageWidget): boolean {
    return (
      other.src === this.src && other.alt === this.alt && other.video === this.video
    );
  }

  // CodeMirror discards every event that starts inside a widget by default. The
  // drag is the one that has to get through: its own dragstart handler has a
  // branch for draggable widgets that selects the range the widget covers, and
  // its drop then deletes and reinserts in a single change. Letting the event
  // reach it is the whole of "dragging a picture moves it" (never duplicate
  // rules). Everything else still stays the widget's business.
  override ignoreEvent(event: Event): boolean {
    return event.type !== "dragstart";
  }

  override toDOM(): HTMLElement {
    // A video is still one atomic thing in the document, so it is the same
    // widget with a different element inside it.
    if (this.video) {
      const video = document.createElement("video");
      video.className = "cm-md-image cm-md-video";
      video.src = this.src;
      video.controls = true;
      // The first frame without fetching the whole clip to find it.
      video.preload = "metadata";
      video.draggable = true;
      return video;
    }
    const img = document.createElement("img");
    img.className = "cm-md-image";
    img.src = this.src;
    img.alt = this.alt;
    // Draggable on purpose, and load-bearing: CodeMirror only treats a widget
    // as the thing being dragged when `event.target.draggable` is true. Without
    // it the browser drags the *picture* instead, and dropping that into a
    // contenteditable inserts its `src` — here the whole base64 data URL — as
    // text, which is what this looked like from the outside.
    img.draggable = true;
    return img;
  }
}

// Decorations and, alongside them, the ranges the editor must treat as single
// units. A picture is one thing to the reader, so it has to be one thing to the
// caret: without this, arrow keys walk invisibly through the hidden `![](...)`
// and a selection that looks like it stops above the picture actually reaches
// into it, so deleting eats a couple of characters out of the middle of the
// reference and leaves broken markdown where the image was.
interface Built {
  readonly decorations: DecorationSet;
  readonly atomics: DecorationSet;
}

const buildDecorations = (
  view: EditorView,
  resolve: ResolveImage,
  resolveLink: ResolveWikilink,
): Built => {
  const doc = view.state.doc.toString();
  const { from, to } = view.viewport;
  const ranges: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];

  for (const span of spansFor(doc, resolve, { from, to }, resolveLink)) {
    if (span.kind === "line") {
      // Anchor to the real line start: a heading may be indented, and a line
      // decoration anywhere but position zero of the line is rejected.
      const at = view.state.doc.lineAt(span.from).from;
      ranges.push(Decoration.line({ class: span.class }).range(at));
    } else if (span.kind === "indent") {
      const at = view.state.doc.lineAt(span.from).from;
      ranges.push(
        Decoration.line({
          class: "cm-md-list",
          attributes: { style: `--md-indent: ${span.columns}ch` },
        }).range(at),
      );
    } else if (span.kind === "mark") {
      ranges.push(Decoration.mark({ class: span.class }).range(span.from, span.to));
    } else {
      // Replace, not remove: the markdown is still in the document, so a
      // selection dragged across the picture copies the reference with it.
      const replace = Decoration.replace({
        widget: new ImageWidget(span.src, span.alt, span.video),
      });
      ranges.push(replace.range(span.from, span.to));
      atomic.push(replace.range(span.from, span.to));
    }
  }
  return {
    decorations: Decoration.set(ranges, true),
    atomics: Decoration.set(atomic, true),
  };
};

const decorator = (hooks: EditorHooks) =>
  ViewPlugin.fromClass(
    class {
      built: Built;

      constructor(view: EditorView) {
        this.built = buildDecorations(view, hooks.resolveImage, hooks.resolveWikilink);
      }

      update(update: ViewUpdate): void {
        const forced = update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(rebuild)),
        );
        if (update.docChanged || update.viewportChanged || forced) {
          this.built = buildDecorations(
            update.view,
            hooks.resolveImage,
            hooks.resolveWikilink,
          );
        }
      }
    },
    {
      decorations: (plugin) => plugin.built.decorations,
      provide: (plugin) =>
        EditorView.atomicRanges.of(
          (view) => view.plugin(plugin)?.built.atomics ?? Decoration.none,
        ),
    },
  );

// The smallest edit that turns one string into the other. CodeMirror maps the
// selection through it, so keeping the change tight is what keeps the caret
// still when the model writes underneath it.
const minimalChange = (
  previous: string,
  next: string,
): { from: number; to: number; insert: string } => {
  let head = 0;
  while (head < previous.length && head < next.length && previous[head] === next[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < previous.length - head &&
    tail < next.length - head &&
    previous[previous.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail += 1;
  }
  return {
    from: head,
    to: previous.length - tail,
    insert: next.slice(head, next.length - tail),
  };
};

export const createEditor = (hooks: EditorHooks): EditorHandle => {
  const dom = document.createElement("div");
  dom.className = "cm-host";

  const extensions = [
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown(),
    EditorView.lineWrapping,
    decorator(hooks),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      // A change this file dispatched is the model catching the editor up, not
      // the other way round. Reporting it back would mark a pulled note dirty.
      if (update.transactions.some((tr) => tr.annotation(fromModel) === true)) return;
      hooks.onEdit(update.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      paste: (event, view) => {
        hooks.onPaste(event, view.state.selection.main.head);
        return false; // a text paste is CodeMirror's business, not ours
      },
      // CodeMirror reads a dropped file with readAsText, which for an image
      // means either mojibake or — because it rejects text with consecutive
      // control characters — nothing at all. Dropping a picture did nothing
      // while pasting the same picture worked.
      drop: (event, view) => {
        const files = event.dataTransfer?.files;
        if (files === undefined || files.length === 0) return false;
        const at =
          view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
          view.state.selection.main.head;
        if (!hooks.onDropFiles(files, at)) return false;
        event.preventDefault();
        return true;
      },
      // mousedown, not click: the caret has not moved yet, so this can still see
      // where it was.
      mousedown: (event, view) => {
        const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (at === null) return false;
        const hit = wikilinkAt(view.state.doc.toString(), at);
        if (hit === null) return false;

        // One surface means a wikilink has to be both followable and editable.
        // A modifier follows it outright; otherwise the first click puts the
        // caret in, and clicking again — now from inside — follows. Nothing is
        // ever unreachable for editing, which a plain follow-on-click would make
        // the link text.
        const caret = view.state.selection.main.head;
        const inside = caret >= hit.from && caret <= hit.to;
        if (!event.metaKey && !event.ctrlKey && !inside) return false;

        event.preventDefault();
        hooks.onWikilink(hit.target);
        return true;
      },
    }),
  ];

  const view = new EditorView({ doc: "", extensions, parent: dom });

  return {
    dom,
    doc: () => view.state.doc.toString(),
    reset: (body) => {
      view.setState(EditorState.create({ doc: body, extensions }));
    },
    setDoc: (body) => {
      const previous = view.state.doc.toString();
      if (previous === body) return;
      const changes = view.state.changes(minimalChange(previous, body));
      const { anchor, head } = view.state.selection.main;
      // Map forward, deliberately. CodeMirror's default leaves a caret sitting
      // exactly at an insertion *before* the inserted text, so typing after
      // pasting an image continued in front of the picture rather than after it.
      // Text inserted at the caret carries the caret along.
      view.dispatch({
        changes,
        selection: EditorSelection.range(changes.mapPos(anchor, 1), changes.mapPos(head, 1)),
        annotations: fromModel.of(true),
      });
    },
    redecorate: () => {
      view.dispatch({ effects: rebuild.of(null), annotations: fromModel.of(true) });
    },
    focus: () => view.focus(),
    focusAt: (pos) => {
      const at = Math.max(0, Math.min(pos, view.state.doc.length));
      view.dispatch({ selection: EditorSelection.cursor(at), scrollIntoView: true });
      view.focus();
    },
    destroy: () => view.destroy(),
  };
};

export { minimalChange };
