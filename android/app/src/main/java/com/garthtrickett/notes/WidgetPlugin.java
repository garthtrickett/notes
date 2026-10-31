package com.garthtrickett.notes;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Widget")
public class WidgetPlugin extends Plugin {
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
