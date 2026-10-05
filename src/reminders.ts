// When a task wants to be brought up again.
//
// The time is written into the task line — `- [ ] call the bank @2026-09-11
// 09:00` — because the file is the only thing that syncs. Nothing here holds
// state: a reminder is read out of the text on every paint and written back as
// an ordinary edit, exactly like ticking a box. That is what makes a reminder
// set on the laptop arrive on the phone at all.
//
// The clock is injected everywhere, never reached for, so the same body reads
// the same way in a test as on a phone.

// How often a repeating task comes back, written after the stamp:
// `@2026-10-06 05:30! every day`. Days may be named in full or by their first
// three letters; a list is comma-separated with no spaces.
const DAY = "(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)";
const RULE = `day|weekday|week|month|year|\\d+\\s+(?:days?|weeks?|months?)|${DAY}(?:,${DAY})*`;

// `@` then a date, optionally a 24-hour time, an alarm `!` and a repeat.
// Anchored to whitespace at both ends so an email address or a `@mention`
// mid-sentence is not a reminder. A repeat that does not parse is left in the
// title as text rather than taking the stamp down with it.
const PATTERN = new RegExp(
  `(?:^|\\s)@(\\d{4})-(\\d{2})-(\\d{2})(?:\\s+(\\d{2}):(\\d{2}))?(!?)(?:\\s+every\\s+(${RULE}))?(?=\\s|$)`,
  "i",
);

// A trailing `!` asks for a clock alarm as well as a notification — "10:00!"
// reading as the shout it is. It rides in the text with the time rather than
// being kept beside the note, so the intent travels with the task; whether a
// given device can act on it is that device's business.
export const alarmWanted = (title: string): boolean =>
  (PATTERN.exec(title)?.[6] ?? "") === "!";

// The repeat as written, lowercased, or null for a one-off.
export const repeatIn = (title: string): string | null =>
  PATTERN.exec(title)?.[7]?.toLowerCase().replace(/\s+/g, " ") ?? null;

// A bare date means the morning, not midnight — nobody means 00:00 by "the
// 11th", and a reminder that fires while you are asleep is one you will not see.
const DEFAULT_HOUR = 9;

// Local time on purpose. These are notes about a day in the place you are
// standing; a UTC reading would drift the reminder by the timezone offset.
export const reminderIn = (title: string): number | null => {
  const m = PATTERN.exec(title);
  if (m === null) return null;
  const [, y, mo, d, hh, mm] = m;
  const at = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    hh === undefined ? DEFAULT_HOUR : Number(hh),
    mm === undefined ? 0 : Number(mm),
    0,
    0,
  );
  // Rejects 2026-02-31 and friends: Date rolls them over rather than failing,
  // so the only way to know is to ask what it made.
  if (at.getMonth() !== Number(mo) - 1 || at.getDate() !== Number(d)) return null;
  if (Number.isNaN(at.getTime())) return null;
  return at.getTime();
};

// What the row should read once the machinery is taken out of it.
export const titleWithout = (title: string): string =>
  title.replace(PATTERN, "").replace(/\s{2,}/g, " ").trim();

const two = (n: number): string => String(n).padStart(2, "0");

export const stampOf = (at: number, alarm = false): string => {
  const d = new Date(at);
  const date = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  // A 09:00 reminder round-trips to a bare date, so the common case stays the
  // short form rather than growing a `09:00` nobody typed.
  const stamp =
    d.getHours() === DEFAULT_HOUR && d.getMinutes() === 0
      ? `@${date}`
      : `@${date} ${two(d.getHours())}:${two(d.getMinutes())}`;
  return alarm ? `${stamp}!` : stamp;
};

// Set, move or clear the reminder on one title. Always one reminder per task:
// setting a second replaces the first rather than leaving both to argue.
export const withReminder = (
  title: string,
  at: number | null,
  alarm = false,
): string => {
  const bare = titleWithout(title);
  if (at === null) return bare;
  // Moving the time keeps the repeat; it is part of the task, not of the time.
  // Clearing the reminder takes it too, since a repeat has nothing to repeat.
  const repeat = repeatIn(title);
  const stamp = repeat === null ? stampOf(at, alarm) : `${stampOf(at, alarm)} every ${repeat}`;
  return bare === "" ? stamp : `${bare} ${stamp}`;
};

// The quick choices the Tasks tab offers, resolved against an injected now.
export interface ReminderChoice {
  readonly id: string;
  readonly label: string;
  readonly at: (now: number) => number;
}

const shift = (now: number, days: number, hour: number): number => {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

export const CHOICES: readonly ReminderChoice[] = [
  { id: "later", label: "This evening", at: (now) => shift(now, 0, 18) },
  { id: "tomorrow", label: "Tomorrow 9am", at: (now) => shift(now, 1, 9) },
  { id: "week", label: "Next week", at: (now) => shift(now, 7, 9) },
];

// How a due time reads on a row. Short, because it sits beside the task.
export const describe = (at: number, now: number): string => {
  const d = new Date(at);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((d.getTime() - midnight.getTime()) / 86_400_000);
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (days < 0) return `overdue ${time}`;
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 7) return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] as string} ${time}`;
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
};

// The next time a repeating task is due, once it has been done.
//
// Always at least one step past the stamp: ticking early means this one is
// done, not that the next one is. Then on past now: a daily task left for a
// week comes back once, tomorrow, rather than as seven overdue copies. The
// time of day is kept, and so is the local wall-clock time across a daylight
// saving change, because the arithmetic is on the calendar, not on
// milliseconds.
//
// A month from the 31st lands on the last day of a shorter month, and later
// months then follow from that day. Null for a rule this cannot read, which
// leaves the task ticked rather than guessing.
export const nextOccurrence = (
  stamp: number,
  repeat: string,
  now: number,
): number | null => {
  const step = stepOf(repeat);
  if (step === null) return null;
  let at = new Date(stamp);
  // Bounded: a daily task untouched for a decade is ~3650 steps.
  for (let i = 0; i < 100_000; i += 1) {
    at = step(at);
    if (at.getTime() > now) return at.getTime();
  }
  return null;
};

const DAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const addDays = (d: Date, n: number): Date => {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
};

const addMonths = (d: Date, n: number): Date => {
  const next = new Date(d);
  const day = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + n);
  const last = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, last));
  return next;
};

const stepOf = (repeat: string): ((d: Date) => Date) | null => {
  const rule = repeat.toLowerCase().trim();
  if (rule === "day") return (d) => addDays(d, 1);
  if (rule === "week") return (d) => addDays(d, 7);
  if (rule === "month") return (d) => addMonths(d, 1);
  if (rule === "year") return (d) => addMonths(d, 12);
  const counted = /^(\d+)\s+(day|week|month)s?$/.exec(rule);
  if (counted !== null) {
    const n = Number(counted[1]);
    if (n < 1) return null;
    if (counted[2] === "day") return (d) => addDays(d, n);
    if (counted[2] === "week") return (d) => addDays(d, 7 * n);
    return (d) => addMonths(d, n);
  }
  const days = rule === "weekday"
    ? new Set([1, 2, 3, 4, 5])
    : new Set(rule.split(",").map((name) => DAY_INDEX[name.slice(0, 3)]));
  if (days.has(undefined) || days.size === 0) return null;
  return (d) => {
    let next = addDays(d, 1);
    while (!days.has(next.getDay())) next = addDays(next, 1);
    return next;
  };
};
