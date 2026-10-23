package com.garthtrickett.notes;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import java.util.UUID;
import org.json.JSONObject;

// A note tap can precede the WebView, login or the note's first sync. Keep the
// navigation request until the app has actually opened it; never call it Done.
final class AlarmNote {
    static final String ACTION = "com.garthtrickett.notes.OPEN_ALARM_NOTE";
    private static final String PREFS = "notes.alarm-note";
    private static final Object LOCK = new Object();

    static Intent intent(Context context, Alarms.Entry entry) {
        return entry.into(new Intent(context, MainActivity.class).setAction(ACTION))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }

    static boolean validPath(String path) {
        if (path == null || !path.endsWith(".md") || path.length() > 4096) return false;
        for (int i = 0; i < path.length(); i++) if (Character.isISOControl(path.charAt(i)) || path.charAt(i) == '\\') return false;
        for (String segment : path.split("/", -1))
            if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) return false;
        return !path.contains(":");
    }

    static void accept(Context context, Intent intent) {
        if (intent == null || !ACTION.equals(intent.getAction())) return;
        Alarms.Entry entry = Alarms.Entry.from(intent);
        if (entry == null || !validPath(entry.path)) return;
        synchronized (LOCK) {
            JSONObject request = new JSONObject();
            try {
                request.put("id", UUID.randomUUID().toString());
                request.put("path", entry.path);
            } catch (org.json.JSONException impossible) { throw new IllegalStateException(impossible); }
            if (!context.getSharedPreferences(PREFS, 0).edit().putString("pending", request.toString()).commit()) return;
            // Consume this intent so activity recreation cannot re-open an
            // already acknowledged request. The durable pending copy survives.
            intent.setAction(null);
        }
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel("notes-alarm", entry.id);
        AlarmActivity.close(entry.id);
        AlarmPlugin.announceNote();
    }

    static JSONObject pending(Context context) {
        synchronized (LOCK) {
            try { return new JSONObject(context.getSharedPreferences(PREFS, 0).getString("pending", "{}")); }
            catch (org.json.JSONException corrupt) { return new JSONObject(); }
        }
    }

    static void acknowledge(Context context, String id) {
        synchronized (LOCK) {
            if (id != null && id.equals(pending(context).optString("id")))
                context.getSharedPreferences(PREFS, 0).edit().remove("pending").commit();
        }
    }
}
