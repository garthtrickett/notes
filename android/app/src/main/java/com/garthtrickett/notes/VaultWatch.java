package com.garthtrickett.notes;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

// Keeps alarms current while the app is closed. Without it, a `!` reminder
// written on the laptop — or straight into the vault — only became an alarm
// the next time the phone opened the app, which is exactly the evening you
// forget to.
//
// A periodic job, roughly every half hour when the phone allows; overnight
// Android stretches that out. It asks GitHub for the branch head (one small
// request) and stops there if nothing moved. If it did, it lists the tree,
// fetches only the notes whose blob changed since it last looked, reads their
// alarm lines (AlarmLines), and replaces those notes' alarms. The app seeds
// what it already knows on every sync, so the first run does not fetch the
// whole vault, and the app's own sync stays the last word whenever it runs.
public class VaultWatch extends JobService {
    private static final int JOB_ID = 4711;
    private static final long PERIOD_MS = 30 * 60 * 1000L;
    // Notes fetched per run. A big change set finishes over a few runs rather
    // than one long one the system might cut short; the head is only recorded
    // once everything is read, so nothing is skipped.
    private static final int BUDGET = 60;
    private static final String PREFS = "notes.vault";

    private volatile Thread worker;

    // Called by the app with its vault settings. The token is kept in the
    // app's private storage, the same sandbox the WebView keeps it in.
    static void configure(Context context, String owner, String repo, String branch, String token) {
        prefs(context).edit()
            .putString("owner", owner)
            .putString("repo", repo)
            .putString("branch", branch)
            .putString("token", token)
            .apply();
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler == null || scheduler.getPendingJob(JOB_ID) != null) return;
        scheduler.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(context, VaultWatch.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPeriodic(PERIOD_MS)
            .setPersisted(true)
            .build());
    }

    // What the app already has: path -> blob sha. Forgetting the head makes
    // the next run compare the tree against this rather than trust that
    // nothing moved.
    static void seed(Context context, JSONObject shas) {
        prefs(context).edit().putString("shas", shas.toString()).remove("head").apply();
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        Context app = getApplicationContext();
        worker = new Thread(() -> {
            try {
                check(app, System.currentTimeMillis());
            } catch (IOException | JSONException | RuntimeException failed) {
                // Offline, rate limited, or GitHub said no: the next period
                // tries again, and the app's own sync covers it either way.
            } finally {
                jobFinished(params, false);
            }
        }, "vault-watch");
        worker.start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        Thread t = worker;
        if (t != null) t.interrupt();
        return true;
    }

    private static void check(Context context, long now) throws IOException, JSONException {
        SharedPreferences p = prefs(context);
        String owner = p.getString("owner", null);
        String repo = p.getString("repo", null);
        String branch = p.getString("branch", null);
        String token = p.getString("token", null);
        if (owner == null || repo == null || branch == null || token == null) return;
        String base = "https://api.github.com/repos/" + owner + "/" + repo;

        String head = new JSONObject(get(base + "/git/ref/heads/" + branch, token))
            .getJSONObject("object").getString("sha");
        if (head.equals(p.getString("head", null))) return;

        JSONArray tree = new JSONObject(get(base + "/git/trees/" + head + "?recursive=1", token))
            .getJSONArray("tree");
        JSONObject known = new JSONObject(p.getString("shas", "{}"));

        Set<String> present = new HashSet<>();
        Map<String, String> changed = new LinkedHashMap<>();
        for (int i = 0; i < tree.length(); i++) {
            JSONObject e = tree.getJSONObject(i);
            String path = e.optString("path", "");
            if (!"blob".equals(e.optString("type")) || !path.endsWith(".md") || hidden(path)) continue;
            present.add(path);
            String sha = e.optString("sha", "");
            if (!sha.equals(known.optString(path, ""))) changed.put(path, sha);
        }
        Set<String> gone = new HashSet<>();
        for (Iterator<String> keys = known.keys(); keys.hasNext(); ) {
            String path = keys.next();
            if (!present.contains(path)) gone.add(path);
        }

        Map<String, List<Alarms.Entry>> read = new LinkedHashMap<>();
        int budget = BUDGET;
        boolean finished = true;
        for (Map.Entry<String, String> c : changed.entrySet()) {
            if (budget-- == 0 || Thread.currentThread().isInterrupted()) {
                finished = false;
                break;
            }
            String body = blob(base, c.getValue(), token);
            List<Alarms.Entry> entries = new ArrayList<>();
            for (AlarmLines.Found f : AlarmLines.wanted(body, c.getKey(), now)) {
                entries.add(new Alarms.Entry(f.id, f.at, f.title, f.path, f.at, f.repeat));
            }
            read.put(c.getKey(), entries);
            known.put(c.getKey(), c.getValue());
        }
        for (String path : gone) known.remove(path);

        Alarms.replacePaths(context, read, gone, now);
        SharedPreferences.Editor edit = p.edit().putString("shas", known.toString());
        if (finished) edit.putString("head", head);
        edit.apply();
    }

    // The app's trash and archive are not triage (tasksInVault skips them).
    private static boolean hidden(String path) {
        return path.equals(".trash") || path.startsWith(".trash/")
            || path.equals(".archive") || path.startsWith(".archive/");
    }

    private static String blob(String base, String sha, String token) throws IOException, JSONException {
        String content = new JSONObject(get(base + "/git/blobs/" + sha, token)).optString("content", "");
        return new String(Base64.decode(content, Base64.DEFAULT), StandardCharsets.UTF_8);
    }

    private static String get(String url, String token) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(20_000);
            c.setReadTimeout(20_000);
            c.setUseCaches(false);
            c.setRequestProperty("Authorization", "Bearer " + token);
            c.setRequestProperty("Accept", "application/vnd.github+json");
            c.setRequestProperty("User-Agent", "notes-android");
            int status = c.getResponseCode();
            if (status != 200) throw new IOException("GitHub answered " + status + " for " + url);
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[16 * 1024];
                for (int n; (n = in.read(buf)) != -1; ) out.write(buf, 0, n);
                return new String(out.toByteArray(), StandardCharsets.UTF_8);
            }
        } finally {
            c.disconnect();
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
