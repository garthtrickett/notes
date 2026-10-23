package com.garthtrickett.notes;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class DeliveryItem {
    final String id, path, sha256;
    final long size;
    DeliveryItem(String id, String path, long size, String sha256) throws JSONException {
        if (id == null || !id.matches("[0-9a-f]{32}") || sha256 == null || !sha256.matches("[0-9a-f]{64}") ||
            size < 0 || size > 100L * 1024 * 1024 * 1024 || !path(path)) throw new JSONException("Invalid delivery item");
        this.id = id; this.path = path; this.size = size; this.sha256 = sha256;
    }
    static boolean path(String value) {
        if (value == null || value.length() > 2048) return false;
        String[] parts = value.split("/", -1);
        if (parts.length < 2 || parts.length > 18 || !java.util.Arrays.asList("youtube", "podcasts", "audiobooks", "japanese", "video").contains(parts[0])) return false;
        for (String part : parts) {
            if (!AudioPaths.segment(part)) return false;
            for (int i = 0; i < part.length(); i++) if (part.charAt(i) < 32) return false;
        }
        return value.toLowerCase(java.util.Locale.ROOT).matches(".*\\.(opus|m4b|mp3|m4a|ogg|wav|flac|mp4|mkv|webm|srt|vtt|txt)$");
    }
    JSONObject json() throws JSONException { return new JSONObject().put("id", id).put("path", path).put("size", size).put("sha256", sha256); }
    static long number(JSONObject json, String key) throws JSONException {
        Object raw = json.get(key);
        if (!(raw instanceof Integer) && !(raw instanceof Long)) throw new JSONException("Invalid number");
        return ((Number) raw).longValue();
    }
    static String text(JSONObject json, String key) throws JSONException {
        Object raw = json.get(key);
        if (!(raw instanceof String)) throw new JSONException("Invalid text");
        return (String) raw;
    }
    static DeliveryItem parse(JSONObject json) throws JSONException {
        return new DeliveryItem(text(json,"id"), text(json,"path"), number(json,"size"), text(json,"sha256"));
    }
    static List<DeliveryItem> manifest(String text) throws JSONException {
        if (text.length() > 2 * 1024 * 1024) throw new JSONException("Delivery list too large");
        JSONObject json = new JSONObject(text);
        if (number(json,"schema") != 1) throw new JSONException("Unsupported delivery list");
        JSONArray items = json.getJSONArray("items");
        if (items.length() > 2000) throw new JSONException("Too many queued files");
        HashSet<String> ids = new HashSet<>(), paths = new HashSet<>();
        List<DeliveryItem> result = new ArrayList<>();
        for (int i=0; i<items.length(); i++) {
            DeliveryItem item = parse(items.getJSONObject(i));
            if (!ids.add(item.id) || !paths.add(item.path)) throw new JSONException("Duplicate delivery item");
            result.add(item);
        }
        return result;
    }
    boolean same(DeliveryItem other) { return id.equals(other.id) && path.equals(other.path) && size==other.size && sha256.equals(other.sha256); }
}
