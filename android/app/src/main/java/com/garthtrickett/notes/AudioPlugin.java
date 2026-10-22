package com.garthtrickett.notes;

import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Audio")
public class AudioPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private AudioRuntime runtime;
    private volatile boolean destroyed;
    private final AudioRuntime.Listener listener = snapshot -> {
        if (!destroyed && hasListeners("audioState")) notifyListeners("audioState", AudioWire.snapshot(snapshot));
    };

    // Lazy connection: loading Notes never scans files or starts playback.
    // Subscribe before resolving the handshake, all on the native owner thread.
    private void connected(PluginCall call, boolean refresh) {
        main.post(() -> {
            if (destroyed) { call.reject("The audio connection has closed."); return; }
            try {
                if (runtime == null) {
                    runtime = AudioRuntime.get(getContext());
                    runtime.subscribe(listener);
                }
                if (refresh) runtime.refresh();
                call.resolve(AudioWire.snapshot(runtime.snapshot()));
            } catch (Exception error) { call.reject("Could not read native audio state.", error); }
        });
    }
    @PluginMethod public void audioSnapshot(PluginCall call) { connected(call, false); }
    @PluginMethod public void audioRefresh(PluginCall call) { connected(call, true); }

    @Override protected void handleOnDestroy() {
        destroyed = true;
        main.post(() -> {
            if (runtime != null) { runtime.unsubscribe(listener); runtime = null; }
        });
        // The process service and checkpoint writer outlive this WebView.
        super.handleOnDestroy();
    }

    @PluginMethod public void openStorageTest(PluginCall call) {
        main.post(() -> { try {
            if (destroyed) { call.reject("The audio connection has closed."); return; }
            getActivity().startActivity(new Intent(getContext(), AudioStorageTestActivity.class));
            call.resolve();
        } catch (Exception error) { call.reject("Could not open the audio storage test.", error); } });
    }
}
