package com.garthtrickett.notes;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.os.PowerManager;

// User-started compatibility path before Android 14, or an actual HIGH FCM wake-up.
public class DeliveryService extends Service {
    static final String PUSH="com.garthtrickett.notes.MEDIA_READY";
    private boolean ownsRun;
    private PowerManager.WakeLock awake;
    @Override public int onStartCommand(Intent intent,int flags,int startId) {
        if(ownsRun)return START_NOT_STICKY;
        boolean push=intent!=null&&PUSH.equals(intent.getAction());
        int notification=push?DeliveryJobs.PUSH_NOTIFICATION:DeliveryJobs.NOTIFICATION;
        startForeground(notification,DeliveryJobs.notification(this,"Connecting to media inbox…"));
        DeliveryProfile profile=new DeliveryProfile(this);
        if(DeliveryRunner.running()||(push&&(!profile.configured()||!profile.automatic()))) {
            stopForeground(STOP_FOREGROUND_REMOVE);stopSelf(startId);return START_NOT_STICKY;
        }
        ownsRun=true;
        PowerManager power=getSystemService(PowerManager.class);
        if(power!=null) { awake=power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"notes:media-download");awake.acquire(61*60*1000L); }
        DeliveryRunner.start(this,true,text->getSystemService(android.app.NotificationManager.class)
            .notify(notification,DeliveryJobs.notification(this,text)),()-> { ownsRun=false;release();stopForeground(STOP_FOREGROUND_REMOVE);stopSelf(); });
        return START_NOT_STICKY;
    }
    private void release() { if(awake!=null&&awake.isHeld())awake.release();awake=null; }
    @Override public void onTimeout(int startId,int type) { if(ownsRun)DeliveryRunner.cancel();release();stopForeground(STOP_FOREGROUND_REMOVE);stopSelf(); }
    @Override public void onDestroy() { if(ownsRun)DeliveryRunner.cancel();ownsRun=false;release();super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
