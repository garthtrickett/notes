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
// file — that would be a file repeating its own name (principle 4).
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
