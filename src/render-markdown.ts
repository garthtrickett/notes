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

// Attachments render from the local copy as a data URL, so they work offline and
// in a private repo. Narrowed to images on purpose: allowing `data:` in general
// would readmit data:text/html and with it the whole class this exists to stop.
const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif);base64,/i;

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
      if (name !== "href" && name !== "src") continue;
      const value = attr.value.trim();
      const allowed =
        SAFE_URL.test(value) ||
        (name === "src" && SAFE_DATA_IMAGE.test(value));
      if (!allowed) element.removeAttribute(attr.name);
    }
  }
};

export type ResolveImage = (src: string) => string | null;

export const renderMarkdown = (
  body: string,
  doc: Document,
  resolveImage: ResolveImage = () => null,
): DocumentFragment => {
  const html = marked.parse(wikilinksToMarkdown(body), {
    gfm: true,
    async: false,
  }) as string;

  const template = doc.createElement("template");
  template.innerHTML = html;

  // Before sanitising, so the data URL is what gets checked. An unresolved
  // source is left in place and visibly broken rather than silently dropped.
  for (const img of [...template.content.querySelectorAll("img")]) {
    const src = img.getAttribute("src");
    if (src === null) continue;
    const resolved = resolveImage(src);
    if (resolved !== null) img.setAttribute("src", resolved);
  }

  sanitize(template.content);
  return template.content;
};
