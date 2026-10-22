package com.garthtrickett.notes;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.IOException;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/** Tiny durable transport, not a second vault. Notes imports it on next open.
 * A failed/missing WebView or network never loses a widget capture. */
final class LookupInbox {
    static final ExecutorService worker = Executors.newSingleThreadExecutor();
    static final int MAX_TEXT = 2000;
    private final SharedPreferences prefs;

    LookupInbox(Context context) {
        prefs = context.getSharedPreferences("lookup-inbox", Context.MODE_PRIVATE);
    }

    private static void checkId(String id) {
        if (id == null || !UUID.fromString(id).toString().equals(id))
            throw new IllegalArgumentException("Invalid capture ID");
    }

    void save(String id, String text, long at) throws Exception {
        checkId(id);
        text = text.trim();
        if (text.isEmpty() || text.length() > MAX_TEXT) throw new IllegalArgumentException("Invalid question");
        String saved = prefs.getString(id, null);
        if (saved != null) {
            if (!new JSONObject(saved).getString("text").equals(text))
                throw new IOException("Capture ID already used");
            return;
        }
        var local = Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault());
        // Same 04:00 boundary as the existing dated dump; retain the date and
        // wall clock at capture even if the phone later changes timezone.
        JSONObject capture = new JSONObject().put("id", id).put("text", text)
            .put("day", local.minusHours(4).toLocalDate().toString())
            .put("time", local.format(DateTimeFormatter.ofPattern("HH:mm")))
            .put("at", at);
        if (!prefs.edit().putString(id, capture.toString()).commit())
            throw new IOException("Could not save capture");
    }

    JSONArray pending() throws Exception {
        List<JSONObject> entries = new ArrayList<>();
        for (String id : prefs.getAll().keySet()) {
            checkId(id);
            JSONObject entry = new JSONObject(prefs.getString(id, ""));
            if (!id.equals(entry.getString("id"))) throw new IOException("Invalid saved capture");
            entries.add(entry);
        }
        entries.sort((a, b) -> Long.compare(a.optLong("at"), b.optLong("at")));
        return new JSONArray(entries);
    }

    void acknowledge(String id) throws Exception {
        checkId(id);
        if (!prefs.edit().remove(id).commit()) throw new IOException("Could not finish capture");
    }
}
