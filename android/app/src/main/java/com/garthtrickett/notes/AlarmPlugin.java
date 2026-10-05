package com.garthtrickett.notes;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONException;

// The bridge to Alarms. The app hands over the set it wants and collects the
// Done and Snooze presses made while it was away; everything else happens
// natively, because an alarm has to ring with the app closed.
@CapacitorPlugin(name = "Alarm")
public class AlarmPlugin extends Plugin {
    private static volatile AlarmPlugin live;

    @Override
    public void load() {
        live = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (live == this) live = null;
    }

    // Answers with how many are set and which settings stand in the way of
    // them ringing properly, so the app can say which one to turn on.
    @PluginMethod
    public void sync(PluginCall call) {
        JSArray alarms = call.getArray("alarms");
        if (alarms == null) {
            call.reject("No alarms were given.");
            return;
        }
        int scheduled;
        try {
            // Absent from an app older than this plugin, which sent no repeats.
            JSArray live = call.getArray("live", new JSArray());
            scheduled = Alarms.sync(getContext(), alarms, live, System.currentTimeMillis());
            // What the app already has, so the background job only fetches
            // notes that changed after this.
            JSObject shas = call.getObject("shas");
            if (shas != null) VaultWatch.seed(getContext(), shas);
        } catch (JSONException e) {
            call.reject("An alarm could not be read: " + e.getMessage());
            return;
        }
        JSObject result = new JSObject();
        result.put("scheduled", scheduled);
        result.put("exact", Alarms.canExact(getContext()));
        result.put("fullScreen", Alarms.canFullScreen(getContext()));
        result.put("notifications", Alarms.canNotify(getContext()));
        call.resolve(result);
    }

    // The vault settings for the background job, which keeps alarms current
    // while the app is closed. Idempotent: a job already scheduled is left on
    // its own timetable rather than restarted on every launch.
    @PluginMethod
    public void watch(PluginCall call) {
        String owner = call.getString("owner");
        String repo = call.getString("repo");
        String branch = call.getString("branch");
        String token = call.getString("token");
        if (owner == null || repo == null || branch == null || token == null) {
            call.reject("The vault settings are incomplete.");
            return;
        }
        VaultWatch.configure(getContext(), owner, repo, branch, token);
        call.resolve();
    }

    @PluginMethod
    public void take(PluginCall call) {
        JSObject result = new JSObject();
        result.put("answers", Alarms.take(getContext()));
        call.resolve(result);
    }

    // A press while the app is alive behind the alarm screen. The app takes
    // the answers itself; this only tells it there is something to take.
    static void announce() {
        AlarmPlugin plugin = live;
        if (plugin != null) plugin.notifyListeners("answered", new JSObject());
    }
}
