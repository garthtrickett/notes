// What the editor should draw, as a pure function of the text.
//
// No DOM and no CodeMirror view: the markdown parser produces a tree headlessly,
// so this is document text in, spans out, and testable without a browser. The
// adapter that turns these into real decorations lives in editor.ts and holds no
// decisions of its own.
//
// The Ulysses rule is the whole design: markup is *dimmed*, never removed, so
// nothing appears or disappears as the caret moves and nothing reflows.

import { markdownLanguage } from "@codemirror/lang-markdown";
import type { SyntaxNode } from "@lezer/common";
import { isVideoPath } from "./attachments.ts";

export type Span =
  // A whole line, for things that change its metrics — only headings do.
  | { readonly kind: "line"; readonly from: number; readonly class: string }
  | { readonly kind: "mark"; readonly from: number; readonly to: number; readonly class: string }
  | {
      readonly kind: "image";
      readonly from: number;
      readonly to: number;
      readonly src: string;
      readonly alt: string;
      // Decided by the path, not by the URL. The URL used to say `data:video/`
      // and now says `blob:`, and a widget that reads the scheme to know what
      // to draw silently became an <img> around a video.
      readonly video: boolean;
    }
  // How far a wrapped line should hang, in characters. The preview gets this
  // from `<li>` for free; here the marker is still text on the line, so the
  // column it ends at has to be counted.
  | { readonly kind: "indent"; readonly from: number; readonly columns: number };

export type ResolveImage = (src: string) => string | null;

// What a wikilink points at. The preview has always coloured these three
// differently; the editor showed them all alike, so an ambiguous link looked
// exactly like a working one and clicking it did nothing with nothing said.
export type LinkState = "found" | "missing" | "ambiguous";
export type ResolveWikilink = (target: string) => LinkState;

const HEADING = /^ATXHeading(\d)$/;

const MARK_CLASS: Readonly<Record<string, string>> = {
  HeaderMark: "cm-md-mark",
  EmphasisMark: "cm-md-mark",
  CodeMark: "cm-md-mark",
  LinkMark: "cm-md-mark",
  QuoteMark: "cm-md-mark",
  ListMark: "cm-md-mark",
  StrongEmphasis: "cm-md-strong",
  Emphasis: "cm-md-em",
  InlineCode: "cm-md-code",
  URL: "cm-md-url",
  Link: "cm-md-link",
  FencedCode: "cm-md-fence",
  CodeText: "cm-md-code",
  Strikethrough: "cm-md-strike",
  StrikethroughMark: "cm-md-mark",
  CodeInfo: "cm-md-mark",
  // The four spaces are what make an indented block code; CodeText starts after
  // them, so styling the block is what covers it.
  CodeBlock: "cm-md-fence",
  Autolink: "cm-md-link",
  LinkTitle: "cm-md-mark",
  LinkLabel: "cm-md-mark",
  // Each `|`, and the whole `|---|---|` row, are both this node.
  TableDelimiter: "cm-md-mark",
  // A `[ex]: https://…` line is metadata, not prose.
  LinkReference: "cm-md-ref",
};

// Headings whose level is written underneath rather than in front.
const SETEXT: Readonly<Record<string, string>> = {
  SetextHeading1: "cm-md-h1",
  SetextHeading2: "cm-md-h2",
};

const WIKILINK = /\[\[([^\]\n]+)\]\]/g;

// `![alt](src)` as the parser reports it: one `Image` node, so the source and
// alt are read back out of the text rather than reassembled from children.
const IMAGE_PARTS = /^!\[([^\]]*)\]\(([^)\s]+)/;

const lineStartAt = (doc: string, pos: number): number =>
  doc.lastIndexOf("\n", pos - 1) + 1;

// Some constructs are styled a line at a time because a line is what has
// metrics — a table's monospace, a quote's border. Clamped to the range so a
// table taller than the viewport only decorates what is on screen.
const eachLine = (
  doc: string,
  from: number,
  to: number,
  range: { from: number; to: number },
  add: (at: number) => void,
): void => {
  let at = Math.max(lineStartAt(doc, from), lineStartAt(doc, range.from));
  const end = Math.min(to, range.to);
  while (at <= end) {
    add(at);
    const next = doc.indexOf("\n", at);
    if (next === -1 || next >= end) break;
    at = next + 1;
  }
};

const quoteDepth = (node: SyntaxNode): number => {
  let depth = 1;
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (parent.name === "Blockquote") depth += 1;
  }
  return depth;
};

export const spansFor = (
  doc: string,
  resolveImage: ResolveImage,
  range: { from: number; to: number } = { from: 0, to: doc.length },
  resolveWikilink: ResolveWikilink = () => "found",
): Span[] => {
  const spans: Span[] = [];
  const tree = markdownLanguage.parser.parse(doc);
  // One indent per line, and the last write wins: a nested item is entered
  // after the item containing it, and it is the inner column its own wrapped
  // lines should hang from.
  const indents = new Map<number, number>();
  // Keyed by class as well as position: a quoted table wants both.
  const seenLines = new Set<string>();
  const line = (at: number, cls: string): void => {
    const key = `${at}|${cls}`;
    if (seenLines.has(key)) return;
    seenLines.add(key);
    spans.push({ kind: "line", from: at, class: cls });
  };

  tree.iterate({
    from: range.from,
    to: range.to,
    enter: (node) => {
      const heading = HEADING.exec(node.name);
      if (heading) {
        line(node.from, `cm-md-h${heading[1]}`);
        return;
      }

      const setext = SETEXT[node.name];
      if (setext !== undefined) {
        // The text line only. The `====` underneath is markup and is already
        // dimmed as a HeaderMark; sizing it too would make the underline shout.
        line(lineStartAt(doc, node.from), setext);
        return;
      }

      if (node.name === "Table") {
        // Per line, so the columns the author aligned line up. The source is
        // never re-aligned — only made visible.
        eachLine(doc, node.from, node.to, range, (at) => line(at, "cm-md-table"));
        return;
      }

      if (node.name === "TableCell" && node.node.parent?.name === "TableHeader") {
        spans.push({ kind: "mark", from: node.from, to: node.to, class: "cm-md-th" });
        return;
      }

      if (node.name === "Blockquote") {
        const cls = quoteDepth(node.node) >= 2 ? "cm-md-quote2" : "cm-md-quote";
        eachLine(doc, node.from, node.to, range, (at) => line(at, cls));
        return;
      }

      if (node.name === "ListItem") {
        const mark = node.node.firstChild;
        if (mark !== null && mark.name === "ListMark") {
          // CommonMark lets one to four spaces follow the marker; content
          // begins wherever they end.
          let after = mark.to;
          while (after - mark.to < 4 && doc[after] === " ") after += 1;
          const start = lineStartAt(doc, node.from);
          const columns = Math.max(after, mark.to + 1) - start;
          eachLine(doc, node.from, node.to, range, (at) => indents.set(at, columns));
        }
        return;
      }

      if (node.name === "HorizontalRule") {
        line(lineStartAt(doc, node.from), "cm-md-rule");
        return;
      }

      if (node.name === "TaskMarker") {
        // `[x]` in three parts, so the brackets can dim while the mark itself
        // stays legible.
        const done = doc[node.from + 1] !== " ";
        spans.push({ kind: "mark", from: node.from, to: node.from + 1, class: "cm-md-mark" });
        spans.push({
          kind: "mark",
          from: node.from + 1,
          to: node.to - 1,
          class: done ? "cm-md-task-done" : "cm-md-task-open",
        });
        spans.push({ kind: "mark", from: node.to - 1, to: node.to, class: "cm-md-mark" });
        return;
      }

      if (node.name === "Task") {
        // Struck from after the marker, so the box itself is not crossed out.
        if (doc[node.from + 1] === " ") return;
        const from = Math.min(node.from + 4, node.to);
        if (from < node.to) {
          spans.push({ kind: "mark", from, to: node.to, class: "cm-md-struck" });
        }
        return;
      }

      if (node.name === "Escape") {
        // The backslash is machinery; what it protects is content.
        spans.push({ kind: "mark", from: node.from, to: node.from + 1, class: "cm-md-mark" });
        return;
      }

      if (node.name === "Image") {
        const text = doc.slice(node.from, node.to);
        const parts = IMAGE_PARTS.exec(text);
        const src = parts?.[2] ?? "";
        const resolved = resolveImage(src);
        // An image we cannot resolve stays as its markdown, visibly. Replacing
        // it with a broken picture would hide the path that explains why.
        if (resolved !== null) {
          spans.push({
            kind: "image",
            from: node.from,
            to: node.to,
            src: resolved,
            alt: parts?.[1] ?? "",
            video: isVideoPath(src),
          });
          // Skip the children. The brackets and URL are about to be covered by
          // the picture, and a mark inside a replaced range is a decoration the
          // adapter would then have to know to throw away — a decision that
          // belongs here, where the decisions are.
          return false;
        }
        return;
      }

      const cls = MARK_CLASS[node.name];
      if (cls !== undefined && node.to > node.from) {
        spans.push({ kind: "mark", from: node.from, to: node.to, class: cls });
      }
    },
  });

  for (const [at, columns] of indents) {
    spans.push({ kind: "indent", from: at, columns });
  }

  // The parser has no concept of a wikilink, so it gets a scan of its own.
  const LINK_CLASS: Readonly<Record<LinkState, string>> = {
    found: "cm-md-wikilink",
    missing: "cm-md-wikilink cm-md-wikilink-missing",
    ambiguous: "cm-md-wikilink cm-md-wikilink-ambiguous",
  };
  for (const match of doc.slice(range.from, range.to).matchAll(WIKILINK)) {
    const at = range.from + (match.index ?? 0);
    spans.push({
      kind: "mark",
      from: at,
      to: at + match[0].length,
      class: LINK_CLASS[resolveWikilink((match[1] ?? "").trim())],
    });
  }

  // CodeMirror requires decorations sorted by position, and line decorations
  // ahead of marks that start at the same offset.
  const weight = (s: Span): number => (s.kind === "line" || s.kind === "indent" ? 0 : 1);
  return spans.sort((a, b) => a.from - b.from || weight(a) - weight(b));
};

export interface WikilinkHit {
  readonly from: number;
  readonly to: number;
  readonly target: string;
}

// The range comes back with the target because clicking needs to know whether
// the caret was already inside *this* link.
export const wikilinkAt = (doc: string, pos: number): WikilinkHit | null => {
  for (const match of doc.matchAll(WIKILINK)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    if (pos >= from && pos <= to) {
      return { from, to, target: (match[1] ?? "").trim() };
    }
  }
  return null;
};

export type { SyntaxNode };
