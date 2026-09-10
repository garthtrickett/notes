// The three daily email/Slack check-ins.
//
// Done-ness is a fact about the day, not about the device that noticed it, so
// it lives where every other fact about the day lives: as ordinary task lines
// at the top of that day's dump file. Ticking one is a one-character flip fed
// back through the ordinary `edited` proposal, exactly like the Tasks tab —
// which means persist, push, pull, undo and conflict handling all already know
// what to do with it, and it reaches the other device for free.
//
// It used to live in localStorage, keyed by dump day. That was per device, and
// the reason given was that a reminder is a local matter — but notify.ts
// schedules all three slots on every boot and never reads done-ness, so the
// tick suppressed nothing. It was a checklist pretending to be a reminder.

import { dumpDayOf } from "./dump.ts";

export interface CheckinSlot {
  readonly id: string;
  readonly label: string;
  readonly hour: number;
  readonly minute: number;
}

export const SLOTS: readonly CheckinSlot[] = [
  { id: "morning", label: "Morning check-in", hour: 9, minute: 0 },
  { id: "midday", label: "Midday check-in", hour: 13, minute: 0 },
  { id: "evening", label: "Evening check-in", hour: 17, minute: 0 },
];

export type CheckinState = "done" | "due" | "upcoming";

// A slot is due once its time has passed and it has not been ticked off. The
// clock is injected (injected, not reached for).
export const stateOf = (
  slot: CheckinSlot,
  now: number,
  done: ReadonlySet<string>,
): CheckinState => {
  if (done.has(slot.id)) return "done";
  const at = new Date(now);
  const passed =
    at.getHours() > slot.hour ||
    (at.getHours() === slot.hour && at.getMinutes() >= slot.minute);
  return passed ? "due" : "upcoming";
};

// The label is the identity, because the label is what the file says. Renaming
// a slot orphans its line rather than silently adopting it — the same bargain
// the Tasks tab makes, and the honest one when the file is the truth.
const LINE = /^- \[([ xX])\] (.+?)\s*$/;

const slotOfLabel = (label: string): CheckinSlot | undefined =>
  SLOTS.find((slot) => slot.label === label);

export const checkinLine = (slot: CheckinSlot, done: boolean): string =>
  `- [${done ? "x" : " "}] ${slot.label}`;

// Which slots this day's body says are done. A slot with no line is not done;
// nothing is written until the first tick, so an untouched day stays an
// untouched file and two devices cannot race to seed one.
export const doneIn = (body: string): Set<string> => {
  const done = new Set<string>();
  for (const line of body.split("\n")) {
    const m = LINE.exec(line);
    if (m === null) continue;
    const slot = slotOfLabel(m[2] as string);
    if (slot !== undefined && (m[1] as string) !== " ") done.add(slot.id);
  }
  return done;
};

// Flip one slot in one day's body. Lines that exist keep their order fixed to
// SLOTS, so a day never ends up with evening above morning; everything else in
// the file is left exactly where it was.
export const toggleCheckin = (body: string, slot: CheckinSlot): string => {
  const present = new Map<string, boolean>();
  const rest: string[] = [];
  for (const line of body.split("\n")) {
    const m = LINE.exec(line);
    const found = m === null ? undefined : slotOfLabel(m[2] as string);
    if (m !== null && found !== undefined) {
      present.set(found.id, (m[1] as string) !== " ");
      continue;
    }
    rest.push(line);
  }
  // Absent means never ticked, so the first tick is what writes the line.
  present.set(slot.id, !(present.get(slot.id) ?? false));

  const head = SLOTS.filter((s) => present.has(s.id)).map((s) =>
    checkinLine(s, present.get(s.id) as boolean),
  );
  // One trailing newline and no leading blank line: the shape dump.ts stores
  // and compares against, so ticking a box cannot show up as a whitespace edit
  // to the whole day.
  const tail = rest.join("\n").replace(/^\s*\n+/, "").replace(/\s+$/, "");
  if (head.length === 0) return tail === "" ? "" : `${tail}\n`;
  return tail === ""
    ? `${head.join("\n")}\n`
    : `${head.join("\n")}\n\n${tail}\n`;
};

// Which day's file a check-in tapped now belongs to. One definition, shared
// with capture, so the two can never disagree about where "today" is.
export { dumpDayOf };
