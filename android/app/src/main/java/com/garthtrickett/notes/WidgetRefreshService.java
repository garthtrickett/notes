package com.garthtrickett.notes;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

/** User-started notification and media request; the vault engine also serves jobs. */
public class WidgetRefreshService extends Service {
    private static final int NOTICE = 4911;
    private boolean started, ended;
    private VaultSyncSession.Handle sync;
    @Override public int onStartCommand(Intent intent, int flags, int id) {
        if (started) return START_NOT_STICKY;
        started = true;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (android.os.Build.VERSION.SDK_INT >= 26)
            manager.createNotificationChannel(new NotificationChannel("notes-widget-sync", "Widget sync", NotificationManager.IMPORTANCE_LOW));
        Notification.Builder builder = android.os.Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, "notes-widget-sync") : new Notification.Builder(this);
        Notification notice = builder.setSmallIcon(android.R.drawable.stat_notify_sync).setContentTitle("Syncing Notes")
            .setContentText("Refreshing notes and checking media…").setOngoing(true).setOnlyAlertOnce(true).build();
        try { startForeground(NOTICE, notice); }
        catch (RuntimeException refused) { finish(); return START_NOT_STICKY; }
        if (new DeliveryProfile(this).configured()) {
            try { DeliveryJobs.fetch(this); }
            catch (Exception refused) { DeliveryRunner.message("Media check could not start. Open Fetch media to retry."); }
        }
        sync = VaultSyncSession.request(this, ok -> finish());
        return START_NOT_STICKY;
    }
    private void finish() {
        if (ended) return;
        ended = true;
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }
    @Override public void onTimeout(int id, int type) { if (sync != null) sync.cancel(); finish(); }
    @Override public void onDestroy() { if (sync != null) sync.cancel(); super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
