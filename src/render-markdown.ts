// Markdown to a safe DOM fragment.
//
// This is the preview, and it is only the preview. The editor shows markdown as
// markdown and styles it in place; rendering into an editable surface would mean
// a markdown -> document tree -> markdown round trip, which is lossy exactly
// where people notice.

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

// Raw HTML in a note is not rendered as HTML. It is shown as the text it is.
//
// This is the whole answer to the SVG and MathML vectors — xlink:href,
// <animate attributeName="href">, <svg><script>, <math><maction> — because none
// of those elements ever reach the DOM to be filtered in the first place.
// Filtering them correctly means tracking browser quirks across namespaces, and
// an audit of this file found five holes in one pass.
//
// The cost is that a note containing <details> or <kbd> renders as literal text
// here while github.com renders it as markup. That is the trade: this app
// renders markdown, not HTML. Taking DOMPurify would buy the HTML back.
const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

marked.use({
  renderer: {
    html: ({ text }) => escapeHtml(text),
  },
});

// Second layer, for markup markdown itself produces — [x](javascript:alert(1))
// is an ordinary link as far as the parser is concerned.
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
  // Namespaced elements carry their own URL and scripting surfaces. Nothing in a
  // markdown note needs them, so they go wholesale rather than attribute by
  // attribute.
  "SVG",
  "MATH",
]);

const SAFE_URL = /^(https?:|mailto:|#)/i;

// Attachments render from the local copy as a data URL, so they work offline and
// in a private repo. Narrowed to a named list on purpose: allowing `data:` in
// general would readmit data:text/html and with it the whole class this exists
// to stop. mp4 and webm are containers for encoded frames — neither can carry
// script the way an SVG can, which is why svg is still absent.
const SAFE_DATA_MEDIA =
  /^data:(?:image\/(?:png|jpe?g|gif|webp|avif)|video\/(?:mp4|webm));base64,/i;

// Any attribute can carry a URL — href, src, srcset, xlink:href, formaction,
// poster, data. Allowlisting two names is how xlink:href walked straight past
// the check, so the test is on the *value* rather than the name.
const LOOKS_LIKE_URL = /^\s*[a-z][a-z0-9+.-]*:/i;

const isDangerousValue = (name: string, value: string): boolean => {
  // srcset goes unconditionally, before any allowlist can rescue it. Markdown
  // cannot produce one — an image is src and alt — so any srcset came from raw
  // HTML, and it fetches remotely, which leaks that the note was opened.
  if (name === "srcset" || name === "imagesrcset") return true;

  const trimmed = value.trim();
  if (name === "src" && SAFE_DATA_MEDIA.test(trimmed)) return false;
  if (SAFE_URL.test(trimmed)) return false;
  // Any scheme that is not on the allowlist, whatever attribute carries it.
  return LOOKS_LIKE_URL.test(trimmed);
};

export const sanitize = (root: ParentNode): void => {
  for (const element of [...root.querySelectorAll("*")]) {
    // tagName is lowercase in the SVG and MathML namespaces, so an uppercase
    // comparison silently missed <svg><script>.
    if (FORBIDDEN_TAGS.has(element.tagName.toUpperCase())) {
      element.remove();
      continue;
    }
    for (const attr of [...element.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (isDangerousValue(name, attr.value)) element.removeAttribute(attr.name);
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
    if (resolved === null) continue;
    if (resolved.startsWith("data:video/")) {
      // Markdown has one syntax for embedded media, so a clip arrives as an
      // <img>. Swapped before sanitising, so what the sanitiser checks is what
      // ends up on the page.
      const video = doc.createElement("video");
      video.setAttribute("src", resolved);
      video.setAttribute("controls", "");
      video.setAttribute("preload", "metadata");
      img.replaceWith(video);
      continue;
    }
    img.setAttribute("src", resolved);
  }

  sanitize(template.content);
  return template.content;
};
