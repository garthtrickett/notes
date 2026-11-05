package com.garthtrickett.notes;

import static org.junit.Assert.*;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.Context;
import android.content.Intent;
import android.app.Notification;
import android.app.NotificationManager;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Robolectric;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=36)
public class DeliveryPushTest {
    private Context context;
    private DeliveryProfile profile;
    private Map<String,String> data;
    @Before public void prepare() {
        context=RuntimeEnvironment.getApplication();profile=new DeliveryProfile(context);
        profile.prefs.edit().clear().putString("secret","test-only-placeholder")
            .putBoolean("automatic",true).putBoolean("wifiOnly",true).commit();
        data=new HashMap<>(Map.of("schema","1","event","media-ready","generation","a".repeat(64)));
    }
    @Test public void wakeHintRequiresExpectedProjectAndShapeAndNeverSelectsRemotePaths() {
        AtomicInteger started=new AtomicInteger();
        DeliveryPush.Launcher launcher=high->{assertTrue(high);started.incrementAndGet();};
        assertFalse(DeliveryPush.accept(context,"other-project",data,true,launcher));
        data.put("generation","https://untrusted.example/file");
        assertFalse(DeliveryPush.accept(context,DeliveryPush.SENDER,data,true,launcher));
        data.put("generation","a".repeat(64));data.put("event","download-url");
        assertFalse(DeliveryPush.accept(context,DeliveryPush.SENDER,data,true,launcher));
        data.put("event","media-ready");
        assertTrue(DeliveryPush.accept(context,DeliveryPush.SENDER,data,true,launcher));
        assertEquals(1,started.get());
    }
    @Test public void automaticOffOrUnconfiguredIgnoresAlreadyInFlightPushes() throws Exception {
        DeliveryPush.Launcher forbidden=high->{fail("Automatic download must stay disabled");};
        profile.prefs.edit().putBoolean("automatic",false).commit();
        assertFalse(DeliveryPush.accept(context,DeliveryPush.SENDER,data,true,forbidden));
        DeliveryJobs.push(context,true);
        assertNull(context.getSystemService(JobScheduler.class).getPendingJob(DeliveryJobs.PUSH));
        profile.prefs.edit().clear().commit();
        assertFalse(DeliveryPush.accept(context,DeliveryPush.SENDER,data,true,forbidden));
    }
    @Test public void tokenCallbackCommitsBeforeDurableNetworkJobAndRetriesRemainSeparateFromDownloads() {
        DeliveryPush.token(context,"test-only-token:1234567890");
        JobScheduler scheduler=context.getSystemService(JobScheduler.class);
        JobInfo registration=scheduler.getPendingJob(DeliveryRegistration.JOB);
        assertNotNull(registration);assertTrue(registration.isPersisted());
        assertEquals(JobInfo.NETWORK_TYPE_ANY,registration.getNetworkType());
        assertFalse(registration.isUserInitiated());
        assertTrue(profile.prefs.getBoolean("pushRegistrationPending",false));
        assertEquals("test-only-token:1234567890",profile.prefs.getString("pushToken",""));
        long before=profile.prefs.getLong("pushRevision",0);
        DeliveryPush.token(context,"replacement-test-token:1234567890");
        assertTrue(profile.prefs.getLong("pushRevision",0)>before);
        assertEquals(registration,scheduler.getPendingJob(DeliveryRegistration.JOB));
        assertNull(scheduler.getPendingJob(DeliveryJobs.MANUAL));
        DeliveryPush.token(context,"invalid\ntoken");
        assertEquals("replacement-test-token:1234567890",profile.prefs.getString("pushToken",""));
    }
    @Test public void downgradedHintPreservesNetworkConstraintAndIsNeverAUserInitiatedJob() throws Exception {
        AtomicInteger ordinary=new AtomicInteger();
        assertTrue(DeliveryPush.accept(context,DeliveryPush.SENDER,data,false,high->{
            assertFalse(high);ordinary.incrementAndGet();DeliveryJobs.push(context,high);
        }));
        assertEquals(1,ordinary.get());
        JobScheduler scheduler=context.getSystemService(JobScheduler.class);
        JobInfo info=scheduler.getPendingJob(DeliveryJobs.PUSH);
        assertNotNull(info);assertFalse(info.isUserInitiated());assertFalse(info.isPeriodic());
        assertEquals(JobInfo.NETWORK_TYPE_UNMETERED,info.getNetworkType());
        assertTrue(info.isRequireStorageNotLow());
        assertNull(scheduler.getPendingJob(DeliveryJobs.MANUAL));
        profile.prefs.edit().putBoolean("wifiOnly",false).commit();DeliveryJobs.push(context,false);
        assertEquals(JobInfo.NETWORK_TYPE_ANY,scheduler.getPendingJob(DeliveryJobs.PUSH).getNetworkType());
        profile.prefs.edit().putBoolean("automatic",false).commit();DeliveryJobs.periodic(context);
        assertNull(scheduler.getPendingJob(DeliveryJobs.PUSH));
    }
    @Test public void pauseCancelsPendingPushButKeepsPeriodicPreference() throws Exception {
        DeliveryJobs.periodic(context);DeliveryJobs.push(context,false);DeliveryJobs.stop(context);
        JobScheduler scheduler=context.getSystemService(JobScheduler.class);
        assertNull(scheduler.getPendingJob(DeliveryJobs.PUSH));
        assertNotNull(scheduler.getPendingJob(DeliveryJobs.AUTOMATIC));
        assertTrue(profile.automatic());
        assertFalse(profile.prefs.getBoolean("pushPending",true));
    }
    @Test public void visibleReadyNoticeIsDismissibleAndNeverReplacesForegroundProgress() {
        NotificationManager manager=context.getSystemService(NotificationManager.class);
        DeliveryJobs.readyNotice(context);
        assertEquals(1,manager.getActiveNotifications().length);
        assertEquals(0,manager.getActiveNotifications()[0].getNotification().flags&Notification.FLAG_ONGOING_EVENT);
        DeliveryJobs.clearReadyNotice(context);assertEquals(0,manager.getActiveNotifications().length);
        Notification progress=DeliveryJobs.notification(context,"Existing transfer");
        manager.notify(DeliveryJobs.PUSH_NOTIFICATION,progress);
        DeliveryJobs.readyNotice(context);DeliveryJobs.clearReadyNotice(context);
        assertEquals("Existing transfer",manager.getActiveNotifications()[0].getNotification().extras.getString(Notification.EXTRA_TEXT));
    }
    @Test public void foregroundTimeoutReleasesWakeLockAndLeavesNoLiveDownload() throws Exception {
        var controller=Robolectric.buildService(DeliveryService.class).create();
        DeliveryService service=controller.get();
        service.onStartCommand(new Intent(context,DeliveryService.class).setAction(DeliveryService.PUSH),0,1);
        android.os.PowerManager.WakeLock lock=org.robolectric.shadows.ShadowPowerManager.getLatestWakeLock();
        assertNotNull(lock);assertTrue(lock.isHeld());
        service.onTimeout(1,android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        assertFalse(lock.isHeld());assertTrue(Shadows.shadowOf(service).isStoppedBySelf());
        // No selected folder: the real runner exits before network or credentials.
        DeliveryRunner.FILES.submit(()->{}).get(5,java.util.concurrent.TimeUnit.SECONDS);
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        assertFalse(DeliveryRunner.running());controller.destroy();
    }
}
