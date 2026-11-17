package com.garthtrickett.notes;

import android.net.Uri;
import android.os.Handler;
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

/** One bounded vault writer shared by scheduled jobs and explicit widget taps.
 * Start/cancel run on Android's main thread; bridge completion may come from any thread. */
final class VaultSyncSession {
    interface Listener { void finished(boolean ok); }
    private static volatile VaultSyncSession active;
    private final android.content.Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService calls = Executors.newSingleThreadExecutor();
    private final java.util.Set<Handle> owners = new java.util.LinkedHashSet<>();
    private WebView web;
    private PowerManager.WakeLock awake;
    private volatile boolean ended;
    private final String request = java.util.UUID.randomUUID().toString();
    private final Runnable timeout = () -> finish(false);

    static final class Handle {
        final VaultSyncSession session;
        private final Listener listener;
        private boolean detached;
        Handle(VaultSyncSession session, Listener listener) { this.session = session; this.listener = listener; }
        void cancel() {
            if (detached) return;
            detached = true;
            session.owners.remove(this);
            if (!session.ended && session.owners.isEmpty()) session.finish(false);
        }
    }

    private VaultSyncSession(android.content.Context context) { this.context = context.getApplicationContext(); }
    static Handle request(android.content.Context context, Listener listener) {
        VaultSyncSession session = active;
        boolean start = session == null;
        if (start) active = session = new VaultSyncSession(context);
        Handle handle = new Handle(session, listener);
        session.owners.add(handle);
        if (start) {
            try { session.begin(); } catch (RuntimeException refused) { session.finish(false); }
        }
        return handle;
    }
    static void complete(String request, boolean ok) {
        VaultSyncSession session = active;
        if (session != null && session.request.equals(request)) session.main.post(() -> session.finish(ok));
    }
    private void begin() {
        context.getSharedPreferences("widget-refresh", android.content.Context.MODE_PRIVATE).edit()
            .putLong("startedAt", System.currentTimeMillis()).putString("state", "syncing").apply();
        UrgeWidget.refresh(context);
        PowerManager power = context.getSystemService(PowerManager.class);
        if (power != null) {
            awake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "notes:vault-sync");
            awake.acquire(125_000L);
        }
        main.postDelayed(timeout, 120_000L);
        if (!WidgetPlugin.requestRefresh(request)) startHeadless();
    }
    @android.annotation.SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    protected void startHeadless() {
        try {
            web = new WebView(context);
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
                JSONObject photo = new PhotoInbox(context).read(parts[2], parts[3]);
                return new WebResourceResponse(photo.getString("mime"), null,
                    new FileInputStream(Uri.parse(photo.getString("uri")).getPath()));
            }
            if (path == null || !(path.equals("/background.html") || path.matches("/assets/[A-Za-z0-9._-]+"))) return empty();
            String mime = path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" : "application/javascript";
            return new WebResourceResponse(mime, "UTF-8", context.getAssets().open("public" + path));
        } catch (Exception unavailable) { return empty(); }
    }

    private static WebResourceResponse empty() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not found", java.util.Collections.emptyMap(),
            new ByteArrayInputStream(new byte[0]));
    }

    final class Calls {
        @JavascriptInterface public void call(int id, String method, String payload) {
            if (ended || payload == null || payload.length() > 4_000_000) return;
            try { calls.execute(() -> {
                if (ended) return;
                Object result = JSONObject.NULL;
                boolean ok = true;
                try { result = dispatch(method, new JSONObject(payload)); }
                catch (Exception failure) { ok = false; }
                if ("ready".equals(method) || "finished".equals(method)) return;
                String value = result == null ? "null" : JSONObject.wrap(result).toString();
                final String reply = "window.notesSyncReply(" + id + "," + ok + "," + value + ")";
                main.post(() -> { if (!ended && web != null) web.evaluateJavascript(reply, null); });
            }); } catch (java.util.concurrent.RejectedExecutionException stopped) { /* Session has ended. */ }
        }
    }

    Object dispatch(String method, JSONObject p) throws Exception {
        switch (method) {
            case "ready": main.post(() -> { if (!ended && web != null) web.loadUrl("https://localhost/background.html"); }); break;
            case "lookups": return new JSONObject().put("captures", new LookupInbox(context).pending());
            case "lookupAck": new LookupInbox(context).acknowledge(p.getString("id")); break;
            case "photos": return new JSONObject().put("batches", new PhotoInbox(context).pending());
            case "photoAck": new PhotoInbox(context).acknowledge(p.getString("id")); break;
            case "answers": return Alarms.take(context);
            case "answersAck": Alarms.acknowledge(context, p.getJSONArray("receipts")); break;
            case "alarms":
                Alarms.sync(context, p.getJSONArray("alarms"), p.getJSONArray("live"), System.currentTimeMillis());
                Alarms.links(context, p.getJSONArray("links"));
                VaultWatch.seed(context, p.getJSONObject("shas")); break;
            case "status":
                WidgetSyncStatus.update(context, p.getString("vault"), p.getString("state"),
                    p.isNull("checkedAt") ? null : p.getLong("checkedAt"),
                    p.isNull("pulledAt") ? null : p.getLong("pulledAt"), System.currentTimeMillis());
                UrgeWidget.refresh(context); break;
            case "finished": main.post(() -> finish(p.optBoolean("ok"))); break;
            default: throw new IllegalArgumentException("Unsupported widget operation");
        }
        return JSONObject.NULL;
    }

    private void finish(boolean ok) {
        if (ended) return;
        ended = true;
        main.removeCallbacks(timeout);
        if (web != null) web.stopLoading();
        // Drain any native operation before releasing the WebView's writer
        // lock or letting the alarm fallback touch the same native alarm set.
        calls.execute(() -> main.post(() -> cleanup(ok)));
        calls.shutdown();
    }
    private void cleanup(boolean ok) {
        if (web != null) { web.removeJavascriptInterface("NotesSync"); web.destroy(); web = null; }
        if (awake != null && awake.isHeld()) awake.release();
        if (active == this) active = null;
        context.getSharedPreferences("widget-refresh", android.content.Context.MODE_PRIVATE).edit()
            .putString("state", ok ? "done" : "error").apply();
        UrgeWidget.refresh(context);
        for (Handle owner : new java.util.ArrayList<>(owners)) {
            if (!owner.detached) {
                owner.detached = true;
                try { owner.listener.finished(ok); }
                catch (RuntimeException unavailable) { android.util.Log.w("VaultSyncSession", "Sync owner could not receive completion"); }
            }
        }
        owners.clear();
    }
}
