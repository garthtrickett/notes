package com.garthtrickett.notes;

import android.content.Context;
import android.content.SharedPreferences;
import android.text.format.DateFormat;
import android.util.Log;
import java.util.Map;
import java.util.Arrays;
import java.util.List;

/** A private last-known view of note sync, never another outbox or sync worker. */
final class WidgetSyncStatus {
    private static final String PREFS = "widget-sync-status";
    static final long FRESH_MS = 30 * 60_000L;
    private static final long WORKING_MS = 5 * 60_000L;
    private static final List<String> STATES = Arrays.asList("unknown", "pending", "syncing", "synced", "offline", "error");

    static final class Display {
        final String text;
        final int color;
        Display(String text, int color) { this.text = text; this.color = color; }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // A launch without a completed check preserves the old observation only
    // for the same vault. No credentials or note contents cross this bridge.
    static synchronized void update(Context context, String vault, String state, Long checkedAt, Long pulledAt, long now) {
        if (("synced".equals(state) && (checkedAt == null || checkedAt <= 0))
                || vault == null || vault.length() > 1024 || !STATES.contains(state == null ? "" : state)
                || (checkedAt != null && (checkedAt < 0 || checkedAt > now + 60_000L))
                || (pulledAt != null && (pulledAt < 0 || pulledAt > now + 60_000L)))
            throw new IllegalArgumentException("Invalid widget sync report");
        SharedPreferences p = prefs(context);
        boolean same = vault.equals(p.getString("vault", null));
        long verified = checkedAt == null ? (same ? p.getLong("checkedAt", 0) : 0) : checkedAt;
        long remote = same ? p.getLong("remoteChangedAt", 0) : 0;
        if ("synced".equals(state) && pulledAt != null && pulledAt >= remote) remote = 0;
        if (!p.edit().putString("vault", vault).putString("state", state)
                .putLong("checkedAt", verified).putLong("reportedAt", now)
                .putLong("remoteChangedAt", remote).commit())
            throw new IllegalStateException("Could not save widget sync report");
    }

    // The alarm-only background reader can notice newer notes, but cannot
    // claim they are in the WebView vault or turn this indicator green.
    static void remoteChanged(Context context, String vault, long now) {
        try {
            synchronized (WidgetSyncStatus.class) {
                SharedPreferences p = prefs(context);
                if (!vault.equals(p.getString("vault", null))) return;
                if (!p.edit().putLong("remoteChangedAt", Math.max(now, p.getLong("remoteChangedAt", 0))).commit())
                    Log.w("WidgetSyncStatus", "Could not record newer notes for the widget");
            }
        } catch (RuntimeException unavailable) {
            // An optional indicator cannot interrupt the background alarm read.
            Log.w("WidgetSyncStatus", "Could not update the widget sync indicator");
            return;
        }
        UrgeWidget.refresh(context);
    }

    static Display display(Context context, long now) {
        final int green = 0xFF246B40, amber = 0xFF805800, red = 0xFF9A2929, grey = 0xFF496359;
        try {
            Map<String, ?> saved = prefs(context).getAll();
            String state = saved.get("state") instanceof String ? (String) saved.get("state") : "unknown";
            long checked = number(saved, "checkedAt"), reported = number(saved, "reportedAt");
            if ("error".equals(state)) return new Display("! Sync problem · open Notes", red);
            boolean queued = new LookupInbox(context).hasPending() || new PhotoInbox(context).hasPending()
                || Alarms.hasPendingAnswers(context);
            if (queued || "pending".equals(state)) return new Display("↑ Waiting to sync", amber);
            if ("offline".equals(state)) return new Display("Offline · open Notes to sync", grey);
            if ("syncing".equals(state) && recent(reported, now, WORKING_MS))
                return new Display("↻ Syncing · " + when(reported, now), amber);
            if (number(saved, "remoteChangedAt") > 0) return new Display("↓ New notes · open to sync", amber);
            String when = checked > 0 && checked <= now ? when(checked, now) : null;
            if ("synced".equals(state) && when != null && recent(checked, now, FRESH_MS))
                return new Display("✓ Synced · " + when, green);
            return new Display(when == null ? "Open Notes to check sync" : "Last synced · " + when, grey);
        } catch (RuntimeException unreadable) {
            return new Display("! Sync unavailable · open Notes", red);
        }
    }

    private static String when(long at, long now) {
        boolean today = DateFormat.format("yyyyMMdd", at).toString().equals(DateFormat.format("yyyyMMdd", now).toString());
        return DateFormat.format(today ? "HH:mm" : "dd/MM/yy HH:mm", at).toString();
    }

    private static long number(Map<String, ?> values, String key) {
        Object value = values.get(key);
        return value instanceof Long ? (Long) value : 0;
    }
    private static boolean recent(long at, long now, long limit) {
        return at > 0 && now >= at && now - at < limit;
    }
}
