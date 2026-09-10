// The daily check-in nudges, on a native shell. Everything here is behind
// Capacitor.isNativePlatform(): on the web — PWA included — this module loads
// but does nothing. A closed tab cannot wake a phone, and there is no web API
// that changes that, so attempting it would be worse than silence.
//
// On Android the OS delivers these: offline, app closed, phone locked. Tapping
// one opens the app, and onTap takes it the rest of the way to the dump.
//
// Inexact timing is deliberate. Exact alarms need an extra Play-store-flagged
// permission; a check-in that arrives a few minutes late is still a check-in.
// Dummy-commit anchor 3: versionCode 10 proved the fetch-based download on
// hardware; this no-op 11 proves the whole road end to end.
// Dummy-commit anchor 2: versionCode 8 proved the permission gate on hardware;
// this no-op 9 proves the whole road from banner to installer.
// Dummy-commit anchor 4: versionCode 12 proved the streamed download on
// hardware; this no-op 13 proves the banner goes quiet afterwards.
// Dummy-commit anchor 5: versionCode 14 moved the download into Java, where a
// release asset's missing CORS header cannot refuse it; this no-op 15 is the
// newer release that 14 needs before it will offer to update to anything.
// Dummy-commit anchor 6: 15 still hung on Downloading, which no timeout in the
// native path can explain; this no-op 16 is the target an emulator needs to
// reproduce the hang somewhere logcat can see it.
// Dummy-commit anchor 7: 17 carries the logcat tracing; this no-op 18 is the
// release it fetches while the trace is being read.
// Dummy-commit anchor 8: 19 stops awaiting the plugin proxy, which is the
// hang itself; this no-op 20 is what it finally downloads.
// Dummy-commit anchor 9: 21 is the first clean build after the tracing came
// out; this no-op 22 is what the sideloaded phone proves itself against.
import { Capacitor } from "@capacitor/core";
import { SLOTS } from "./checkins.ts";
import type { TaskRef } from "./tasks.ts";

export const syncCheckinNotifications = async (
  onTap: () => void,
): Promise<void> => {
  if (!Capacitor.isNativePlatform()) return;
  const { LocalNotifications } = await import("@capacitor/local-notifications");
  const permission = await LocalNotifications.requestPermissions();
  if (permission.display !== "granted") return;
  // Rescheduled from scratch on every boot. Idempotent, and a changed slot
  // time can never strand a stale alarm firing at the old one.
  const pending = await LocalNotifications.getPending();
  const ours = pending.notifications.filter(
    (n) => n.id >= 1 && n.id <= SLOTS.length,
  );
  if (ours.length > 0) {
    await LocalNotifications.cancel({
      notifications: ours.map((n) => ({ id: n.id })),
    });
  }
  await LocalNotifications.schedule({
    notifications: SLOTS.map((slot, index) => ({
      id: index + 1,
      title: "Email + Slack check-in",
      body: `${slot.label} — inbox zero, then Slack.`,
      schedule: {
        on: { hour: slot.hour, minute: slot.minute },
        allowWhileIdle: true,
      },
      autoCancel: true,
      extra: { checkin: slot.id },
    })),
  });
  await LocalNotifications.addListener(
    "localNotificationActionPerformed",
    onTap,
  );
};

// Task reminders live above the check-ins' id range, so each can be cancelled
// and rebuilt without touching the other. `getPending` is the only way to find
// out what we scheduled in a previous run of the app, and it only reports ids.
// The web has no scheduled notification without a server to push from, so the
// loop skips the whole reminder scan there rather than building a set nobody
// can deliver.
export const remindersDeliverable = (): boolean => Capacitor.isNativePlatform();

const TASK_ID_FLOOR = 1000;
const TASK_ID_CEILING = 2_000_000_000;

// A stable id for a task, from the only two things that identify one: the file
// it lives in and what it says. Renaming the task cancels the old reminder and
// schedules a new one, which is the honest reading of "it is a different task
// now". A collision costs one reminder, and cannot corrupt anything, because
// the whole set is rebuilt from the notes on every sync.
export const reminderId = (ref: Pick<TaskRef, "path" | "title">): number => {
  let h = 2166136261;
  for (const ch of `${ref.path}\u0000${ref.title}`) {
    h ^= ch.codePointAt(0) as number;
    h = Math.imul(h, 16777619);
  }
  return TASK_ID_FLOOR + (Math.abs(h) % (TASK_ID_CEILING - TASK_ID_FLOOR));
};

// Which reminders the OS should be holding right now: open tasks, with a time,
// still in the future. A done task is not a reminder, and a time that has
// already passed would be delivered the instant it was scheduled — an alarm for
// something you were reminded about yesterday, every time you open the app.
export const dueReminders = (
  refs: readonly TaskRef[],
  now: number,
): TaskRef[] =>
  refs.filter((r) => !r.done && r.remindAt !== null && r.remindAt > now);

// Rebuilt from scratch, like the check-ins: cancel every task reminder the OS
// is holding, then schedule the current set. Idempotent, and a task that was
// ticked off or retimed on another device cannot strand an alarm.
// Answers whether it actually rebuilt anything, because the caller caches the
// set it last delivered. Permission is asked for once, by the check-ins, on
// boot — so an early call here lands before the answer and must say so rather
// than let the caller record a set the OS never received.
export const syncTaskReminders = async (
  refs: readonly TaskRef[],
  now: number,
): Promise<boolean> => {
  if (!Capacitor.isNativePlatform()) return false;
  const { LocalNotifications } = await import("@capacitor/local-notifications");
  const permission = await LocalNotifications.checkPermissions();
  if (permission.display !== "granted") return false;

  const pending = await LocalNotifications.getPending();
  const ours = pending.notifications.filter((n) => n.id >= TASK_ID_FLOOR);
  if (ours.length > 0) {
    await LocalNotifications.cancel({
      notifications: ours.map((n) => ({ id: n.id })),
    });
  }

  const due = dueReminders(refs, now);
  if (due.length === 0) return true;
  await LocalNotifications.schedule({
    notifications: due.map((ref) => ({
      id: reminderId(ref),
      title: ref.title,
      body: ref.path,
      schedule: { at: new Date(ref.remindAt as number), allowWhileIdle: true },
      autoCancel: true,
      extra: { task: ref.path },
    })),
  });
  return true;
};
