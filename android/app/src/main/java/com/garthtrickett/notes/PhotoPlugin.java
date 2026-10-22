package com.garthtrickett.notes;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Photos")
public class PhotoPlugin extends Plugin {
    @Override protected void handleOnNewIntent(Intent intent) {
        if (PhotoInbox.READY.equals(intent.getAction()))
            notifyListeners("photosShared", new JSObject(), true);
    }

    @PluginMethod public void pending(PluginCall call) {
        PhotoInbox.worker.execute(() -> { try {
            call.resolve(new JSObject().put("batches", new PhotoInbox(getContext()).pending()));
        } catch (Exception error) { call.reject("Could not read shared photos.", error); } });
    }

    @PluginMethod public void read(PluginCall call) {
        PhotoInbox.worker.execute(() -> { try {
            call.resolve(new PhotoInbox(getContext()).read(call.getString("id"), call.getString("key")));
        } catch (Exception error) { call.reject("Could not open the shared photo.", error); } });
    }

    @PluginMethod public void acknowledge(PluginCall call) {
        PhotoInbox.worker.execute(() -> { try {
            new PhotoInbox(getContext()).acknowledge(call.getString("id"));
            call.resolve();
        } catch (Exception error) { call.reject("Could not finish receiving photos.", error); } });
    }
}
