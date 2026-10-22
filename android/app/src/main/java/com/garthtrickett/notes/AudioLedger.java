package com.garthtrickett.notes;

import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

// The durable file's schema, not a projection of the WebView. These values never
// contain a saved isPlaying flag. File availability is established by queries.
final class AudioLedger {
    static final int SCHEMA = 1;
    enum DeletePhase { INTENT, ABSENT, CHANGED }

    static final class Item {
        final String id, title, author;
        final AudioDelete.Version version;
        final AudioListening.State listening;
        Item(String id, AudioDelete.Version version, String title, String author, AudioListening.State listening) {
            this.id = id; this.version = version; this.title = title; this.author = author; this.listening = listening;
        }
        Item listening(AudioListening.State next) { return new Item(id, version, title, author, next); }
        boolean contentAt(AudioDelete.Version other) {
            // mtime is a cache hint, never the content version's identity.
            return version.root.equals(other.root) && version.path.equals(other.path) &&
                version.document.equals(other.document) && version.sha256.equals(other.sha256);
        }
    }

    final String root, selected;
    final long rootGeneration;
    final Map<String, Item> items;
    final Map<String, DeletePhase> deletions;

    AudioLedger(String root, long generation, String selected, Map<String, Item> items, Map<String, DeletePhase> deletions) {
        this.root = root; rootGeneration = generation; this.selected = selected;
        this.items = Collections.unmodifiableMap(new LinkedHashMap<>(items));
        this.deletions = Collections.unmodifiableMap(new LinkedHashMap<>(deletions));
    }

    static AudioLedger empty() { return new AudioLedger("", 0, null, Collections.emptyMap(), Collections.emptyMap()); }
    AudioLedger bind(String uri) {
        if (root.equals(uri)) return this;
        if (deletions.containsValue(DeletePhase.INTENT)) throw new IllegalStateException("Reconcile pending deletion before changing roots");
        return new AudioLedger(uri, Math.addExact(rootGeneration, 1), null, items, deletions);
    }
    AudioLedger put(Item item) {
        Item previous = items.get(item.id);
        if (previous != null && !previous.contentAt(item.version)) throw new IllegalArgumentException("Item ID belongs to another version");
        Map<String, Item> next = new LinkedHashMap<>(items); next.put(item.id, item);
        return new AudioLedger(root, rootGeneration, selected, next, deletions);
    }
    AudioLedger select(String id) {
        if (!items.containsKey(id) || !items.get(id).version.root.equals(root)) throw new IllegalArgumentException("Unknown item in selected root");
        return new AudioLedger(root, rootGeneration, id, items, deletions);
    }
    AudioLedger deletion(String id, DeletePhase phase) {
        if (!items.containsKey(id)) throw new IllegalArgumentException("Unknown deletion target");
        Map<String, DeletePhase> next = new LinkedHashMap<>(deletions); next.put(id, phase);
        return new AudioLedger(root, rootGeneration, selected, items, next);
    }
    AudioLedger cancelDeletion(String id) {
        if (deletions.get(id) != DeletePhase.INTENT) throw new IllegalArgumentException("No pending deletion for this item");
        Map<String, DeletePhase> next = new LinkedHashMap<>(deletions); next.remove(id);
        return new AudioLedger(root, rootGeneration, selected, items, next);
    }
    Item find(AudioDelete.Version version) {
        for (Item item : items.values()) if (item.contentAt(version)) return item;
        return null;
    }

    JSONObject json() throws JSONException {
        JSONObject value = new JSONObject().put("schema", SCHEMA).put("root", root).put("rootGeneration", rootGeneration)
            .put("selected", selected == null ? JSONObject.NULL : selected);
        JSONArray rows = new JSONArray();
        for (Item item : items.values()) {
            AudioDelete.Version v = item.version;
            rows.put(new JSONObject().put("id", item.id).put("root", v.root).put("path", v.path).put("document", v.document)
                .put("sha256", v.sha256).put("size", v.size).put("modified", v.modified).put("title", item.title)
                .put("author", item.author == null ? JSONObject.NULL : item.author).put("mark", item.listening.mark.name())
                .put("positionMs", item.listening.positionMs).put("durationMs", item.listening.durationMs));
        }
        JSONArray operations = new JSONArray();
        for (Map.Entry<String, DeletePhase> entry : deletions.entrySet())
            operations.put(new JSONObject().put("item", entry.getKey()).put("phase", entry.getValue().name()));
        return value.put("items", rows).put("deletions", operations);
    }

    static AudioLedger parse(JSONObject json) throws JSONException {
        long schema = integer(json, "schema");
        if (schema != SCHEMA) throw new JSONException("Unknown audio state schema: " + schema);
        String root = string(json, "root");
        if (!root.isEmpty() && !localRoot(root)) throw new JSONException("Invalid audio root");
        long generation = integer(json, "rootGeneration");
        if (generation < 0) throw new JSONException("Invalid root generation");
        String selected = nullableString(json, "selected");
        Map<String, Item> items = new LinkedHashMap<>();
        java.util.Set<List<String>> versions = new HashSet<>();
        JSONArray rows = json.getJSONArray("items");
        if (rows.length() > 100000) throw new JSONException("Audio history exceeds the state limit");
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            String id = string(row, "id"), path = string(row, "path"), uri = string(row, "root");
            String document = string(row, "document"), digest = string(row, "sha256"), title = string(row, "title");
            long size = integer(row, "size"), modified = integer(row, "modified");
            long position = integer(row, "positionMs"), duration = integer(row, "durationMs");
            if (id.isEmpty() || items.containsKey(id) || !AudioPaths.audio(path) || !localRoot(uri) || document.isEmpty() ||
                !digest.matches("[0-9a-f]{64}") || size < 0 || modified < 0 || duration < -1 || position < 0 ||
                (duration >= 0 && position > duration)) throw new JSONException("Invalid audio item identity/checkpoint");
            AudioListening.Mark mark;
            try { mark = AudioListening.Mark.valueOf(string(row, "mark")); }
            catch (IllegalArgumentException e) { throw new JSONException("Unknown listening mark"); }
            if (mark == AudioListening.Mark.UNPLAYED && position != 0) throw new JSONException("Unplayed item has a bookmark");
            Item item = new Item(id, new AudioDelete.Version(uri, path, document, size, modified, digest), title,
                nullableString(row, "author"), new AudioListening.State(mark, position, duration));
            if (!versions.add(java.util.Arrays.asList(uri, path, document, digest))) throw new JSONException("Duplicate audio version");
            items.put(id, item);
        }
        if (selected != null && !items.containsKey(selected)) throw new JSONException("Unknown selected audio item");
        Map<String, DeletePhase> deletions = new LinkedHashMap<>();
        JSONArray operations = json.getJSONArray("deletions");
        for (int i = 0; i < operations.length(); i++) {
            JSONObject operation = operations.getJSONObject(i);
            String id = string(operation, "item");
            if (!items.containsKey(id) || deletions.containsKey(id)) throw new JSONException("Corrupt deletion intent target");
            try { deletions.put(id, DeletePhase.valueOf(string(operation, "phase"))); }
            catch (IllegalArgumentException e) { throw new JSONException("Corrupt deletion intent phase"); }
        }
        return new AudioLedger(root, generation, selected, items, deletions);
    }

    private static boolean localRoot(String uri) {
        try {
            java.net.URI root = new java.net.URI(uri);
            return "content".equals(root.getScheme()) && AudioDocuments.AUTHORITY.equals(root.getAuthority()) &&
                root.getPath() != null && root.getPath().startsWith("/tree/");
        } catch (java.net.URISyntaxException e) { return false; }
    }
    static String string(JSONObject json, String key) throws JSONException {
        Object value = json.get(key);
        if (!(value instanceof String)) throw new JSONException("Invalid audio state field: " + key);
        return (String) value;
    }
    private static String nullableString(JSONObject json, String key) throws JSONException {
        return json.get(key) == JSONObject.NULL ? null : string(json, key);
    }
    static long integer(JSONObject json, String key) throws JSONException {
        Object value = json.get(key);
        if (!(value instanceof Integer) && !(value instanceof Long)) throw new JSONException("Invalid audio state integer: " + key);
        return ((Number) value).longValue();
    }
}
