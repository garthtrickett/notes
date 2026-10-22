package com.garthtrickett.notes;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.widget.Toast;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.OutputStream;

/** Android 14+ self-update. Only an already allowed full-screen permission is
 * carried forward; an off setting stays off. Installation always needs consent.
 * See PackageInstaller.SessionParams.setPermissionState and AOSP's
 * PackageInstaller/v2/model/InstallRepository.kt (raw sideloads request DENIED). */
@android.annotation.TargetApi(34)
final class SelfUpdate {
    static final String RESULT = "com.garthtrickett.notes.UPDATE_INSTALL_RESULT";
    static final String CHANNEL = "notes-updates";
    private static final String TAG = "notes-update";

    static SharedPreferences state(Context context) {
        return context.getSharedPreferences("self-update", Context.MODE_PRIVATE);
    }

    static PackageInstaller.SessionParams parameters(Context context, boolean fullScreenAllowed) {
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(
            PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(context.getPackageName());
        params.setPackageSource(PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE);
        params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
        params.setPermissionState(Manifest.permission.USE_FULL_SCREEN_INTENT,
            fullScreenAllowed ? PackageInstaller.SessionParams.PERMISSION_STATE_GRANTED
                : PackageInstaller.SessionParams.PERMISSION_STATE_DENIED);
        return params;
    }

    static PendingIntent callback(Context context, int id) {
        Intent result = new Intent(context, UpdateInstallReceiver.class).setAction(RESULT)
            .setData(Uri.parse("notes-update://session/" + id));
        // Android 15+ requires a mutable result callback. It is explicit, private,
        // and unique per session; only the system receives this capability.
        return PendingIntent.getBroadcast(context, id, result,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
    }

    static void install(Context context, File file) throws IOException {
        File apk = file.getCanonicalFile();
        if (!apk.equals(new File(context.getCacheDir(), "update.apk").getCanonicalFile())
                || !apk.isFile() || apk.length() == 0) throw new IOException("Download the update again.");
        PackageInfo archive = context.getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
        if (archive == null || !context.getPackageName().equals(archive.packageName)) {
            throw new IOException("The download is not a Notes update.");
        }
        // Android verifies the installed package's signing identity at commit.
        PackageInstaller installer = context.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = parameters(context, Alarms.canFullScreen(context));
        params.setSize(apk.length());
        int id = installer.createSession(params);
        try {
            if (!state(context).edit().putBoolean("session-" + id, true).commit()) {
                throw new IOException("The update session could not be saved.");
            }
            try (PackageInstaller.Session session = installer.openSession(id)) {
                try (FileInputStream in = new FileInputStream(apk);
                        OutputStream out = session.openWrite("base.apk", 0, apk.length())) {
                    byte[] bytes = new byte[16384];
                    for (int length; (length = in.read(bytes)) != -1;) out.write(bytes, 0, length);
                    session.fsync(out);
                }
                session.commit(callback(context, id).getIntentSender());
            }
        } catch (IOException | RuntimeException error) {
            discard(context, id);
            throw error;
        }
    }

    static void result(Context context, Intent intent) {
        if (!RESULT.equals(intent.getAction()) || intent.getData() == null) return;
        int id = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1);
        if (!intent.getData().equals(Uri.parse("notes-update://session/" + id))
                || !state(context).getBoolean("session-" + id, false)) return;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirmation = intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class);
            if (confirmation != null) {
                if (UpdatePlugin.openConfirmation(confirmation)) return;
                // If Notes was backgrounded meanwhile, require a notification
                // tap instead of launching the installer over another app.
                if (offerConfirmation(context, id, confirmation)) return;
            }
            fail(context, "Update confirmation could not open. Retry the update while Notes is open.");
            discard(context, id);
        } else {
            finish(context, id);
            if (status != PackageInstaller.STATUS_SUCCESS && status != PackageInstaller.STATUS_FAILURE_ABORTED) {
                fail(context, "The update was not installed. Your current Notes version is unchanged.");
            }
        }
    }

    private static boolean offerConfirmation(Context context, int id, Intent confirmation) {
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        try {
            if (nm == null || !nm.areNotificationsEnabled()) return false;
            nm.createNotificationChannel(new NotificationChannel(CHANNEL,
                "App updates", NotificationManager.IMPORTANCE_LOW));
            PendingIntent open = PendingIntent.getActivity(context, id,
                new Intent(confirmation).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            nm.notify(TAG, id, new Notification.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("Finish updating Notes")
                .setContentText("Tap to confirm the update in Android.")
                .setContentIntent(open).setAutoCancel(true).build());
            return true;
        } catch (RuntimeException refused) { return false; }
    }

    private static void fail(Context context, String message) {
        state(context).edit().putString("failure", message).apply();
        UpdatePlugin.showInstallFailure();
    }

    static void showFailure(Context context) {
        String failure = state(context).getString("failure", null);
        if (failure != null) {
            state(context).edit().remove("failure").apply();
            Toast.makeText(context, failure, Toast.LENGTH_LONG).show();
        }
    }

    private static void finish(Context context, int id) {
        state(context).edit().remove("session-" + id).apply();
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(TAG, id);
        callback(context, id).cancel();
    }

    private static void discard(Context context, int id) {
        try { context.getPackageManager().getPackageInstaller().abandonSession(id); }
        catch (RuntimeException alreadyFinished) { /* Nothing left to abandon. */ }
        finish(context, id);
    }
}
