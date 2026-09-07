// The dump: one file per day, and the day does not start at midnight.

export const DUMP_DIR = "dump";

// A thought at 01:30 belongs to the night before, so the day runs 04:00 to
// 03:59. Shifting back four hours and taking the local date says exactly that.
const ROLLOVER_HOURS = 4;

const pad = (n: number): string => String(n).padStart(2, "0");

export const dumpDayOf = (now: number): string => {
  const shifted = new Date(now - ROLLOVER_HOURS * 60 * 60 * 1000);
  return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(
    shifted.getDate(),
  )}`;
};

export const dumpPathOf = (now: number): string =>
  `${DUMP_DIR}/${dumpDayOf(now)}.md`;

export const isDumpPath = (path: string): boolean =>
  path.startsWith(`${DUMP_DIR}/`) && path.endsWith(".md");

// The date a dump file is for, taken from its name. Never stored inside the
// file — that would be a file repeating its own name (never duplicate rules).
export const dayOfPath = (path: string): string =>
  path.slice(DUMP_DIR.length + 1, -".md".length);

// Wall-clock time, not the shifted hour. The shift decides which file an entry
// lands in; the label shows when it was actually written.
export const stamp = (now: number): string => {
  const d = new Date(now);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Append a captured line. Time moves forward through a dump day, so the end is
// always the right place — no sorting needed on the happy path.
export const appendEntry = (body: string, text: string, now: number): string => {
  const line = `${stamp(now)} ${text.trim()}`;
  if (body.trim() === "") return `${line}\n`;
  return `${body.replace(/\n*$/, "")}\n${line}\n`;
};

// The whole dump as one document, newest day first, each under a heading of its
// date. Newest first because the alternative buries today under every day that
// came before it — with a year of entries that is a couple of thousand lines of
// scrolling to reach the only one you are writing in.
//
// Structurally the same trick as the note editor: the text is a view of the
// notes, and the split below is its exact inverse, so what is typed goes back
// into the files it came out of.

export interface DumpDay {
  readonly path: string;
  readonly body: string;
}

const HEADING = /^# (\d{4}-\d{2}-\d{2})\s*$/;

const trimBody = (body: string): string => body.replace(/^\s*\n|\s+$/g, "");

// The shape appendEntry writes: a trailing newline, or nothing at all. Bodies
// that come back through the editor are put back into it, so an edit does not
// quietly change the file's whitespace.
const asStored = (body: string): string => (body === "" ? "" : `${body}\n`);

export const headingFor = (path: string): string => `# ${dayOfPath(path)}`;

export const composeDump = (days: readonly DumpDay[]): string =>
  days
    .map((day) => {
      const body = trimBody(day.body);
      return body === ""
        ? `${headingFor(day.path)}\n`
        : `${headingFor(day.path)}\n\n${body}\n`;
    })
    .join("\n");

// The inverse. Only a heading naming a day that exists is structure; anything
// else — including a date this vault has no file for — is content of the day
// above it, and text above every heading belongs to the first day.
//
// That rule is chosen to be total: every character of the document lands in
// some file. A section that belonged to nothing would be erased by the next
// repaint, which regenerates this document from the notes.
export const splitDump = (
  doc: string,
  days: readonly DumpDay[],
): Map<string, string> => {
  const first = days[0];
  const known = new Set(days.map((d) => dayOfPath(d.path)));
  const collected = new Map<string, string[]>();
  let current: string | null = first === undefined ? null : dayOfPath(first.path);

  const put = (day: string, line: string | null): void => {
    const lines = collected.get(day) ?? [];
    if (line !== null) lines.push(line);
    collected.set(day, lines);
  };

  for (const line of doc.split("\n")) {
    const day = HEADING.exec(line)?.[1];
    if (day !== undefined && known.has(day)) {
      current = day;
      put(day, null);
      continue;
    }
    if (current !== null) put(current, line);
  }

  const bodies = new Map<string, string>();
  for (const [day, lines] of collected) bodies.set(day, trimBody(lines.join("\n")));
  return bodies;
};

// Which files the document disagrees with, and what they should say.
//
// Compared after normalising both sides, so opening the dump and typing one
// character does not rewrite every day that happened to have a stray blank line
// at the end of it.
export const dumpEdits = (
  doc: string,
  days: readonly DumpDay[],
): DumpDay[] => {
  const bodies = splitDump(doc, days);
  const changed: DumpDay[] = [];
  for (const day of days) {
    const next = asStored(bodies.get(dayOfPath(day.path)) ?? "");
    if (next !== asStored(trimBody(day.body))) changed.push({ path: day.path, body: next });
  }
  return changed;
};

// Where each day's own text sits in the composite document.
//
// The document is many files behind one editor, so anything that acts at a
// position — a pasted image, a dropped file — has to be able to say which file
// that position is in and where in it. Kept next to composeDump because the two
// have to agree exactly; a test holds them to it.
export interface DumpSection {
  readonly path: string;
  // Where the day's heading begins, so a caret anywhere on it belongs to it.
  readonly start: number;
  readonly from: number;
  readonly to: number;
  // What composing stripped from the front of the stored body, which is the
  // difference between an offset in the document and one in the file.
  readonly leading: number;
}

export const dumpSections = (days: readonly DumpDay[]): DumpSection[] => {
  const sections: DumpSection[] = [];
  let at = 0;
  for (const day of days) {
    if (sections.length > 0) at += 1; // the blank line joining two days
    const trimmed = trimBody(day.body);
    const from = at + headingFor(day.path).length + (trimmed === "" ? 1 : 2);
    const to = from + trimmed.length;
    sections.push({
      path: day.path,
      start: at,
      from,
      to,
      leading: /^\s*\n/.exec(day.body)?.[0].length ?? 0,
    });
    at = trimmed === "" ? to : to + 1;
  }
  return sections;
};

export interface DumpSpot {
  readonly path: string;
  // Into the day's stored body, not into the document.
  readonly offset: number;
}

// Which file a position in the document is in. Follows the same rule as the
// split — a position belongs to the day whose heading is above it, and one
// above every heading belongs to the first day — so a picture lands where the
// text around it is about to be written.
export const dumpSpotAt = (
  days: readonly DumpDay[],
  pos: number,
): DumpSpot | null => {
  let found: DumpSection | undefined;
  for (const section of dumpSections(days)) {
    if (section.start > pos) break;
    found = section;
  }
  if (found === undefined) return null; // no days, so no spot
  const within = Math.min(Math.max(pos, found.from), found.to);
  return { path: found.path, offset: within - found.from + found.leading };
};
