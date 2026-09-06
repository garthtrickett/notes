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
import { spansFor, wikilinkAt, type ResolveImage } from "./decorate.ts";

export interface EditorHooks {
  // Live, because an attachment can arrive while the note is open.
  readonly resolveImage: ResolveImage;
  readonly onEdit: (body: string) => void;
  readonly onPaste: (event: ClipboardEvent, caret: number) => void;
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
  ) {
    super();
  }

  // Without this every rebuild would swap the element and the browser would
  // re-decode the picture, which is visible as a flicker while typing.
  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  override toDOM(): HTMLElement {
    const img = document.createElement("img");
    img.className = "cm-md-image";
    img.src = this.src;
    img.alt = this.alt;
    return img;
  }
}

const buildDecorations = (view: EditorView, resolve: ResolveImage): DecorationSet => {
  const doc = view.state.doc.toString();
  const { from, to } = view.viewport;
  const ranges: Range<Decoration>[] = [];

  for (const span of spansFor(doc, resolve, { from, to })) {
    if (span.kind === "line") {
      // Anchor to the real line start: a heading may be indented, and a line
      // decoration anywhere but position zero of the line is rejected.
      const at = view.state.doc.lineAt(span.from).from;
      ranges.push(Decoration.line({ class: span.class }).range(at));
    } else if (span.kind === "mark") {
      ranges.push(Decoration.mark({ class: span.class }).range(span.from, span.to));
    } else {
      // Replace, not remove: the markdown is still in the document, so a
      // selection dragged across the picture copies the reference with it.
      ranges.push(
        Decoration.replace({ widget: new ImageWidget(span.src, span.alt) }).range(
          span.from,
          span.to,
        ),
      );
    }
  }
  return Decoration.set(ranges, true);
};

const decorator = (hooks: EditorHooks) =>
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, hooks.resolveImage);
      }

      update(update: ViewUpdate): void {
        const forced = update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(rebuild)),
        );
        if (update.docChanged || update.viewportChanged || forced) {
          this.decorations = buildDecorations(update.view, hooks.resolveImage);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );

// The smallest edit that turns one string into the other. CodeMirror maps the
// selection through it, which is the whole reason the textarea's hand-rolled
// caret arithmetic goes away.
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
    destroy: () => view.destroy(),
  };
};

export { minimalChange };
