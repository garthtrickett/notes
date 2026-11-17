package com.garthtrickett.notes;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.FileInputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** A finite user-started sync, without an Activity or a second vault. */
public class WidgetRefreshService extends Service {
    private static final int NOTICE = 4911;
    private static volatile WidgetRefreshService active;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService calls = Executors.newSingleThreadExecutor();
    private WebView web;
    private PowerManager.WakeLock awake;
    private boolean started;
    private volatile boolean ended;
    private final String request = java.util.UUID.randomUUID().toString();
    private final Runnable timeout = () -> finish(false);

    static void complete(String request, boolean ok) {
        WidgetRefreshService service = active;
        if (service != null && service.request.equals(request)) service.main.post(() -> service.finish(ok));
    }

    @Override public int onStartCommand(Intent intent, int flags, int id) {
        if (started) return START_NOT_STICKY;
        started = true;
        active = this;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (android.os.Build.VERSION.SDK_INT >= 26)
            manager.createNotificationChannel(new NotificationChannel("notes-widget-sync", "Widget sync", NotificationManager.IMPORTANCE_LOW));
        Notification.Builder builder = android.os.Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, "notes-widget-sync") : new Notification.Builder(this);
        Notification notice = builder
            .setSmallIcon(android.R.drawable.stat_notify_sync).setContentTitle("Syncing Notes")
            .setContentText("Refreshing notes and checking media…").setOngoing(true).setOnlyAlertOnce(true).build();
        try { startForeground(NOTICE, notice); }
        catch (RuntimeException refused) { finish(false); return START_NOT_STICKY; }
        getSharedPreferences("widget-refresh", MODE_PRIVATE).edit().putLong("startedAt", System.currentTimeMillis())
            .putString("state", "syncing").apply();
        UrgeWidget.refresh(this);
        PowerManager power = getSystemService(PowerManager.class);
        awake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "notes:widget-sync");
        awake.acquire(125_000L);
        main.postDelayed(timeout, 120_000L);
        // User initiation does not override the saved unmetered-only setting.
        if (new DeliveryProfile(this).configured()) {
            try { DeliveryJobs.fetch(this); }
            catch (Exception refused) { DeliveryRunner.message("Media check could not start. Open Fetch media to retry."); }
        }
        if (!WidgetPlugin.requestRefresh(request)) startHeadless();
        return START_NOT_STICKY;
    }

    @android.annotation.SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    protected void startHeadless() {
        try {
            web = new WebView(this);
            web.getSettings().setJavaScriptEnabled(true);
            web.getSettings().setDomStorageEnabled(true);
            web.getSettings().setAllowFileAccess(false);
            web.getSettings().setAllowContentAccess(false);
            web.addJavascriptInterface(new Calls(), "NotesSync");
            web.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
                @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    return resource(request.getUrl());
                }
                @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                    main.post(() -> finish(false)); return true;
                }
            });
            // Matches Capacitor's default origin and WebView data profile.
            // A data document is not an old service worker's navigation. Retire
            // shell registrations before navigating, without clearing storage.
            web.loadDataWithBaseURL("https://localhost/", bootstrap(), "text/html", "UTF-8", null);
        } catch (RuntimeException unavailable) { finish(false); }
    }

    static String bootstrap() {
        return "<!doctype html><script>" +
            "Promise.resolve().then(()=>('serviceWorker' in navigator)?navigator.serviceWorker.getRegistrations():[])" +
            ".then(rs=>Promise.all(rs.map(r=>r.unregister())))" +
            ".then(()=>NotesSync.call(0,'ready','{}'))" +
            ".catch(()=>NotesSync.call(0,'finished','{\"ok\":false}'))" +
            "</script>";
    }

    WebResourceResponse resource(Uri uri) {
        if (!"https".equals(uri.getScheme())) return empty();
        if ("api.github.com".equals(uri.getHost())) return null;
        if (!"localhost".equals(uri.getHost())) return empty();
        String path = uri.getPath();
        try {
            if (path != null && path.matches("/_sync_photo/[a-f0-9-]{36}/[0-9]")) {
                String[] parts = path.split("/");
                JSONObject photo = new PhotoInbox(this).read(parts[2], parts[3]);
                return new WebResourceResponse(photo.getString("mime"), null,
                    new FileInputStream(Uri.parse(photo.getString("uri")).getPath()));
            }
            if (path == null || !(path.equals("/background.html") || path.matches("/assets/[A-Za-z0-9._-]+"))) return empty();
            String mime = path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" : "application/javascript";
            return new WebResourceResponse(mime, "UTF-8", getAssets().open("public" + path));
        } catch (Exception unavailable) { return empty(); }
    }

    private static WebResourceResponse empty() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not found", java.util.Collections.emptyMap(),
            new ByteArrayInputStream(new byte[0]));
    }

    final class Calls {
        @JavascriptInterface public void call(int id, String method, String payload) {
            if (ended || payload == null || payload.length() > 4_000_000) return;
            calls.execute(() -> {
                Object result = JSONObject.NULL;
                boolean ok = true;
                try { result = dispatch(method, new JSONObject(payload)); }
                catch (Exception failure) { ok = false; }
                String value = result == null ? "null" : JSONObject.wrap(result).toString();
                final String reply = "window.notesSyncReply(" + id + "," + ok + "," + value + ")";
                main.post(() -> { if (!ended && web != null) web.evaluateJavascript(reply, null); });
            });
        }
    }

    Object dispatch(String method, JSONObject p) throws Exception {
        switch (method) {
            case "ready": main.post(() -> { if (!ended && web != null) web.loadUrl("https://localhost/background.html"); }); break;
            case "lookups": return new JSONObject().put("captures", new LookupInbox(this).pending());
            case "lookupAck": new LookupInbox(this).acknowledge(p.getString("id")); break;
            case "photos": return new JSONObject().put("batches", new PhotoInbox(this).pending());
            case "photoAck": new PhotoInbox(this).acknowledge(p.getString("id")); break;
            case "answers": return Alarms.take(this);
            case "answersAck": Alarms.acknowledge(this, p.getJSONArray("receipts")); break;
            case "alarms":
                Alarms.sync(this, p.getJSONArray("alarms"), p.getJSONArray("live"), System.currentTimeMillis());
                Alarms.links(this, p.getJSONArray("links"));
                VaultWatch.seed(this, p.getJSONObject("shas")); break;
            case "status":
                WidgetSyncStatus.update(this, p.getString("vault"), p.getString("state"),
                    p.isNull("checkedAt") ? null : p.getLong("checkedAt"),
                    p.isNull("pulledAt") ? null : p.getLong("pulledAt"), System.currentTimeMillis());
                UrgeWidget.refresh(this); break;
            case "finished": main.post(() -> finish(p.optBoolean("ok"))); break;
            default: throw new IllegalArgumentException("Unsupported widget operation");
        }
        return JSONObject.NULL;
    }

    private void finish(boolean ok) {
        if (ended) return;
        ended = true;
        getSharedPreferences("widget-refresh", MODE_PRIVATE).edit().putString("state", ok ? "done" : "error").apply();
        UrgeWidget.refresh(this);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }
    @Override public void onTimeout(int id, int type) { finish(false); }
    @Override public void onDestroy() {
        if (!ended) getSharedPreferences("widget-refresh", MODE_PRIVATE).edit().putString("state", "error").apply();
        ended = true;
        if (active == this) active = null;
        main.removeCallbacks(timeout);
        if (web != null) { web.removeJavascriptInterface("NotesSync"); web.stopLoading(); web.destroy(); web = null; }
        if (awake != null && awake.isHeld()) awake.release();
        calls.shutdown();
        UrgeWidget.refresh(this);
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
