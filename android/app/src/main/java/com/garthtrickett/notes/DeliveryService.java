package com.garthtrickett.notes;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

// User-started compatibility path before Android 14; automatic work stays in JobScheduler.
public class DeliveryService extends Service {
    private boolean ownsRun;
    @Override public int onStartCommand(Intent intent,int flags,int startId) {
        if(DeliveryRunner.running()) { stopSelf(startId);return START_NOT_STICKY; }
        ownsRun=true;
        startForeground(DeliveryJobs.NOTIFICATION,DeliveryJobs.notification(this,"Connecting to media inbox…"));
        DeliveryRunner.start(this,true,text->getSystemService(android.app.NotificationManager.class)
            .notify(DeliveryJobs.NOTIFICATION,DeliveryJobs.notification(this,text)),()-> { ownsRun=false;stopForeground(STOP_FOREGROUND_REMOVE);stopSelf(); });
        return START_NOT_STICKY;
    }
    @Override public void onDestroy() { if(ownsRun)DeliveryRunner.cancel();ownsRun=false;super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
