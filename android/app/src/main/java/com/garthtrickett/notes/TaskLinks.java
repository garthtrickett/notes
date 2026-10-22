package com.garthtrickett.notes;

import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

// The closed-app counterpart of task-links.ts. A snapshot is installed by the
// app; only explicit alarm Done presses advance it. No mailbox or network work.
final class TaskLinks {
    private TaskLinks() {}

    static final class Advanced {
        final JSONArray nodes;
        final JSONArray releases = new JSONArray();
        String sourceId;
        String token;
        Advanced(JSONArray nodes) { this.nodes = nodes; }
    }

    private static JSONObject unique(JSONArray nodes, String id) throws JSONException {
        JSONObject found = null;
        for (int i = 0; i < nodes.length(); i++) {
            JSONObject n = nodes.getJSONObject(i);
            if (!id.equals(n.optString("id"))) continue;
            if (found != null) return null;
            found = n;
        }
        return found;
    }

    private static boolean valid(JSONArray nodes, JSONObject node) throws JSONException {
        Set<String> seen = new HashSet<>();
        String id = node.optString("id");
        while (!id.isEmpty()) {
            if (!seen.add(id)) return false;
            JSONObject n = unique(nodes, id);
            if (n == null) return false;
            id = n.optString("after");
        }
        return true;
    }

    static Advanced complete(JSONArray snapshot, int alarmId, String path, String title, long stamp, long now) throws JSONException {
        Advanced result = new Advanced(new JSONArray(snapshot.toString()));
        JSONObject source = null;
        for (int i = 0; i < result.nodes.length(); i++) {
            JSONObject n = result.nodes.getJSONObject(i);
            if (path.equals(n.optString("path")) && title.equals(n.optString("title"))
                && AlarmLines.linkId(n.optString("id")) == alarmId && n.optLong("stamp") == stamp) {
                if (source != null) return result;
                source = n;
            }
        }
        if (source == null || !valid(result.nodes, source)) return result;
        if (source.has("after") && !source.optBoolean("ready")) return result;
        String token = source.has("after") ? source.optString("seen", "once")
            : source.optBoolean("repeat") ? "at:" + stamp : source.optLong("round") > 0 ? "once:" + source.optLong("round") : "once";
        result.sourceId = source.getString("id");
        result.token = token;
        if (token.equals(source.optString("completed"))) return result;
        source.put("completed", token).put("done", true);
        for (int i = 0; i < result.nodes.length(); i++) {
            JSONObject n = result.nodes.getJSONObject(i);
            if (!source.optString("id").equals(n.optString("after")) || !valid(result.nodes, n)) continue;
            if (token.equals(n.optString("seen"))) continue;
            boolean active = n.optBoolean("ready") && !n.optBoolean("done");
            n.put("seen", token);
            if (active) continue;
            long at = (now / 60_000L + 1) * 60_000L;
            n.put("ready", true).put("done", false).put("stamp", n.optBoolean("alarm") ? at : 0L);
            result.releases.put(new JSONObject().put("kind", "activate").put("taskId", n.getString("id"))
                .put("sourceId", source.getString("id")).put("sourcePath", source.getString("path")).put("token", token)
                .put("path", n.getString("path")).put("title", n.getString("title"))
                .put("at", at).put("alarm", n.optBoolean("alarm")));
        }
        return result;
    }

    static JSONArray snooze(JSONArray snapshot, String path, String title, long stamp, long to) throws JSONException {
        JSONArray result = new JSONArray(snapshot.toString());
        for (int i = 0; i < result.length(); i++) {
            JSONObject n = result.getJSONObject(i);
            if (path.equals(n.optString("path")) && title.equals(n.optString("title")) && stamp == n.optLong("stamp")) n.put("stamp", to);
        }
        return result;
    }
}
