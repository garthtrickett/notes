package com.garthtrickett.notes;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Widget")
public class WidgetPlugin extends Plugin {
    private static WidgetPlugin live;
    @Override public void load() { live = this; }
    @Override protected void handleOnDestroy() { if (live == this) live = null; }
    static boolean requestRefresh(String request) {
        if (live == null) return false;
        live.notifyListeners("syncRequested", new com.getcapacitor.JSObject().put("request", request), true);
        return true;
    }
    @PluginMethod public void syncFinished(PluginCall call) {
        VaultSyncSession.complete(call.getString("request"), Boolean.TRUE.equals(call.getBoolean("ok")));
        call.resolve();
    }
    @PluginMethod public void syncStatus(PluginCall call) {
        try {
            WidgetSyncStatus.update(getContext(), call.getString("vault"), call.getString("state"),
                call.getLong("checkedAt"), call.getLong("pulledAt"), System.currentTimeMillis());
            UrgeWidget.refresh(getContext());
            call.resolve();
        } catch (RuntimeException refused) {
            call.reject("Could not update the widget sync indicator.");
        }
    }
}
