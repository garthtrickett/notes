package com.garthtrickett.notes;

import static org.junit.Assert.*;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Looper;
import android.widget.Button;
import android.widget.EditText;
import java.time.Instant;
import java.util.TimeZone;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36)
public class LookupTest {
    public static class NonRemovingLookupActivity extends LookupActivity {
        @Override public void finishAndRemoveTask() {
            throw new AssertionError("Popup must not remove tasks and stop a paused media service");
        }
    }
    private Context context;
    private static final String ID = "12345678-1234-4123-8123-123456789abc";
    @Before public void setup() throws Exception {
        drain();
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("lookup-inbox", Context.MODE_PRIVATE).edit().clear().commit();
    }
    private void drain() throws Exception {
        LookupInbox.worker.submit(() -> {}).get(5, TimeUnit.SECONDS);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
    }
    @Test public void saveSurvivesNewContextUsesCaptureDayAndIsIdempotent() throws Exception {
        TimeZone old = TimeZone.getDefault();
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("Asia/Makassar"));
            LookupInbox inbox = new LookupInbox(context);
            long at = Instant.parse("2026-10-22T19:15:00Z").toEpochMilli(); // 03:15 next day
            inbox.save(ID, "  A question  ", at);
            inbox.save(ID, "A question", at + 99_000);
            var fresh = new LookupInbox(context.createPackageContext(context.getPackageName(), 0)).pending();
            assertEquals(1, fresh.length());
            assertEquals("2026-10-22", fresh.getJSONObject(0).getString("day"));
            assertEquals("03:15", fresh.getJSONObject(0).getString("time"));
            assertEquals("A question", fresh.getJSONObject(0).getString("text"));
            assertThrows(Exception.class, () -> inbox.save(ID, "different question", at));
            inbox.acknowledge(ID); inbox.acknowledge(ID);
            assertEquals(0, inbox.pending().length());
        } finally { TimeZone.setDefault(old); }
    }
    @Test public void refusesInvalidEmptyAndOversizedCapturesWithoutChangingQueue() throws Exception {
        LookupInbox inbox = new LookupInbox(context);
        assertThrows(Exception.class, () -> inbox.save("../../oops", "hello", 0));
        assertThrows(Exception.class, () -> inbox.save(ID, "  ", 0));
        assertThrows(Exception.class, () -> inbox.save(ID, "x".repeat(2001), 0));
        assertEquals(0, inbox.pending().length());
    }
    @Test public void directWidgetPendingIntentOpensOnlyPrivateComposerAndPreservesCounters() throws Exception {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        var widgets = Shadows.shadowOf(manager);
        int[] ids = widgets.createWidgets(UrgeWidget.class, R.layout.urge_widget, 1);
        UrgeCounter.toggleEating(context);
        UrgeCounter.adjust(context, System.currentTimeMillis(), 1);
        assertTrue(widgets.getViewFor(ids[0]).findViewById(R.id.urge_lookup).performClick());
        Intent intent = Shadows.shadowOf(RuntimeEnvironment.getApplication()).getNextStartedActivity();
        assertEquals(new ComponentName(context, LookupActivity.class), intent.getComponent());
        assertTrue((intent.getFlags() & Intent.FLAG_ACTIVITY_NEW_TASK) != 0);
        assertNull(Shadows.shadowOf(RuntimeEnvironment.getApplication()).getNextStartedActivity());
        var info = context.getPackageManager().getActivityInfo(intent.getComponent(), PackageManager.GET_META_DATA);
        assertFalse(info.exported);
        // Android represents the manifest's empty affinity as null: this
        // activity must not inherit MainActivity's normal app affinity.
        assertNull(info.taskAffinity);
        assertTrue(UrgeCounter.isEating(context));
        assertEquals(1, UrgeCounter.today(context, System.currentTimeMillis()));
    }
    @Test public void saveWritesBeforeClosingAndDoesNotOpenMainApp() throws Exception {
        var controller = Robolectric.buildActivity(LookupActivity.class).setup();
        LookupActivity activity = controller.get();
        Button save = activity.findViewById(R.id.lookup_save);
        assertFalse(save.isEnabled());
        EditText text = activity.findViewById(R.id.lookup_question);
        text.setText("What made the rings of Saturn?");
        assertTrue(save.isEnabled());
        assertTrue(save.performClick());
        assertFalse(save.isEnabled());
        drain();
        assertTrue(activity.isFinishing());
        assertEquals("What made the rings of Saturn?", new LookupInbox(context).pending().getJSONObject(0).getString("text"));
        assertNull(Shadows.shadowOf(RuntimeEnvironment.getApplication()).getNextStartedActivity());
        controller.pause().stop().destroy();
    }
    @Test public void rotationRetainsDraftAndBackWithoutSaveLeavesNoCapture() throws Exception {
        var controller = Robolectric.buildActivity(LookupActivity.class).setup();
        ((EditText)controller.get().findViewById(R.id.lookup_question)).setText("Keep this draft");
        controller.recreate();
        assertEquals("Keep this draft", ((EditText)controller.get().findViewById(R.id.lookup_question)).getText().toString());
        controller.get().findViewById(R.id.lookup_cancel).performClick();
        assertTrue(controller.get().isFinishing());
        drain();
        assertEquals(0, new LookupInbox(context).pending().length());
        controller.pause().stop().destroy();
    }
    @Test public void rotationDuringSaveProducesOneCaptureWithSameId() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        LookupInbox.worker.execute(() -> { entered.countDown(); try { release.await(5, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } });
        assertTrue(entered.await(2, TimeUnit.SECONDS));
        var controller = Robolectric.buildActivity(LookupActivity.class).setup();
        try {
            ((EditText)controller.get().findViewById(R.id.lookup_question)).setText("Save once through rotation");
            controller.get().findViewById(R.id.lookup_save).performClick();
            controller.recreate();
        } finally { release.countDown(); }
        drain();
        assertEquals(1, new LookupInbox(context).pending().length());
        assertTrue(controller.get().isFinishing());
        controller.pause().stop().destroy();
    }
    @Test public void bothSaveAndCancelCloseOnlyTheComposerWithoutRemovingTasks() throws Exception {
        for (boolean save : new boolean[] { false, true }) {
            var controller = Robolectric.buildActivity(NonRemovingLookupActivity.class).setup();
            var activity = controller.get();
            ((EditText)activity.findViewById(R.id.lookup_question)).setText("Keep the paused player alone");
            activity.findViewById(save ? R.id.lookup_save : R.id.lookup_cancel).performClick();
            drain();
            assertTrue(activity.isFinishing());
            controller.pause().stop().destroy();
        }
    }
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
    public void composerKeepsQuestionAndButtonsVisibleInKeyboardSizedSpace() throws Exception {
        var controller = Robolectric.buildActivity(LookupActivity.class).setup();
        var activity = controller.get();
        ((EditText)activity.findViewById(R.id.lookup_question)).setText("Why do Saturn's rings have gaps?");
        android.view.View root = activity.findViewById(android.R.id.content);
        float density = activity.getResources().getDisplayMetrics().density;
        int width = Math.round(360 * density), height = Math.round(340 * density);
        root.measure(android.view.View.MeasureSpec.makeMeasureSpec(width, android.view.View.MeasureSpec.EXACTLY),
            android.view.View.MeasureSpec.makeMeasureSpec(height, android.view.View.MeasureSpec.EXACTLY));
        root.layout(0, 0, width, height);
        for (int id : new int[] { R.id.lookup_question, R.id.lookup_save, R.id.lookup_cancel }) {
            android.view.View view = root.findViewById(id);
            int[] position = new int[2]; view.getLocationInWindow(position);
            assertTrue(position[1] + view.getHeight() <= height);
            assertTrue(view.getHeight() >= Math.round(48 * density));
        }
        var bitmap = android.graphics.Bitmap.createBitmap(width, height, android.graphics.Bitmap.Config.ARGB_8888);
        root.draw(new android.graphics.Canvas(bitmap));
        var directory = new java.io.File("build/reports/widget"); directory.mkdirs();
        try (var out = new java.io.FileOutputStream(new java.io.File(directory, "lookup-composer.png"))) {
            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out);
        }
        controller.pause().stop().destroy();
    }
}
