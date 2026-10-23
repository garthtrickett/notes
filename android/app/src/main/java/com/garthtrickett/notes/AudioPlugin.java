package com.garthtrickett.notes;

import android.content.Intent;
import android.app.Activity;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.annotation.ActivityCallback;
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

    private AudioRuntime runtime() {
        if (runtime == null) { runtime = AudioRuntime.get(getContext()); runtime.subscribe(listener); }
        return runtime;
    }
    private void result(PluginCall call, AudioProblem failure) {
        call.resolve(new JSObject().put("snapshot", AudioWire.snapshot(runtime().snapshot()))
            .put("failure", failure == null ? org.json.JSONObject.NULL : new JSObject()
                .put("kind", failure.kind.name()).put("message", failure.getMessage())));
    }
    private AudioRuntime.Reply reply(PluginCall call) { return (op, durable, failure) -> result(call, failure); }
    private long integer(PluginCall call, String key) throws AudioProblem {
        Object value = call.getData().opt(key);
        if (!(value instanceof Integer) && !(value instanceof Long)) throw new AudioProblem(AudioProblem.Kind.STALE, "Invalid audio command number.");
        long result = ((Number) value).longValue();
        if (result < 0 || result > 9007199254740991L) throw new AudioProblem(AudioProblem.Kind.STALE, "Invalid audio command number.");
        return result;
    }
    private void scope(PluginCall call) throws AudioProblem {
        if (!runtime().epoch.equals(call.getString("epoch")) ||
            runtime().snapshot().ledger.rootGeneration != integer(call, "rootGeneration"))
            throw new AudioProblem(AudioProblem.Kind.STALE, "The audio library changed. Refresh and try again.");
    }
    private AudioCatalog.Target target(PluginCall call) throws AudioProblem {
        scope(call);
        String item = call.getString("item"), version = call.getString("version");
        if (item == null || version == null) throw new AudioProblem(AudioProblem.Kind.STALE, "Select a current download.");
        return new AudioCatalog.Target(runtime().epoch, runtime().snapshot().ledger.rootGeneration, item, version);
    }
    @PluginMethod public void audioChooseFolder(PluginCall call) {
        main.post(() -> { try {
            if (destroyed) { call.reject("The audio connection has closed."); return; }
            runtime().library.available(); scope(call);
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION |
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
            startActivityForResult(call, intent, "folderChosen");
        } catch (Exception error) { result(call, AudioProblem.from(error)); } });
    }
    @ActivityCallback private void folderChosen(PluginCall call, ActivityResult chosen) {
        if (call == null) return;
        if (destroyed) { call.reject("The audio connection has closed."); return; }
        if (chosen.getResultCode() != Activity.RESULT_OK || chosen.getData() == null || chosen.getData().getData() == null) { result(call, null); return; }
        if (DeliveryRunner.running()) { result(call, new AudioProblem(AudioProblem.Kind.STORAGE, "Pause media downloads before changing folders.")); return; }
        int flags = chosen.getData().getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        runtime().library.bind(chosen.getData().getData(), flags, reply(call));
    }
    @PluginMethod public void audioPrepareDelete(PluginCall call) {
        main.post(() -> { try {
            if (destroyed) { call.reject("The audio connection has closed."); return; }
            runtime().library.prepare(target(call), (confirmation, failure) -> {
                JSObject value = new JSObject();
                if (confirmation != null) value.put("confirmation", new JSObject().put("token", confirmation.token)
                    .put("title", confirmation.title).put("path", confirmation.path).put("sizeBytes", confirmation.size));
                value.put("failure", failure == null ? org.json.JSONObject.NULL : new JSObject()
                    .put("kind", failure.kind.name()).put("message", failure.getMessage()));
                call.resolve(value);
            });
        } catch (Exception error) { result(call, AudioProblem.from(error)); } });
    }
    @PluginMethod public void audioCommand(PluginCall call) {
        main.post(() -> { try {
            if (destroyed) { call.reject("The audio connection has closed."); return; }
            scope(call);
            String action = call.getString("action", ""); AudioRuntime r = runtime();
            switch (action) {
                case "openDelivery": getActivity().startActivity(new Intent(getActivity(), DeliveryActivity.class)); result(call, null); return;
                case "play": r.play(target(call), reply(call)); return;
                case "done": r.mark(target(call), AudioListening.Mark.DONE, reply(call)); return;
                case "unplayed": r.mark(target(call), AudioListening.Mark.UNPLAYED, reply(call)); return;
                case "pause": r.pause(); result(call, null); return;
                case "seek":
                    if (r.snapshot().player == null || !r.snapshot().player.item.equals(call.getString("id")))
                        throw new AudioProblem(AudioProblem.Kind.STALE, "The playing item changed.");
                    long position = integer(call, "positionMs");
                    r.seek(position); result(call, r.snapshot().failure); return;
                case "confirmDelete": r.library.confirm(call.getString("token", ""), reply(call)); return;
                case "cancelDelete": r.library.cancel(call.getString("token", "")); result(call, null); return;
                case "retryDelete": r.library.retry(call.getString("id", ""), reply(call)); return;
                case "stopRetrying": r.library.stopRetrying(call.getString("id", ""), reply(call)); return;
                case "historyDone": r.library.markHistory(call.getString("id", ""), AudioListening.Mark.DONE, reply(call)); return;
                case "historyUnplayed": r.library.markHistory(call.getString("id", ""), AudioListening.Mark.UNPLAYED, reply(call)); return;
                case "reopen": r.library.reopen(reply(call)); return;
                case "restore": r.library.available(); r.restore(reply(call)); return;
                default: throw new AudioProblem(AudioProblem.Kind.UNSUPPORTED, "Unknown audio action.");
            }
        } catch (Exception error) { result(call, AudioProblem.from(error)); } });
    }

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
