package com.garthtrickett.notes;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

// The last step of self-update: hand a downloaded APK to the system installer.
// Three calls, each doing one thing. Installing from an unknown source needs
// the user's explicit opt-in, so the middle call opens the settings page that
// holds the toggle — there is no silent path and this does not try to find one.
@CapacitorPlugin(name = "Update")
public class UpdatePlugin extends Plugin {

    private static final String TAG = "NotesUpdate";

    @PluginMethod
    public void canInstall(PluginCall call) {
        Log.i(TAG, "canInstall entered");
        boolean allowed =
            Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            getContext().getPackageManager().canRequestPackageInstalls();
        JSObject result = new JSObject();
        result.put("allowed", allowed);
        Log.i(TAG, "canInstall resolving allowed=" + allowed);
        call.resolve(result);
    }

    // The bytes are fetched here, in Java, and never cross the bridge.
    //
    // The web layer cannot do this. A release asset answers with no
    // Access-Control-Allow-Origin, so a fetch() from the WebView's origin is
    // refused before a byte arrives — a download that cannot be made to work
    // from JavaScript at all. Native HTTP has no such notion, and it also
    // means megabytes are no longer base64'd through a bridge call to be
    // written back out again.
    @PluginMethod
    public void download(PluginCall call) {
        Log.i(TAG, "download entered");
        String url = call.getString("url");
        if (url == null) {
            call.reject("download needs a url");
            return;
        }
        // Off the WebView thread: this moves megabytes and would otherwise
        // freeze the UI it is trying to keep informed.
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                String current = url;
                // Redirects are followed by hand. The release URL answers 302
                // to a signed storage host, and HttpURLConnection declines to
                // follow a redirect by itself when the host changes, so the
                // automatic follow cannot be relied on for exactly this case.
                for (int hop = 0; ; hop++) {
                    if (hop > 5) {
                        call.reject("Download failed: too many redirects");
                        return;
                    }
                    conn = (HttpURLConnection) new URL(current).openConnection();
                    conn.setInstanceFollowRedirects(false);
                    // A hang now ends as a named failure rather than a banner
                    // that sits there forever.
                    conn.setConnectTimeout(30000);
                    conn.setReadTimeout(60000);
                    Log.i(TAG, "download hop " + hop + " -> " + current);
                    int code = conn.getResponseCode();
                    Log.i(TAG, "download hop " + hop + " answered " + code);
                    if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                        String next = conn.getHeaderField("Location");
                        conn.disconnect();
                        if (next == null) {
                            call.reject("Download failed: redirect without a location");
                            return;
                        }
                        current = new URL(new URL(current), next).toString();
                        continue;
                    }
                    if (code != HttpURLConnection.HTTP_OK) {
                        call.reject("Download failed: HTTP " + code);
                        return;
                    }
                    break;
                }
                File out = new File(getContext().getCacheDir(), "update.apk");
                // A stale partial from an interrupted run must not prefix this
                // one; a half APK installs as nothing and explains nothing.
                if (out.exists() && !out.delete()) {
                    call.reject("Download failed: could not clear the previous download");
                    return;
                }
                try (
                    InputStream in = conn.getInputStream();
                    FileOutputStream sink = new FileOutputStream(out)
                ) {
                    byte[] buffer = new byte[16384];
                    for (int n; (n = in.read(buffer)) != -1;) sink.write(buffer, 0, n);
                }
                Log.i(TAG, "download wrote " + out.length() + " bytes to " + out.getAbsolutePath());
                JSObject result = new JSObject();
                result.put("path", out.getAbsolutePath());
                call.resolve(result);
            } catch (Exception error) {
                Log.e(TAG, "download failed", error);
                call.reject("Download failed: " + error);
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        Intent intent = new Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:" + getContext().getPackageName())
        );
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        if (path == null) {
            call.reject("install needs a path");
            return;
        }
        Uri uri = FileProvider.getUriForFile(
            getContext(),
            getContext().getPackageName() + ".fileprovider",
            new File(path)
        );
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION
        );
        getContext().startActivity(intent);
        call.resolve();
    }
}
