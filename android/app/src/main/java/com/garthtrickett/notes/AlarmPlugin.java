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
