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
import { Capacitor } from "@capacitor/core";
import { SLOTS } from "./checkins.ts";

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
