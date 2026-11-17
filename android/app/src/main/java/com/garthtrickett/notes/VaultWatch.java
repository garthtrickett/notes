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

// The existing persisted job runs full vault sync roughly every 15 minutes,
// when Android permits it. Scheduled work uses the shared bounded session
// directly, without starting a foreground service or Activity. An explicit
// widget request joins that same writer. If full sync fails, the native
// alarm-only reader below still keeps reminders current using its saved head
// and per-note blob hashes; it never claims the local note cache is synced.
public class VaultWatch extends JobService {
    private static final int JOB_ID = 4711;
    // Android clamps periodic jobs to at least 15 minutes.
    private static final long PERIOD_MS = 15 * 60 * 1000L;
    // Notes fetched per run. A big change set finishes over a few runs rather
    // than one long one the system might cut short; the head is only recorded
    // once everything is read, so nothing is skipped.
    private static final int BUDGET = 60;
    private static final String PREFS = "notes.vault";

    private Run running;
    private static final class Run {
        final JobParameters params;
        VaultSyncSession.Handle sync;
        Thread worker;
        volatile boolean stopped;
        Run(JobParameters params) { this.params = params; }
    }

    // Called by the app with its vault settings. The token is kept in the
    // app's private storage, the same sandbox the WebView keeps it in.
    static void configure(Context context, String owner, String repo, String branch, String token) {
        prefs(context).edit()
            .putString("owner", owner)
            .putString("repo", repo)
            .putString("branch", branch)
            .putString("token", token)
            .apply();
        schedule(context);
    }

    // Persisted jobs survive upgrades with their old interval. Reconcile the
    // schedule after an update too, without waiting for the app to be opened.
    static void restore(Context context) {
        SharedPreferences p = prefs(context);
        if (!p.contains("owner") || !p.contains("repo") || !p.contains("branch") || !p.contains("token")) return;
        try {
            schedule(context);
        } catch (RuntimeException refused) {
            // A refused background job must not crash the broadcast receiver.
            // Opening the app retries through configure's plugin error path.
            android.util.Log.w("VaultWatch", "Background vault check could not be restored");
        }
    }

    private static void schedule(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler == null) return;
        long period = Math.max(PERIOD_MS, JobInfo.getMinPeriodMillis());
        JobInfo pending = scheduler.getPendingJob(JOB_ID);
        if (pending != null && pending.isPeriodic() && pending.getIntervalMillis() == period) return;
        // Scheduling the same ID replaces the old job; unchanged jobs are left
        // alone so foreground sync cannot keep resetting the next check.
        int result = scheduler.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(context, VaultWatch.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPeriodic(period)
            .setPersisted(true)
            .build());
        if (result != JobScheduler.RESULT_SUCCESS) {
            throw new IllegalStateException("Background vault check was refused by Android");
        }
    }

    // What the app already has: path -> blob sha. Forgetting the head makes
    // the next run compare the tree against this rather than trust that
    // nothing moved.
    static void seed(Context context, JSONObject shas) {
        prefs(context).edit().putString("shas", shas.toString()).remove("head").apply();
    }

    @Override public boolean onStartJob(JobParameters params) {
        if (running != null) return false;
        Context app = getApplicationContext();
        Run run = new Run(params);
        running = run;
        run.sync = requestFullSync(app, ok -> {
            if (run.stopped || running != run) return;
            if (ok) { finish(run); return; }
            // A failed full import must not remove the existing alarm-only
            // fallback. Run it after the shared writer has stopped, not beside it.
            run.worker = new Thread(() -> {
                try { readAlarms(app, System.currentTimeMillis()); }
                catch (IOException | JSONException | RuntimeException failed) { /* Next period retries. */ }
                finally { new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> finish(run)); }
            }, "vault-watch-fallback");
            run.worker.start();
        });
        return true;
    }

    protected VaultSyncSession.Handle requestFullSync(Context context, VaultSyncSession.Listener listener) {
        return VaultSyncSession.request(context, listener);
    }
    protected void readAlarms(Context context, long now) throws IOException, JSONException { check(context, now); }
    protected void completed(JobParameters params) { jobFinished(params, false); }
    private void finish(Run run) {
        if (run.stopped || running != run) return;
        running = null;
        completed(run.params);
    }

    @Override public boolean onStopJob(JobParameters params) {
        Run run = running;
        if (run != null) {
            run.stopped = true;
            running = null;
            if (run.sync != null) run.sync.cancel();
            if (run.worker != null) run.worker.interrupt();
        }
        return true;
    }
    @Override public void onDestroy() {
        onStopJob(null);
        super.onDestroy();
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
        if (!changed.isEmpty() || !gone.isEmpty())
            WidgetSyncStatus.remoteChanged(context, owner + "/" + repo + "@" + branch, now);
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
