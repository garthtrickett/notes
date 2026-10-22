package com.garthtrickett.notes;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Lookup")
public class LookupPlugin extends Plugin {
    @Override protected void handleOnResume() {
        notifyListeners("lookupCaptured", new JSObject(), true);
    }

    @PluginMethod public void pending(PluginCall call) {
        LookupInbox.worker.execute(() -> { try {
            call.resolve(new JSObject().put("captures", new LookupInbox(getContext()).pending()));
        } catch (Exception error) { call.reject("Could not read saved questions.", error); } });
    }

    @PluginMethod public void acknowledge(PluginCall call) {
        LookupInbox.worker.execute(() -> { try {
            new LookupInbox(getContext()).acknowledge(call.getString("id"));
            call.resolve();
        } catch (Exception error) { call.reject("Could not finish saving the question.", error); } });
    }
}
