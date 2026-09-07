// The address bar and the tab title as a view of the model, like any other.
//
// Only the notes mode has a note open — the dump, archive and trash views
// render something else entirely — so all of those are the root. A URL naming a
// state the app cannot restore on reload would be worse than no URL at all.
//
// No DOM here on purpose. What the URL should say is a decision and belongs
// with the other decisions; meeting the History API is main.ts's job, and it is
// the only thing that has to know the difference between pushing and replacing.

import { basenameOf } from "./links.ts";

export interface Located {
  readonly mode: string;
  readonly openPath: string | null;
}

const APP = "notes";

const openNote = (m: Located): string | null =>
  m.mode === "notes" ? m.openPath : null;

// Segment by segment: the slashes are structure and have to survive, while
// everything inside a segment is a filename and does not.
export const urlFor = (m: Located): string => {
  const path = openNote(m);
  return path === null
    ? "/"
    : `/${path.split("/").map(encodeURIComponent).join("/")}`;
};

export const titleFor = (m: Located): string => {
  const path = openNote(m);
  return path === null ? APP : `${basenameOf(path)} — ${APP}`;
};

// The inverse, for a cold load and for the back button.
//
// Deliberately permissive: it does not try to judge what a note path looks
// like, because the model already knows exactly which paths are notes and a
// second opinion here could only disagree with it.
export const pathFromUrl = (pathname: string): string | null => {
  const raw = pathname.replace(/^\/+/, "");
  if (raw === "") return null;
  try {
    return raw.split("/").map(decodeURIComponent).join("/");
  } catch {
    // A malformed %-escape is nobody's note.
    return null;
  }
};

// Push or replace. A decision, so it lives here with the others rather than in
// the ten lines of glue that own the History API.
//
// Replace while booting: hydrating settling on a note is not somewhere you
// navigated to, and an entry for it puts a back button in front of the page you
// actually arrived on. Replace when arriving by Back, or the push fights the
// button that got you there and you cannot leave the app. Replace on the way to
// the root, because the dump, archive and trash are not addressable — an entry
// for them is one the app cannot honour when you come back to it.
export const historyMethod = (
  url: string,
  at: { readonly booted: boolean; readonly fromPop: boolean },
): "pushState" | "replaceState" =>
  !at.booted || at.fromPop || url === "/" ? "replaceState" : "pushState";
