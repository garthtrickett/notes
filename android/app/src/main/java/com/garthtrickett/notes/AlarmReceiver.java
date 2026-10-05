package com.garthtrickett.notes;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

// Everything that arrives as a broadcast: the alarm going off, Done and Snooze
// pressed on its notification, and the system events after which AlarmManager
// needs telling again. Not exported, so nothing outside the app can tick a
// task by sending it an intent; the system's own broadcasts still arrive.
public class AlarmReceiver extends BroadcastReceiver {
    private static final String EXACT_ALLOWED =
        "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;
        Context app = context.getApplicationContext();
        switch (action) {
            case Alarms.ACTION_FIRE: {
                Alarms.Entry e = Alarms.Entry.from(intent);
                if (e != null) Alarms.fire(app, e);
                return;
            }
            case Alarms.ACTION_DONE:
            case Alarms.ACTION_SNOOZE: {
                Alarms.Entry e = Alarms.Entry.from(intent);
                if (e == null) return;
                String kind = Alarms.ACTION_DONE.equals(action) ? "done" : "snooze";
                Alarms.answer(app, e, kind, System.currentTimeMillis());
                return;
            }
            case Intent.ACTION_BOOT_COMPLETED:
            case Intent.ACTION_MY_PACKAGE_REPLACED:
            case EXACT_ALLOWED:
                Alarms.restore(app);
                return;
        }
    }
}
