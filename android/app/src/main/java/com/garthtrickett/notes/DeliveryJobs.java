package com.garthtrickett.notes;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import java.io.IOException;

final class DeliveryJobs {
    static final int AUTOMATIC=4811,MANUAL=4812,NOTIFICATION=4813,PUSH=4814,PUSH_NOTIFICATION=4815;
    static final long PERIOD=15*60*1000L;
    private static final String CHANNEL="notes-media-downloads";
    static void periodic(Context context) throws IOException {
        JobScheduler scheduler=context.getSystemService(JobScheduler.class);
        if(scheduler==null) throw new IOException("Android download scheduling is unavailable.");
        DeliveryProfile profile=new DeliveryProfile(context);
        if(!profile.configured()||!profile.automatic()) { scheduler.cancel(AUTOMATIC);scheduler.cancel(PUSH);return; }
        int network=profile.wifiOnly()?JobInfo.NETWORK_TYPE_UNMETERED:JobInfo.NETWORK_TYPE_ANY;
        JobInfo current=scheduler.getPendingJob(AUTOMATIC);
        if(current!=null&&current.isPeriodic()&&current.getIntervalMillis()==PERIOD&&current.getNetworkType()==network) return;
        int result=scheduler.schedule(new JobInfo.Builder(AUTOMATIC,new ComponentName(context,DeliveryJob.class))
            .setPeriodic(PERIOD).setPersisted(true).setRequiredNetworkType(network).setRequiresStorageNotLow(true).build());
        if(result!=JobScheduler.RESULT_SUCCESS) throw new IOException("Android refused automatic downloads. Fetch now still works.");
    }
    static void checkNetwork(Context context,boolean unmetered) throws IOException {
        android.net.ConnectivityManager manager=context.getSystemService(android.net.ConnectivityManager.class);
        android.net.NetworkCapabilities network=manager==null?null:manager.getNetworkCapabilities(manager.getActiveNetwork());
        if(network==null || !network.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET))
            throw new IOException("Waiting for a connection. Fetch now to retry when connected.");
        if(unmetered && !network.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_NOT_METERED))
            throw new IOException("Unmetered connections only is enabled. Connect to Wi-Fi, or change Delivery settings.");
    }
    static void fetch(Context context) throws IOException {
        if(DeliveryRunner.running()) return;
        DeliveryProfile profile=new DeliveryProfile(context);
        if(!profile.configured()) throw new IOException("Save the media password first.");
        if(Build.VERSION.SDK_INT>=34) {
            JobScheduler scheduler=context.getSystemService(JobScheduler.class);
            if(scheduler==null||scheduler.schedule(new JobInfo.Builder(MANUAL,new ComponentName(context,DeliveryJob.class))
                .setUserInitiated(true).setRequiredNetworkType(profile.wifiOnly()?JobInfo.NETWORK_TYPE_UNMETERED:JobInfo.NETWORK_TYPE_ANY)
                .setRequiresStorageNotLow(true).build())!=JobScheduler.RESULT_SUCCESS)
                throw new IOException("Android could not start the download. Keep Notes open and try again.");
        } else {
            checkNetwork(context,profile.wifiOnly());
            androidx.core.content.ContextCompat.startForegroundService(context,new Intent(context,DeliveryService.class));
        }
        DeliveryRunner.message(profile.wifiOnly()?"Waiting for an unmetered connection…":"Waiting for a connection…");
    }
    static boolean notificationsEnabled(Context context) {
        NotificationManager manager=context.getSystemService(NotificationManager.class);
        if(manager==null||!manager.areNotificationsEnabled())return false;
        NotificationChannel channel=Build.VERSION.SDK_INT>=26?manager.getNotificationChannel(CHANNEL):null;
        return channel==null||channel.getImportance()!=NotificationManager.IMPORTANCE_NONE;
    }
    static void push(Context context,boolean high) throws IOException {
        DeliveryProfile profile=new DeliveryProfile(context);
        if(!profile.configured()||!profile.automatic())return;
        profile.prefs.edit().putBoolean("pushPending",true).commit();
        if(high)readyNotice(context);
        if(DeliveryRunner.running())return;
        // Only a HIGH message actually received by FCM grants the background
        // foreground-service exemption. A downgraded hint gets ordinary work.
        if(high&&notificationsEnabled(context)) {
            try {
                checkNetwork(context,profile.wifiOnly());
                androidx.core.content.ContextCompat.startForegroundService(context,
                    new Intent(context,DeliveryService.class).setAction(DeliveryService.PUSH));
                return;
            } catch(IllegalStateException|SecurityException|IOException delayed) {
                // Respect platform/network restrictions; never call this a UIDT.
            }
        }
        JobScheduler scheduler=context.getSystemService(JobScheduler.class);
        if(scheduler==null||scheduler.schedule(new JobInfo.Builder(PUSH,new ComponentName(context,DeliveryJob.class))
            .setRequiredNetworkType(profile.wifiOnly()?JobInfo.NETWORK_TYPE_UNMETERED:JobInfo.NETWORK_TYPE_ANY)
            .setRequiresStorageNotLow(true).build())!=JobScheduler.RESULT_SUCCESS)
            throw new IOException("Android delayed automatic media downloads. Fetch now remains available.");
    }
    static void stop(Context context) {
        new DeliveryProfile(context).prefs.edit().putBoolean("pushPending",false).commit();
        JobScheduler jobs=context.getSystemService(JobScheduler.class);
        if(jobs!=null) { jobs.cancel(MANUAL);jobs.cancel(PUSH); }
        DeliveryRunner.cancel();context.stopService(new Intent(context,DeliveryService.class));
        DeliveryRunner.message("Current transfer paused. Fetch now resumes it. Turn off automatic checks to keep downloads paused.");
        clearReadyNotice(context);
    }
    static void readyNotice(Context context) {
        if(!notificationsEnabled(context))return;
        NotificationManager manager=context.getSystemService(NotificationManager.class);
        for(android.service.notification.StatusBarNotification current:manager.getActiveNotifications())
            if(current.getId()==NOTIFICATION||current.getId()==PUSH_NOTIFICATION)return;
        manager.notify(PUSH_NOTIFICATION,notification(context,
            "New media is ready. Downloads start when your connection and Android allow.",false));
    }
    static void clearReadyNotice(Context context) {
        NotificationManager manager=context.getSystemService(NotificationManager.class);
        if(manager!=null)for(android.service.notification.StatusBarNotification current:manager.getActiveNotifications())
            if(current.getId()==PUSH_NOTIFICATION&&(current.getNotification().flags&Notification.FLAG_ONGOING_EVENT)==0)
                manager.cancel(PUSH_NOTIFICATION);
    }
    static Notification notification(Context context,String text) {
        return notification(context,text,true);
    }
    private static Notification notification(Context context,String text,boolean ongoing) {
        NotificationManager manager=context.getSystemService(NotificationManager.class);
        if(Build.VERSION.SDK_INT>=26&&manager!=null)manager.createNotificationChannel(new NotificationChannel(CHANNEL,"Media downloads",NotificationManager.IMPORTANCE_LOW));
        Intent open=new Intent(context,DeliveryActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent content=PendingIntent.getActivity(context,NOTIFICATION,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder=Build.VERSION.SDK_INT>=26?new Notification.Builder(context,CHANNEL):new Notification.Builder(context);
        return builder.setSmallIcon(android.R.drawable.stat_sys_download).setContentTitle("Notes media downloads")
            .setContentText(text).setStyle(new Notification.BigTextStyle().bigText(text)).setContentIntent(content)
            .setOnlyAlertOnce(true).setOngoing(ongoing).setAutoCancel(!ongoing).build();
    }
}
