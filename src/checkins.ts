// The three daily email/Slack check-ins. Pure: slots in, state out, with no
// knowledge of the model, the view, or how a reminder gets delivered.
//
// Done-ness is per device, not per vault. Whether *this* phone reminded you is
// not something another device needs to know, so it lives in localStorage
// keyed by dump day rather than in a note or in IndexedDB.

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

const keyOf = (day: string): string => `notes.checkins.${day}`;

export const loadDone = (
  storage: Pick<Storage, "getItem">,
  now: number,
): Set<string> => {
  try {
    const raw = storage.getItem(keyOf(dumpDayOf(now)));
    if (raw === null) return new Set();
    const ids: unknown = JSON.parse(raw);
    if (!Array.isArray(ids)) return new Set();
    return new Set(ids.filter((id): id is string => typeof id === "string"));
  } catch {
    // A corrupt value is a missed morning, not a crash.
    return new Set();
  }
};

export const saveDone = (
  storage: Pick<Storage, "setItem">,
  now: number,
  done: ReadonlySet<string>,
): void => {
  storage.setItem(keyOf(dumpDayOf(now)), JSON.stringify([...done]));
};
