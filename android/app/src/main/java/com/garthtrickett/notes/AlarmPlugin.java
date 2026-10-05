package com.garthtrickett.notes;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.provider.AlarmClock;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Hands a reminder to the system clock, so it rings rather than merely
// notifying.
//
// ACTION_SET_ALARM takes an hour and a minute and nothing else — there is no
// date extra, and EXTRA_DAYS is weekdays for a repeating alarm, not a date.
// So the alarm always lands on the next occurrence of that time, which is why
// the caller may only ask for one inside the next 24 hours. Verified against
// AOSP's AlarmClock.java rather than assumed; ACTION_SET_TIMER is no help
// either, its EXTRA_LENGTH is documented as 1 to 86400 seconds.
//
// SKIP_UI is a request, not a guarantee: the docs say the clock app "may
// display intermediate UI like a confirmation dialog". So a tap may still be
// needed, and that is the clock app's call rather than a bug here.
@CapacitorPlugin(name = "Alarm")
public class AlarmPlugin extends Plugin {

    @PluginMethod
    public void set(PluginCall call) {
        Integer hour = call.getInt("hour");
        Integer minute = call.getInt("minute");
        String message = call.getString("message");

        if (hour == null || minute == null || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
            call.reject("An alarm needs an hour from 0-23 and a minute from 0-59.");
            return;
        }

        try {
            Intent intent = new Intent(AlarmClock.ACTION_SET_ALARM)
                .putExtra(AlarmClock.EXTRA_HOUR, hour.intValue())
                .putExtra(AlarmClock.EXTRA_MINUTES, minute.intValue())
                .putExtra(AlarmClock.EXTRA_MESSAGE, message == null || message.isEmpty() ? "Notes reminder" : message)
                .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
                // Starting an activity from outside one needs its own task.
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

            // Try it and catch the miss, rather than asking resolveActivity()
            // first. That pre-check is what broke this: under Android 11+
            // package visibility it returns null for any handler not declared
            // in <queries>, so it reported "no clock app" on a phone that had
            // one. Catching ActivityNotFoundException is Google's recommended
            // pattern for implicit intents and does not depend on visibility.
            try {
                getContext().startActivity(intent);
            } catch (ActivityNotFoundException e) {
                call.reject("No clock app on this phone will take an alarm.");
                return;
            }

            JSObject result = new JSObject();
            result.put("set", true);
            call.resolve(result);
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? "Could not set the alarm." : e.getMessage());
        }
    }
}
