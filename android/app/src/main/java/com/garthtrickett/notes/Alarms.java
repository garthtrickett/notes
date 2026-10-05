package com.garthtrickett.notes;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

// The app's own alarms, end to end: scheduling, ringing, and remembering what
// was pressed.
//
// The notes decide what the alarms should be; the app hands over the whole set
// whenever it changes and this works out the difference. What it has to keep
// for itself is only what must survive the app not running: the set (so a
// reboot can put it back), a snooze not yet written into the note (so a stale
// set from the app cannot cancel it), and the Done and Snooze presses the app
// has not yet read.
final class Alarms {
    static final String ACTION_FIRE = "com.garthtrickett.notes.alarm.FIRE";
    static final String ACTION_DONE = "com.garthtrickett.notes.alarm.DONE";
    static final String ACTION_SNOOZE = "com.garthtrickett.notes.alarm.SNOOZE";

    static final long SNOOZE_MS = 10 * 60 * 1000L;
    // An alarm nobody answers stops on its own rather than ringing until the
    // battery dies. The task is left as it was.
    static final long RING_MS = 10 * 60 * 1000L;

    private static final String CHANNEL = "alarms";
    private static final String TAG = "notes-alarm";
    private static final String PREFS = "notes.alarms";
    private static final String ALARMS = "alarms";
    private static final String SNOOZES = "snoozes";
    private static final String ANSWERS = "answers";
    private static final Object LOCK = new Object();

    private Alarms() {}

    static final class Entry {
        final int id;
        // When it rings.
        final long at;
        final String title;
        final String path;
        // The stamp on the task's line, which is how the app finds the line
        // again. The same as `at` except for a repeating task's snooze, which
        // rings later while the line keeps its time.
        final long stamp;
        final boolean repeat;

        Entry(int id, long at, String title, String path, long stamp, boolean repeat) {
            this.id = id;
            this.at = at;
            this.title = title;
            this.path = path;
            this.stamp = stamp;
            this.repeat = repeat;
        }

        static Entry fromJson(JSONObject o) throws JSONException {
            long at = o.getLong("at");
            return new Entry(
                o.getInt("id"), at, o.optString("title", ""), o.optString("path", ""),
                o.optLong("stamp", at), o.optBoolean("repeat", false));
        }

        JSONObject toJson() throws JSONException {
            return new JSONObject().put("id", id).put("at", at).put("title", title).put("path", path)
                .put("stamp", stamp).put("repeat", repeat);
        }

        Intent into(Intent intent) {
            return intent.putExtra("id", id).putExtra("at", at).putExtra("title", title).putExtra("path", path)
                .putExtra("stamp", stamp).putExtra("repeat", repeat);
        }

        static Entry from(Intent intent) {
            if (intent == null || !intent.hasExtra("id") || !intent.hasExtra("at")) return null;
            String title = intent.getStringExtra("title");
            String path = intent.getStringExtra("path");
            long at = intent.getLongExtra("at", 0L);
            return new Entry(
                intent.getIntExtra("id", 0),
                at,
                title == null ? "" : title,
                path == null ? "" : path,
                intent.getLongExtra("stamp", at),
                intent.getBooleanExtra("repeat", false)
            );
        }
    }

    // ---- what the app asks for ----

    // Replaces the whole set. Anything held that the app no longer wants is
    // cancelled; everything it does want is (re)scheduled, which replaces any
    // earlier alarm with the same id rather than adding a second.
    static int sync(Context context, JSONArray incoming, JSONArray live, long now) throws JSONException {
        synchronized (LOCK) {
            Map<Integer, Entry> wanted = new LinkedHashMap<>();
            for (int i = 0; i < incoming.length(); i++) {
                Entry e = Entry.fromJson(incoming.getJSONObject(i));
                if (e.at > now) wanted.put(e.id, e);
            }
            Map<Integer, Long> stamps = new HashMap<>();
            for (int i = 0; i < live.length(); i++) {
                JSONObject o = live.getJSONObject(i);
                stamps.put(o.getInt("id"), o.getLong("stamp"));
            }
            // A snooze wins over whatever the app sent for that task. Until the
            // app has read the press and moved the stamp, the note still says
            // the old time, and obeying that would silently drop the snooze.
            //
            // A repeating task's snooze never moves the stamp, so it is kept
            // for exactly as long as the task still carries the stamp it rang
            // for. Ticked, retimed or rolled on, and it is dropped. It cannot
            // collide with the task's own next alarm, which is always later
            // than a stamp that has already rung.
            List<Entry> snoozes = new ArrayList<>();
            for (Entry s : read(context, SNOOZES)) {
                Long stamp = stamps.get(s.id);
                boolean held = !s.repeat || (stamp != null && stamp == s.stamp);
                if (s.at > now && held) {
                    wanted.put(s.id, s);
                    snoozes.add(s);
                }
            }
            write(context, SNOOZES, snoozes);
            for (Entry old : read(context, ALARMS)) {
                if (!wanted.containsKey(old.id)) cancel(context, old.id);
            }
            List<Entry> kept = new ArrayList<>(wanted.values());
            for (Entry e : kept) schedule(context, e);
            write(context, ALARMS, kept);
            return kept.size();
        }
    }

    // Done and Snooze presses since the app last asked. Taking them is the
    // app's promise to write them into the notes, so the snoozes they protect
    // are released too: the next set the app sends already has the new stamp.
    // A repeating task's snooze is not written into the note, so it stays.
    static JSONArray take(Context context) {
        synchronized (LOCK) {
            JSONArray answers = readArray(context, ANSWERS);
            List<Entry> held = new ArrayList<>();
            for (Entry s : read(context, SNOOZES)) if (s.repeat) held.add(s);
            prefs(context).edit().remove(ANSWERS).apply();
            write(context, SNOOZES, held);
            return answers;
        }
    }

    // After a reboot, an app update, or exact alarms being allowed: AlarmManager
    // forgot or downgraded what it held, and the app may not run for days.
    static void restore(Context context) {
        synchronized (LOCK) {
            long now = System.currentTimeMillis();
            List<Entry> kept = new ArrayList<>();
            for (Entry e : read(context, ALARMS)) {
                if (e.at > now) {
                    schedule(context, e);
                    kept.add(e);
                }
            }
            write(context, ALARMS, kept);
        }
    }

    static boolean canExact(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager am = context.getSystemService(AlarmManager.class);
        return am != null && am.canScheduleExactAlarms();
    }

    static boolean canFullScreen(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        return nm != null && nm.canUseFullScreenIntent();
    }

    static boolean canNotify(Context context) {
        return NotificationManagerCompat.from(context).areNotificationsEnabled();
    }

    // ---- AlarmManager ----

    private static PendingIntent firing(Context context, Entry e, int flags) {
        Intent intent = new Intent(context, AlarmReceiver.class).setAction(ACTION_FIRE);
        if (e != null) e.into(intent);
        return PendingIntent.getBroadcast(context, e == null ? 0 : e.id, intent, flags | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void schedule(Context context, Entry e) {
        AlarmManager am = context.getSystemService(AlarmManager.class);
        if (am == null) return;
        PendingIntent fire = firing(context, e, PendingIntent.FLAG_UPDATE_CURRENT);
        if (canExact(context)) {
            try {
                // The alarm-clock kind: exact, allowed to wake the phone from
                // doze, and shown in the status bar as the next alarm.
                Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                PendingIntent show = PendingIntent.getActivity(
                    context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                am.setAlarmClock(new AlarmManager.AlarmClockInfo(e.at, show), fire);
                return;
            } catch (SecurityException revoked) {
                // Exact alarms were turned off between the check and the call.
            }
        }
        // Late is better than never. The app says so, from status().
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, e.at, fire);
    }

    private static void cancel(Context context, int id) {
        AlarmManager am = context.getSystemService(AlarmManager.class);
        Intent intent = new Intent(context, AlarmReceiver.class).setAction(ACTION_FIRE);
        PendingIntent fire = PendingIntent.getBroadcast(
            context, id, intent, PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
        if (fire == null) return;
        if (am != null) am.cancel(fire);
        fire.cancel();
    }

    // ---- ringing ----

    static void fire(Context context, Entry e) {
        synchronized (LOCK) {
            remove(context, ALARMS, e.id);
            remove(context, SNOOZES, e.id);
        }
        ring(context, e);
    }

    private static Uri sound() {
        Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        return uri;
    }

    private static final long[] BUZZ = {0, 800, 600};

    private static void channel(NotificationManager nm) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel c = new NotificationChannel(CHANNEL, "Alarms", NotificationManager.IMPORTANCE_HIGH);
        c.setDescription("Tasks flagged with ! ring here until Done or Snooze.");
        // USAGE_ALARM is what puts this on the alarm volume, rings through
        // silent mode, and lets Do Not Disturb treat it as an alarm.
        c.setSound(sound(), new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build());
        c.enableVibration(true);
        c.setVibrationPattern(BUZZ);
        c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        c.setBypassDnd(true);
        nm.createNotificationChannel(c);
    }

    private static PendingIntent answering(Context context, Entry e, String action) {
        Intent intent = e.into(new Intent(context, AlarmReceiver.class).setAction(action));
        return PendingIntent.getBroadcast(
            context, e.id, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // One notification does all the ringing. Its full-screen intent raises the
    // alarm screen over the lock screen; with the phone in use Android shows it
    // as a heads-up instead, with the same two buttons. The sound belongs to the
    // notification rather than the screen so it rings either way, and
    // FLAG_INSISTENT repeats it until the notification is answered or times out.
    @SuppressWarnings("deprecation")
    private static void ring(Context context, Entry e) {
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null) return;
        channel(nm);
        Intent screen = e.into(new Intent(context, AlarmActivity.class))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        PendingIntent show = PendingIntent.getActivity(
            context, e.id, screen, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle(e.title.isEmpty() ? "Notes alarm" : e.title)
            .setContentText(e.path)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setTimeoutAfter(RING_MS)
            .setContentIntent(show)
            .setFullScreenIntent(show, true)
            // Below Android 8 there are no channels, so the sound goes here.
            .setSound(sound(), AudioManager.STREAM_ALARM)
            .setVibrate(BUZZ)
            .addAction(0, "Done", answering(context, e, ACTION_DONE))
            .addAction(0, "Snooze 10", answering(context, e, ACTION_SNOOZE))
            .build();
        n.flags |= Notification.FLAG_INSISTENT;
        try {
            nm.notify(TAG, e.id, n);
        } catch (SecurityException denied) {
            // Notification permission refused. Nothing can ring; status()
            // reports it to the app, which says so.
        }
    }

    // ---- answering ----

    // Done or Snooze, from the screen or the notification. Stops the ringing,
    // writes the press down for the app, and for a snooze sets the next alarm
    // here and now, so it rings again in ten minutes even if the app never runs.
    static void answer(Context context, Entry e, String kind, long now) {
        NotificationManagerCompat.from(context).cancel(TAG, e.id);
        synchronized (LOCK) {
            remove(context, ALARMS, e.id);
            remove(context, SNOOZES, e.id);
            try {
                JSONObject press = new JSONObject()
                    .put("kind", kind)
                    .put("id", e.id)
                    .put("path", e.path)
                    .put("title", e.title)
                    .put("at", e.stamp);
                if ("snooze".equals(kind)) {
                    // Whole minutes, because the note's stamp is whole minutes.
                    // The app writes exactly this instant back, so the alarm
                    // set here and the one the note asks for agree.
                    long to = ((now + SNOOZE_MS) / 60_000L) * 60_000L;
                    Entry snoozed = new Entry(e.id, to, e.title, e.path, e.repeat ? e.stamp : to, e.repeat);
                    add(context, SNOOZES, snoozed);
                    add(context, ALARMS, snoozed);
                    schedule(context, snoozed);
                    press.put("snoozeTo", to);
                }
                JSONArray answers = readArray(context, ANSWERS);
                answers.put(press);
                prefs(context).edit().putString(ANSWERS, answers.toString()).apply();
            } catch (JSONException impossible) {
                // put() only throws for non-finite doubles; there are none here.
            }
        }
        AlarmActivity.close(e.id);
        AlarmPlugin.announce();
    }

    // ---- storage ----

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static JSONArray readArray(Context context, String key) {
        try {
            return new JSONArray(prefs(context).getString(key, "[]"));
        } catch (JSONException corrupt) {
            return new JSONArray();
        }
    }

    private static List<Entry> read(Context context, String key) {
        List<Entry> entries = new ArrayList<>();
        JSONArray raw = readArray(context, key);
        for (int i = 0; i < raw.length(); i++) {
            try {
                entries.add(Entry.fromJson(raw.getJSONObject(i)));
            } catch (JSONException corrupt) {
                // One bad entry costs one alarm, not the set.
            }
        }
        return entries;
    }

    private static void write(Context context, String key, List<Entry> entries) {
        JSONArray raw = new JSONArray();
        for (Entry e : entries) {
            try {
                raw.put(e.toJson());
            } catch (JSONException impossible) {
                // See answer().
            }
        }
        prefs(context).edit().putString(key, raw.toString()).apply();
    }

    private static void remove(Context context, String key, int id) {
        List<Entry> entries = read(context, key);
        List<Entry> kept = new ArrayList<>();
        for (Entry e : entries) if (e.id != id) kept.add(e);
        if (kept.size() != entries.size()) write(context, key, kept);
    }

    private static void add(Context context, String key, Entry entry) {
        List<Entry> entries = read(context, key);
        List<Entry> kept = new ArrayList<>();
        for (Entry e : entries) if (e.id != entry.id) kept.add(e);
        kept.add(entry);
        write(context, key, kept);
    }
}
