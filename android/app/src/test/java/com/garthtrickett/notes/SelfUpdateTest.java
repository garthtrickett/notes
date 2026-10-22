package com.garthtrickett.notes;

import static org.junit.Assert.*;
import android.Manifest;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.util.ArrayMap;
import java.io.File;
import java.nio.file.Files;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Robolectric;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowToast;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36)
public class SelfUpdateTest {
    private Context context;
    private PackageInstaller installer;
    private NotificationManager notifications;

    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        installer = context.getPackageManager().getPackageInstaller();
        notifications = context.getSystemService(NotificationManager.class);
        SelfUpdate.state(context).edit().clear().commit();
        Shadows.shadowOf(notifications).setNotificationsEnabled(true);
    }

    @Test public void carriesForwardBothAllowedAndDeniedAndAlwaysRequiresUserConfirmation() throws Exception {
        for (boolean allowed : new boolean[] {true, false}) {
            PackageInstaller.SessionParams params = SelfUpdate.parameters(context, allowed);
            ArrayMap<String, Integer> states = ReflectionHelpers.getField(params, "mPermissionStates");
            assertEquals(Integer.valueOf(allowed ? PackageInstaller.SessionParams.PERMISSION_STATE_GRANTED
                : PackageInstaller.SessionParams.PERMISSION_STATE_DENIED), states.get(Manifest.permission.USE_FULL_SCREEN_INTENT));
            assertEquals(1, states.size());
            assertEquals(Integer.valueOf(PackageInstaller.SessionParams.USER_ACTION_REQUIRED),
                ReflectionHelpers.getField(params, "requireUserAction"));
            int id = installer.createSession(params);
            assertEquals(context.getPackageName(), installer.getSessionInfo(id).getAppPackageName());
        }
    }

    private File download(String packageName) throws Exception {
        File apk = new File(context.getCacheDir(), "update.apk");
        Files.write(apk.toPath(), new byte[] {1, 2, 3});
        PackageInfo info = new PackageInfo(); info.packageName = packageName;
        Shadows.shadowOf(context.getPackageManager()).setPackageArchiveInfo(apk.getPath(), info);
        return apk;
    }

    @Test public void stagesOwnCachedApkAndUsesPrivateMutableSessionSpecificCallback() throws Exception {
        SelfUpdate.install(context, download(context.getPackageName()));
        assertEquals(1, installer.getMySessions().size());
        int id = installer.getMySessions().get(0).getSessionId();
        assertTrue(SelfUpdate.state(context).getBoolean("session-" + id, false));
        PendingIntent callback = SelfUpdate.callback(context, id);
        assertFalse(callback.isImmutable());
        Intent target = Shadows.shadowOf(callback).getSavedIntent();
        assertEquals(new ComponentName(context, UpdateInstallReceiver.class), target.getComponent());
        assertEquals("notes-update://session/" + id, target.getDataString());
        assertNotEquals(callback, SelfUpdate.callback(context, id + 1));
        assertNull(Shadows.shadowOf(RuntimeEnvironment.getApplication()).getNextStartedActivity());
    }

    @Test public void refusesOtherPackagesOrAnArbitraryFileBeforeCreatingASession() throws Exception {
        assertThrows(java.io.IOException.class, () -> SelfUpdate.install(context, download("some.other.app")));
        File outside = new File(context.getFilesDir(), "update.apk");
        Files.write(outside.toPath(), new byte[] {1});
        assertThrows(java.io.IOException.class, () -> SelfUpdate.install(context, outside));
        assertTrue(installer.getMySessions().isEmpty());
    }

    private int session() throws Exception {
        int id = installer.createSession(SelfUpdate.parameters(context, true));
        SelfUpdate.state(context).edit().putBoolean("session-" + id, true).commit();
        return id;
    }

    private Intent result(int id, int status) {
        return new Intent(Shadows.shadowOf(SelfUpdate.callback(context, id)).getSavedIntent())
            .putExtra(PackageInstaller.EXTRA_SESSION_ID, id).putExtra(PackageInstaller.EXTRA_STATUS, status);
    }

    @Test public void backgroundConfirmationRequiresANotificationTapAndNeverAFullScreenIntent() throws Exception {
        int id = session();
        Intent confirmation = new Intent("test.install.confirm").setPackage("com.android.packageinstaller");
        new UpdateInstallReceiver().onReceive(context, result(id, PackageInstaller.STATUS_PENDING_USER_ACTION)
            .putExtra(Intent.EXTRA_INTENT, confirmation));
        assertNull(Shadows.shadowOf(RuntimeEnvironment.getApplication()).getNextStartedActivity());
        Notification note = Shadows.shadowOf(notifications).getNotification("notes-update", id);
        assertNotNull(note); assertNull(note.fullScreenIntent);
        assertTrue(note.contentIntent.isImmutable());
        note.contentIntent.send();
        assertEquals("test.install.confirm", Shadows.shadowOf(RuntimeEnvironment.getApplication())
            .getNextStartedActivity().getAction());
    }

    public static class VisibleActivity extends androidx.appcompat.app.AppCompatActivity {
        @Override public boolean hasWindowFocus() { return true; }
    }

    @Test public void foregroundUpdateOpensAndroidConfirmationWithoutAnotherNotificationTap() throws Exception {
        org.robolectric.android.controller.ActivityController<VisibleActivity> controller =
            Robolectric.buildActivity(VisibleActivity.class).setup();
        VisibleActivity activity = controller.get();
        UpdatePlugin plugin = new UpdatePlugin() {
            @Override public androidx.appcompat.app.AppCompatActivity getActivity() { return activity; }
            @Override public Context getContext() { return context; }
        };
        plugin.load();
        try {
            int id = session();
            new UpdateInstallReceiver().onReceive(context, result(id, PackageInstaller.STATUS_PENDING_USER_ACTION)
                .putExtra(Intent.EXTRA_INTENT, new Intent("test.install.confirm")));
            assertEquals("test.install.confirm", Shadows.shadowOf(activity).getNextStartedActivity().getAction());
            assertTrue(Shadows.shadowOf(notifications).getAllNotifications().isEmpty());
        } finally {
            plugin.handleOnDestroy();
            controller.pause().stop().destroy();
        }
    }

    @Test public void terminalCancellationClearsOnlyThatSessionAndItsNotification() throws Exception {
        int id = session(), other = session();
        new UpdateInstallReceiver().onReceive(context, result(id, PackageInstaller.STATUS_PENDING_USER_ACTION)
            .putExtra(Intent.EXTRA_INTENT, new Intent("test.install.confirm")));
        new UpdateInstallReceiver().onReceive(context, result(id, PackageInstaller.STATUS_FAILURE_ABORTED));
        assertFalse(SelfUpdate.state(context).getBoolean("session-" + id, false));
        assertTrue(SelfUpdate.state(context).getBoolean("session-" + other, false));
        assertNull(Shadows.shadowOf(notifications).getNotification("notes-update", id));
        assertNull(SelfUpdate.state(context).getString("failure", null));
    }

    @Test public void ignoresUnknownSessionAndMismatchedCallbackIdentity() throws Exception {
        int id = session();
        new UpdateInstallReceiver().onReceive(context, result(id + 100, PackageInstaller.STATUS_FAILURE));
        new UpdateInstallReceiver().onReceive(context, result(id, PackageInstaller.STATUS_FAILURE)
            .putExtra(PackageInstaller.EXTRA_SESSION_ID, id + 1));
        assertTrue(SelfUpdate.state(context).getBoolean("session-" + id, false));
        assertNull(SelfUpdate.state(context).getString("failure", null));
    }

    @Test public void unavailableConfirmationAbandonsSessionAndReportsFailureOnceOnResume() throws Exception {
        int id = session();
        Shadows.shadowOf(notifications).setNotificationsEnabled(false);
        new UpdateInstallReceiver().onReceive(context, result(id, PackageInstaller.STATUS_PENDING_USER_ACTION)
            .putExtra(Intent.EXTRA_INTENT, new Intent("test.install.confirm")));
        assertNull(installer.getSessionInfo(id));
        assertFalse(SelfUpdate.state(context).getBoolean("session-" + id, false));
        SelfUpdate.showFailure(context); SelfUpdate.showFailure(context);
        assertEquals(1, ShadowToast.shownToastCount());
        assertTrue(ShadowToast.getTextOfLatestToast().contains("Retry"));
    }

    @Test public void missingConfirmationDoesNotClaimSuccessOrLeaveAPendingSession() throws Exception {
        int id = session();
        new UpdateInstallReceiver().onReceive(context, result(id, PackageInstaller.STATUS_PENDING_USER_ACTION));
        assertNull(installer.getSessionInfo(id));
        assertNotNull(SelfUpdate.state(context).getString("failure", null));
    }

    @Test public void terminalResultReportsFailureOnlyWhenNeeded() throws Exception {
        int id = session();
        new UpdateInstallReceiver().onReceive(context, result(id, PackageInstaller.STATUS_SUCCESS));
        assertNull(SelfUpdate.state(context).getString("failure", null));
        assertFalse(SelfUpdate.state(context).getBoolean("session-" + id, false));
        int failed = session();
        new UpdateInstallReceiver().onReceive(context, result(failed, PackageInstaller.STATUS_FAILURE_INVALID));
        assertNotNull(SelfUpdate.state(context).getString("failure", null));
    }

    @Test public void callbackReceiverCannotBeInvokedByAnotherApp() throws Exception {
        assertFalse(context.getPackageManager().getReceiverInfo(new ComponentName(context,
            UpdateInstallReceiver.class), PackageManager.GET_META_DATA).exported);
    }
}
