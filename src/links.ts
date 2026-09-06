// Wikilinks, backlinks and search. All pure, all over plain strings.
//
// No markdown AST is needed for any of this: a wikilink is a regex, and an
// index of backlinks would be a second source of truth for something the note
// bodies already say (never duplicate rules).

import type { Note } from "./model.ts";

const WIKILINK = /\[\[([^\]\n]+)\]\]/g;

export const basenameOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
};

export const extractLinks = (body: string): string[] => {
  const found = new Set<string>();
  for (const match of body.matchAll(WIKILINK)) {
    const target = match[1]?.trim();
    if (target) found.add(target);
  }
  return [...found];
};

export type Resolution =
  | { readonly kind: "found"; readonly path: string }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous"; readonly paths: readonly string[] };

// Matched on basename, so a note keeps its inbound links when it moves between
// folders. A full path wins outright, which is how an ambiguous link is spelled.
export const resolveLink = (
  target: string,
  notes: ReadonlyMap<string, Note>,
): Resolution => {
  const exact = notes.get(target) ?? notes.get(`${target}.md`);
  if (exact && !exact.deleted) return { kind: "found", path: exact.path };

  const wanted = basenameOf(target);
  const matches = [...notes.values()]
    .filter((n) => !n.deleted && basenameOf(n.path) === wanted)
    .map((n) => n.path);

  if (matches.length === 1) return { kind: "found", path: matches[0] as string };
  if (matches.length === 0) return { kind: "missing" };
  return { kind: "ambiguous", paths: matches };
};

export const backlinksTo = (
  path: string,
  notes: ReadonlyMap<string, Note>,
): string[] => {
  const target = basenameOf(path);
  return [...notes.values()]
    .filter(
      (n) =>
        !n.deleted &&
        n.path !== path &&
        extractLinks(n.body).some((link) => basenameOf(link) === target),
    )
    .map((n) => n.path)
    .sort();
};

// Rewrites [[old]] to [[new]] without touching [[older]] — the whole link has to
// match, not a prefix of it.
export const rewriteLinks = (
  body: string,
  from: string,
  to: string,
): string => {
  const fromName = basenameOf(from);
  const toName = basenameOf(to);
  return body.replace(WIKILINK, (whole, inner: string) => {
    const trimmed = inner.trim();
    return basenameOf(trimmed) === fromName ? `[[${toName}]]` : whole;
  });
};

export const searchNotes = (
  notes: readonly Note[],
  query: string,
): Note[] => {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  return notes.filter(
    (n) =>
      n.path.toLowerCase().includes(needle) ||
      n.body.toLowerCase().includes(needle),
  );
};
