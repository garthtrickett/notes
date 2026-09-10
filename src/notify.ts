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
// Android hands the set to the OS, which delivers it with the app closed. The
// web arms timers in the page, which delivers it with a tab open and not
// otherwise — see syncWebReminders for why that is the ceiling rather than a
// shortcut. Either way there is something worth computing the set for.
export const remindersDeliverable = (): boolean =>
  Capacitor.isNativePlatform() || typeof Notification === "function";

// Asked for at the moment a reminder is set, which is a gesture, rather than on
// boot — a permission prompt nobody asked for is the fastest way to have it
// denied for good.
export const askToRemind = async (): Promise<boolean> => {
  if (Capacitor.isNativePlatform()) return true;
  if (typeof Notification !== "function") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
};

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

// The web half, and the honest shape of it.
//
// There is no server here and none is needed: a page can call
// registration.showNotification whenever it likes. What the web cannot do is
// wake code at a chosen minute with everything closed. Notification Triggers
// (TimestampTrigger) was the API for exactly that and never shipped —
// undefined in Chrome 152, measured, not remembered. periodicSync can wake a
// service worker but at the browser's discretion, hours wide, which is not a
// reminder. Push can wake one at any moment, and that is the part that needs a
// server to do the pushing.
//
// So: timers in the page, which fire while a tab is open. That is a real
// capability worth having on a laptop that sits open all day, and it is
// strictly less than what Android gives. Nothing pretends otherwise.
let timers: ReturnType<typeof setTimeout>[] = [];

// setTimeout tops out at a signed 32-bit millisecond delay — about 24.8 days —
// and silently fires immediately if given more. Anything further out is left
// unarmed rather than fired now; the app will arm it on a later visit, and a
// tab that has been open for 25 days is not the case to design around.
const MAX_DELAY = 2_147_483_647;

// Separated from the arming so the rule can be checked without a clock: a
// delay past MAX_DELAY overflows setTimeout's signed 32-bit argument and fires
// *immediately* rather than late, which would turn a reminder for next year
// into an alarm the moment you open the tab.
export const armableReminders = (
  refs: readonly TaskRef[],
  now: number,
): TaskRef[] =>
  dueReminders(refs, now).filter((r) => (r.remindAt as number) - now <= MAX_DELAY);

const showOne = async (ref: TaskRef): Promise<void> => {
  const reg = await navigator.serviceWorker?.getRegistration();
  const options = { body: ref.path, tag: `task-${reminderId(ref)}`, requireInteraction: false };
  // Through the service worker where there is one: it is the only route that
  // works on Android Chrome, and it is what makes a tap able to focus the tab
  // rather than open a second copy.
  if (reg) await reg.showNotification(ref.title, options);
  else new Notification(ref.title, options);
};

export const clearWebReminders = (): void => {
  for (const t of timers) clearTimeout(t);
  timers = [];
};

export const syncWebReminders = (
  refs: readonly TaskRef[],
  now: number,
): boolean => {
  if (Capacitor.isNativePlatform()) return false;
  if (typeof Notification !== "function") return false;
  // Not granted yet is not a failure to record — say undelivered so the caller
  // asks again once the answer arrives.
  if (Notification.permission !== "granted") return false;

  clearWebReminders();
  for (const ref of armableReminders(refs, now)) {
    timers.push(setTimeout(() => void showOne(ref), (ref.remindAt as number) - now));
  }
  return true;
};
