# Home-screen widget

The Back to my day widget provides Eating, Lookup later, Note down, Resisted
and Undo without needing the Notes WebView to be running. Its existing local
count, eating state and capture destinations remain unchanged.

## Note sync status

A compact status beneath the widget heading reports the note vault's last-known
sync state. Tapping the header opens Notes, whose normal resume/sync path runs.
This does not start a separate sync service or add a notification.

- A green tick includes the last successful observation's time (and date when
  needed). An initial
  pull must finish, imported records must be saved, and outgoing changes must
  upload before the app reports synced. A pull-start watermark is not success.
- Waiting, syncing, offline and error states use text and symbols as well as
  colour. The status bridge contains only a state, time and private vault key;
  no note text or credentials are included. Failed status writes never prevent
  ordinary persistence, sync or alarm handling.
- Saved widget captures, pending shared photos and queued alarm answers override
  an older clean report. The background alarm reader can flag newer notes, but
  cannot assert that the WebView's note vault has imported them. Only a completed
  full pull newer than that discovery clears this flag; a later upload or cheap
  head check alone does not.
- At the next widget refresh, a successful observation older than 30 minutes
  becomes grey `Last synced`; an interrupted `Syncing` report expires after five
  minutes. Android may delay the existing periodic widget refresh, so the
  displayed timestamp remains the useful freshness reference between updates.
- Reports survive process death/reboot and are scoped to the configured vault.
  Changing vaults cannot reuse another vault's green state. This indicator is
  about notes, not SFTP media delivery or the local eating/resisted counters.

Host checks cover outbox/save/error transitions, serialized bridge writes,
pending native queues, stale/clock-change handling, opening Notes from the
header, minimum widget sizes and the existing off-thread inflation regression.
Physical Pixel launcher/display qualification remains a separate device check.

## Background inflation

Launchers can inflate the initial layout and published RemoteViews on a worker
thread without a Looper. Every widget button must explicitly disable the
framework state-list animator. The buttons retain their existing backgrounds,
text, accessibility descriptions and enabled/click behaviour.

On a Pixel 7a running Android 17/API 37 with Notes 1.0.81, reloading Pixel
Launcher reproduced `Can't load widget`. The captured failure was an
`InflateException` constructing the initially disabled Undo button, caused by
`Animators may only be run on Looper threads`. Opening Notes and refreshing
the widget did not repair that layout-construction failure. Disabling an
animator after inflation would be too late; it must be disabled in the XML.

`WidgetBackgroundInflationTest` covers initial layout construction and complete
RemoteViews application on a worker without a Looper, including both Undo
states. Existing widget tests continue to cover counters, eating, capture
actions, sizing, reboot/update refresh and launcher error-view recovery.

Device qualification must retain the existing widget and app data, install a
signed upgrade, reload the launcher and inspect the rendered controls and
fresh logs. Reboot qualification additionally requires unlocking the phone
before checking the widget, because its preferences use credential-protected
storage. Host tests are not a substitute for those device checks.
