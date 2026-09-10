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

// `@` then a date, optionally a 24-hour time. Anchored to whitespace at both
// ends so an email address or a `@mention` mid-sentence is not a reminder.
const PATTERN = /(?:^|\s)@(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?(?=\s|$)/;

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

export const stampOf = (at: number): string => {
  const d = new Date(at);
  const date = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  // A 09:00 reminder round-trips to a bare date, so the common case stays the
  // short form rather than growing a `09:00` nobody typed.
  return d.getHours() === DEFAULT_HOUR && d.getMinutes() === 0
    ? `@${date}`
    : `@${date} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

// Set, move or clear the reminder on one title. Always one reminder per task:
// setting a second replaces the first rather than leaving both to argue.
export const withReminder = (title: string, at: number | null): string => {
  const bare = titleWithout(title);
  if (at === null) return bare;
  return bare === "" ? stampOf(at) : `${bare} ${stampOf(at)}`;
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
