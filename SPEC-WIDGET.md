# Home-screen widget

The Back to my day widget provides Eating, Lookup later, Note down, Resisted
and Undo without needing the Notes WebView to be running. Its existing local
count, eating state and capture destinations remain unchanged.

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
