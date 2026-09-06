// Markdown to a safe DOM fragment.
//
// The editor stays a textarea; this is a preview. Rendering into an editable
// surface would mean a markdown -> document tree -> markdown round trip, which
// is lossy exactly where people notice and is the trap phase 1 avoided.

import { marked } from "marked";
import { basenameOf } from "./links.ts";

// Turned into ordinary markdown links before parsing, so the renderer needs no
// plugin: [[japanese-grammar]] becomes [japanese-grammar](#note:japanese-grammar).
const WIKILINK = /\[\[([^\]\n]+)\]\]/g;

export const wikilinksToMarkdown = (body: string): string =>
  body.replace(WIKILINK, (_whole, inner: string) => {
    const target = inner.trim();
    return `[${basenameOf(target)}](#note:${encodeURIComponent(target)})`;
  });

const FORBIDDEN_TAGS = new Set([
  "SCRIPT",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "LINK",
  "STYLE",
  "META",
  "BASE",
  "FORM",
]);

const SAFE_URL = /^(https?:|mailto:|#)/i;

// Not DOMPurify, and not claimed to be. It removes the obvious class — script
// execution and navigation to a javascript: URL — which is the risk that matters
// when an agent may summarise a web page into a note.
export const sanitize = (root: ParentNode): void => {
  for (const element of [...root.querySelectorAll("*")]) {
    if (FORBIDDEN_TAGS.has(element.tagName)) {
      element.remove();
      continue;
    }
    for (const attr of [...element.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attr.name);
        continue;
      }
      if ((name === "href" || name === "src") && !SAFE_URL.test(attr.value.trim())) {
        element.removeAttribute(attr.name);
      }
    }
  }
};

export const renderMarkdown = (body: string, doc: Document): DocumentFragment => {
  const html = marked.parse(wikilinksToMarkdown(body), {
    gfm: true,
    async: false,
  }) as string;

  const template = doc.createElement("template");
  template.innerHTML = html;
  sanitize(template.content);
  return template.content;
};
