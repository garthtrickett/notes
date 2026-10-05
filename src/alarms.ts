// What the alarm screen said, turned back into edits to the task it rang for.
//
// The phone owns the ringing: AlarmManager wakes it, a full-screen screen
// shows, and Done or Snooze is pressed with the app closed — often with the
// WebView not even running. So the native side writes the answer down and the
// app reads it the next time it runs. This is the part that decides what the
// answer means, and it is pure so it can be tested without a phone.
//
// Nothing is stored beside the note here either. Done is a tick and Snooze is
// a new stamp, both ordinary edits that sync like any other.

import { flipTask, setReminder, tasksIn } from "./tasks.ts";

export interface AlarmAnswer {
  readonly kind: "done" | "snooze";
  readonly path: string;
  // The task as it read when the alarm was scheduled: its title and the stamp
  // it rang at. Together they find the line again without stored offsets.
  readonly title: string;
  readonly at: number;
  // Where Snooze moved it to. Chosen by the phone, not here, because the phone
  // has already scheduled the snoozed alarm for exactly that minute.
  readonly snoozeTo: number | null;
}

// The bridge hands over whatever was in SharedPreferences. Anything malformed
// is dropped rather than trusted: a bad entry costs one answer, never a crash
// or an edit to the wrong line.
export const parseAnswers = (raw: unknown): AlarmAnswer[] => {
  if (!Array.isArray(raw)) return [];
  const answers: AlarmAnswer[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { kind, path, title, at, snoozeTo } = item as Record<string, unknown>;
    if (kind !== "done" && kind !== "snooze") continue;
    if (typeof path !== "string" || typeof title !== "string") continue;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    if (kind === "snooze" && (typeof snoozeTo !== "number" || !Number.isFinite(snoozeTo))) continue;
    answers.push({ kind, path, title, at, snoozeTo: kind === "snooze" ? (snoozeTo as number) : null });
  }
  return answers;
};

// Applied in the order they were pressed, each against the body the previous
// one left. That order is the point: snoozing twice with the app closed queues
// "05:30 → 05:40" then "05:40 → 05:50", and the second only finds its line
// because the first has already moved the stamp to 05:40.
//
// A line that no longer reads the way it did when the alarm was set — retitled,
// retimed, ticked on the laptop in the meantime — is left alone. The newer edit
// is the more deliberate one, and guessing which line was meant is how the
// wrong box gets ticked.
export const applyAnswers = (
  bodyOf: (path: string) => string | undefined,
  answers: readonly AlarmAnswer[],
): Map<string, string> => {
  const changed = new Map<string, string>();
  for (const answer of answers) {
    const body = changed.get(answer.path) ?? bodyOf(answer.path);
    if (body === undefined) continue;
    const ref = tasksIn(body, answer.path).find(
      (r) => !r.done && r.title === answer.title && r.remindAt === answer.at,
    );
    if (ref === undefined) continue;
    const next = answer.kind === "done"
      ? flipTask(body, ref)
      : setReminder(body, ref, answer.snoozeTo, true);
    if (next !== body) changed.set(answer.path, next);
  }
  return changed;
};
