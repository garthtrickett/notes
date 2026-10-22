package com.garthtrickett.notes;

import android.util.AtomicFile;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

// Diagnostic state only, separate from future player checkpoints. Called from
// the storage test's single writer. Invalid state is kept intact and fails closed.
final class AudioSpikeJournal implements AudioDelete.Journal {
    private final AtomicFile file;
    private JSONObject state;

    AudioSpikeJournal(File directory) throws IOException {
        file = new AtomicFile(new File(directory, "audio-storage-spike.json"));
        try {
            byte[] bytes = AudioAtomicFiles.read(file);
            if (bytes == null) {
                state = new JSONObject().put("schema", 1).put("root", "");
            } else {
                state = parse(new String(bytes, StandardCharsets.UTF_8));
            }
        } catch (JSONException e) { throw new IOException("Storage test state is corrupt; deletion is disabled. Original state retained.", e); }
    }

    static JSONObject parse(String text) throws JSONException {
        JSONObject parsed = new JSONObject(text);
        if (!(parsed.get("schema") instanceof Integer) || parsed.getInt("schema") != 1)
            throw new JSONException("Unknown storage test schema; original file retained.");
        string(parsed, "root");
        if (parsed.has("deletion")) {
            JSONObject d = parsed.getJSONObject("deletion");
            String status = string(d, "outcome");
            if (!status.equals("pending") && !status.equals("absent") && !status.equals("changed")) throw new JSONException("Unknown deletion phase");
            AudioDelete.Version v = version(d);
            if (!AudioPaths.specimen(v.path) || v.size < 0 || v.modified < 0 || !v.sha256.matches("[0-9a-f]{64}") ||
                v.document.isEmpty() || !v.root.equals(parsed.getString("root"))) throw new JSONException("Invalid deletion identity");
        }
        return parsed;
    }

    String root() throws JSONException { return state.getString("root"); }
    String outcome() throws JSONException {
        return state.has("deletion") ? state.getJSONObject("deletion").getString("outcome") : "none";
    }
    AudioDelete.Version deletion() throws JSONException {
        return state.has("deletion") ? version(state.getJSONObject("deletion")) : null;
    }

    void bind(String root) throws IOException, JSONException {
        if ("pending".equals(outcome()) && !root.equals(root())) throw new IOException("Reconcile the pending deletion before changing folders.");
        if (root.equals(root())) return;
        write(new JSONObject().put("schema", 1).put("root", root));
    }

    private static AudioDelete.Version version(JSONObject value) throws JSONException {
        return new AudioDelete.Version(string(value, "root"), string(value, "path"), string(value, "document"),
            integer(value, "size"), integer(value, "modified"), string(value, "sha256"));
    }
    private static String string(JSONObject value, String key) throws JSONException {
        Object raw = value.get(key);
        if (!(raw instanceof String)) throw new JSONException("Invalid " + key);
        return (String) raw;
    }
    private static long integer(JSONObject value, String key) throws JSONException {
        Object raw = value.get(key);
        if (!(raw instanceof Integer) && !(raw instanceof Long)) throw new JSONException("Invalid " + key);
        return ((Number) raw).longValue();
    }

    public void intent(AudioDelete.Version version) throws IOException { result(version, "pending"); }
    public void result(AudioDelete.Version v, String outcome) throws IOException {
        try {
            if (!v.root.equals(root())) throw new IOException("The selected root changed.");
            JSONObject next = new JSONObject(state.toString());
            next.put("deletion", new JSONObject().put("root", v.root).put("path", v.path).put("document", v.document)
                .put("size", v.size).put("modified", v.modified).put("sha256", v.sha256).put("outcome", outcome));
            parse(next.toString());
            write(next);
        } catch (JSONException e) { throw new IOException("Could not persist the deletion identity.", e); }
    }

    private void write(JSONObject next) throws IOException {
        try {
            AudioAtomicFiles.write(file, next.toString().getBytes(StandardCharsets.UTF_8));
            state = next;
        } catch (IOException e) {
            throw new IOException("State could not be saved. No saved result is being claimed.", e);
        }
    }
}
