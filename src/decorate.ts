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
    };

export type ResolveImage = (src: string) => string | null;

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
};

const WIKILINK = /\[\[([^\]\n]+)\]\]/g;

// `![alt](src)` as the parser reports it: one `Image` node, so the source and
// alt are read back out of the text rather than reassembled from children.
const IMAGE_PARTS = /^!\[([^\]]*)\]\(([^)\s]+)/;

export const spansFor = (
  doc: string,
  resolveImage: ResolveImage,
  range: { from: number; to: number } = { from: 0, to: doc.length },
): Span[] => {
  const spans: Span[] = [];
  const tree = markdownLanguage.parser.parse(doc);
  const seenLines = new Set<number>();

  tree.iterate({
    from: range.from,
    to: range.to,
    enter: (node) => {
      const heading = HEADING.exec(node.name);
      if (heading) {
        // One line decoration per heading, keyed by start so a re-entered node
        // cannot add it twice.
        if (!seenLines.has(node.from)) {
          seenLines.add(node.from);
          spans.push({
            kind: "line",
            from: node.from,
            class: `cm-md-h${heading[1]}`,
          });
        }
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

  // The parser has no concept of a wikilink, so it gets a scan of its own.
  for (const match of doc.slice(range.from, range.to).matchAll(WIKILINK)) {
    const at = range.from + (match.index ?? 0);
    spans.push({
      kind: "mark",
      from: at,
      to: at + match[0].length,
      class: "cm-md-wikilink",
    });
  }

  // CodeMirror requires decorations sorted by position, and line decorations
  // ahead of marks that start at the same offset.
  const weight = (s: Span): number => (s.kind === "line" ? 0 : 1);
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
