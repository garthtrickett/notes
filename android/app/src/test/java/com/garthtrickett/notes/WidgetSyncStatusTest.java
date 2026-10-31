package com.garthtrickett.notes;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.Intent;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;
import java.io.File;
import java.util.UUID;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36)
public class WidgetSyncStatusTest {
    private Context context;
    private static final String VAULT = "owner/vault@main";
    private static final long NOW = 1_793_404_800_000L;

    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        for (String name : new String[] {"widget-sync-status", "lookup-inbox", "notes.alarms"})
            context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit();
    }
    private WidgetSyncStatus.Display display(long at) { return WidgetSyncStatus.display(context, at); }
    private void report(String state, Long checked, long now) { WidgetSyncStatus.update(context, VAULT, state, checked, checked, now); }

    @Test public void neverCheckedFreshStaleAndClockRollbackAreDistinct() {
        assertEquals("Open Notes to check sync", display(NOW).text);
        report("synced", NOW, NOW);
        assertTrue(display(NOW).text.startsWith("✓ Synced"));
        int green = display(NOW).color;
        assertTrue(display(NOW + WidgetSyncStatus.FRESH_MS).text.startsWith("Last synced"));
        assertNotEquals(green, display(NOW + WidgetSyncStatus.FRESH_MS).color);
        assertEquals("Open Notes to check sync", display(NOW - 1).text);
    }

    @Test public void aStoppedSyncDoesNotKeepSayingSyncingAfterProcessDeath() {
        report("synced", NOW, NOW);
        report("syncing", null, NOW + 1);
        assertTrue(display(NOW + 1).text.contains("Syncing"));
        assertTrue(display(NOW + 6 * 60_000L).text.startsWith("Last synced"));
        report("pending", null, NOW + 7 * 60_000L);
        assertTrue(display(NOW + 60 * 60_000L).text.contains("Waiting to sync"));
    }

    @Test public void nativeWidgetCapturesStayPendingAfterImportUntilTheWebOutboxUploads() throws Exception {
        report("synced", NOW, NOW);
        LookupInbox inbox = new LookupInbox(context);
        String id = UUID.randomUUID().toString();
        inbox.save(id, "Synthetic question", NOW, true);
        assertTrue(display(NOW).text.contains("Waiting to sync"));
        report("pending", NOW, NOW + 1);
        inbox.acknowledge(id);
        assertTrue(display(NOW + 1).text.contains("Waiting to sync"));
        report("synced", NOW + 2, NOW + 2);
        assertTrue(display(NOW + 2).text.startsWith("✓ Synced"));
    }

    @Test public void nativePhotoAndAlarmQueuesOverrideACleanWebReport() throws Exception {
        report("synced", NOW, NOW);
        File photo = new File(context.getFilesDir(), "photo-inbox/" + UUID.randomUUID());
        assertTrue(photo.mkdirs());
        assertTrue(display(NOW).text.contains("Waiting to sync"));
        assertTrue(photo.delete());
        context.getSharedPreferences("notes.alarms", Context.MODE_PRIVATE).edit()
            .putString("answers", "[{\"kind\":\"done\"}]").commit();
        assertTrue(display(NOW).text.contains("Waiting to sync"));
    }

    @Test public void backgroundDiscoveryCannotTurnGreenAndOldReportsCannotClearIt() {
        report("synced", NOW, NOW);
        WidgetSyncStatus.remoteChanged(context, "other/vault@main", NOW + 1);
        assertTrue(display(NOW + 1).text.startsWith("✓ Synced"));
        WidgetSyncStatus.remoteChanged(context, VAULT, NOW + 2);
        assertTrue(display(NOW + 2).text.contains("New notes"));
        report("synced", NOW + 1, NOW + 3);
        assertTrue(display(NOW + 3).text.contains("New notes"));
        WidgetSyncStatus.update(context, VAULT, "synced", NOW + 4, NOW + 1, NOW + 4);
        assertTrue(display(NOW + 4).text.contains("New notes"));
        report("synced", NOW + 5, NOW + 5);
        assertTrue(display(NOW + 5).text.startsWith("✓ Synced"));
    }

    @Test public void vaultSwitchAndInvalidReportsCannotReuseAGreenCheck() {
        report("synced", NOW, NOW);
        assertThrows(IllegalArgumentException.class, () -> report("synced", null, NOW));
        assertThrows(IllegalArgumentException.class, () -> report("synced", NOW + 120_000, NOW));
        WidgetSyncStatus.update(context, "other/vault@main", "unknown", null, null, NOW + 1);
        assertEquals("Open Notes to check sync", display(NOW + 1).text);
        assertThrows(IllegalArgumentException.class, () -> report("invalid", null, NOW));
    }

    @Test public void offlineAndErrorAreReadableWithoutDependingOnColor() {
        report("offline", null, NOW);
        assertTrue(display(NOW).text.startsWith("Offline"));
        report("error", null, NOW);
        assertTrue(display(NOW).text.contains("Sync problem"));
    }

    @Test public void unreadableIndicatorPreferencesCannotInterruptTheAlarmReader() {
        context.getSharedPreferences("widget-sync-status", Context.MODE_PRIVATE).edit().putInt("vault", 42).commit();
        WidgetSyncStatus.remoteChanged(context, VAULT, NOW);
        assertEquals("Open Notes to check sync", display(NOW).text);
    }

    @Test public void existingWidgetHeaderShowsStatusAndOpensNotesDirectly() {
        report("synced", System.currentTimeMillis(), System.currentTimeMillis());
        View view = UrgeWidget.views(context, 12).apply(context, new FrameLayout(context));
        assertTrue(((TextView) view.findViewById(R.id.urge_sync)).getText().toString().startsWith("✓ Synced"));
        assertTrue(view.findViewById(R.id.urge_header).performClick());
        Intent opened = Shadows.shadowOf(RuntimeEnvironment.getApplication()).getNextStartedActivity();
        assertNotNull(opened);
        assertEquals(MainActivity.class.getName(), opened.getComponent().getClassName());
    }
}
