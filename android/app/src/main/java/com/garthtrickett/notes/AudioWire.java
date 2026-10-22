package com.garthtrickett.notes;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import org.json.JSONObject;

// Metadata projection only. Provider grants, document IDs, fingerprints and
// audio bytes remain inside the native module. Row IDs are opaque capabilities.
final class AudioWire {
    private static Object nullable(Object value) { return value == null ? JSONObject.NULL : value; }
    private static Object duration(long value) { return value > 0 ? value : JSONObject.NULL; }
    private static JSObject listening(AudioListening.State state) {
        return new JSObject().put("mark", state.mark.name()).put("positionMs", state.positionMs)
            .put("durationMs", duration(state.durationMs));
    }
    static JSObject snapshot(AudioRuntime.Snapshot state) {
        JSArray rows = new JSArray();
        for (AudioCatalog.Row row : state.catalog.rows) {
            AudioLedger.Item known = row.durableId == null ? null : state.ledger.items.get(row.durableId);
            rows.put(new JSObject().put("item", row.id).put("version", row.version)
                .put("path", row.document.path).put("title", row.title).put("author", nullable(row.author))
                .put("sizeBytes", row.document.size >= 0 ? row.document.size : JSONObject.NULL)
                .put("durationMs", duration(row.durationMs)).put("durableId", nullable(row.durableId))
                .put("error", nullable(row.error))
                .put("listening", known == null ? JSONObject.NULL : listening(known.listening)));
        }
        JSArray history = new JSArray();
        for (AudioLedger.Item item : state.ledger.items.values()) {
            boolean present = false;
            for (AudioCatalog.Row row : state.catalog.rows) if (item.id.equals(row.durableId)) present = true;
            boolean listed = state.catalog.root.equals(state.ledger.root) && state.catalog.rootGeneration == state.ledger.rootGeneration;
            String availability = !item.version.root.equals(state.ledger.root) ? "OTHER_ROOT" :
                !listed || (state.failure != null && state.failure.kind == AudioProblem.Kind.PERMISSION) ? "UNKNOWN" : present ? "PRESENT" : "MISSING";
            AudioLedger.DeletePhase deletion = state.ledger.deletions.get(item.id);
            history.put(new JSObject().put("id", item.id).put("path", item.version.path)
                .put("title", item.title).put("author", nullable(item.author))
                .put("currentRoot", item.version.root.equals(state.ledger.root)).put("listening", listening(item.listening))
                .put("availability", availability).put("deletion", deletion == null ? JSONObject.NULL : deletion.name()));
        }
        JSObject player = state.player == null ? null : new JSObject().put("item", state.player.item)
            .put("positionMs", state.player.elapsedMs).put("durationMs", duration(state.player.durationMs))
            .put("playing", state.player.playing);
        JSObject failure = state.failure == null ? null : new JSObject().put("kind", state.failure.kind.name())
            .put("message", state.failure.getMessage());
        return new JSObject().put("protocol", 1).put("epoch", state.epoch).put("rootGeneration", state.ledger.rootGeneration)
            .put("revision", state.revision).put("rootSelected", !state.ledger.root.isEmpty())
            .put("operation", nullable(state.operation)).put("warning", nullable(state.warning))
            .put("recoveryRequired", state.recoveryRequired).put("failure", nullable(failure))
            .put("rows", rows).put("history", history).put("player", nullable(player));
    }
}
