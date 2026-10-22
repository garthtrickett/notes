package com.garthtrickett.notes;

import static org.junit.Assert.*;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;
import java.util.Calendar;
import java.util.TimeZone;
import org.junit.Before;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import org.robolectric.shadows.ShadowAppWidgetManager;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36)
public class UrgeWidgetTest {
    private Context context;
    private AppWidgetManager manager;
    private ShadowAppWidgetManager widgets;
    private UrgeWidget receiver;

    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("urge-widget", Context.MODE_PRIVATE).edit().clear().commit();
        manager = AppWidgetManager.getInstance(context);
        widgets = Shadows.shadowOf(manager);
        // Robolectric does not dispatch these manifest receiver broadcasts by
        // itself. Register the declared class so actual RemoteViews clicks
        // exercise the PendingIntent and receiver, rather than calling it here.
        receiver = new UrgeWidget();
        IntentFilter actions = new IntentFilter(UrgeWidget.RESIST);
        actions.addAction(UrgeWidget.UNDO);
        context.registerReceiver(receiver, actions, Context.RECEIVER_NOT_EXPORTED);
    }

    @After public void teardown() {
        context.unregisterReceiver(receiver);
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
    }

    private long bali(int day, int hour, int minute) {
        Calendar c = Calendar.getInstance(TimeZone.getTimeZone("Asia/Makassar"));
        c.clear(); c.set(2026, Calendar.OCTOBER, day, hour, minute);
        return c.getTimeInMillis();
    }

    @Test public void countsSurviveNewContextAndResetAtBaliMidnight() throws Exception {
        long before = bali(22, 23, 59), after = bali(23, 0, 0);
        UrgeCounter.adjust(context, before, 1);
        UrgeCounter.adjust(context, before, 1);
        Context fresh = context.createPackageContext(context.getPackageName(), 0);
        assertEquals(2, UrgeCounter.today(fresh, before));
        TimeZone original = TimeZone.getDefault();
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("America/Los_Angeles"));
            assertEquals(0, UrgeCounter.today(fresh, after));
            UrgeCounter.adjust(fresh, after, 1);
            assertEquals(1, UrgeCounter.today(context, after));
        } finally { TimeZone.setDefault(original); }
    }

    @Test public void undoNeverMakesCountNegativeOrBorrowsFromYesterday() {
        UrgeCounter.adjust(context, bali(22, 23, 59), 1);
        UrgeCounter.adjust(context, bali(23, 0, 0), -1);
        assertEquals(0, UrgeCounter.today(context, bali(23, 0, 0)));
        UrgeCounter.adjust(context, bali(23, 0, 1), -1);
        assertEquals(0, UrgeCounter.today(context, bali(23, 0, 1)));
    }

    @Test public void realRemoteViewButtonsCountWithoutOpeningAnActivityAndRefreshAllCopies() throws Exception {
        int[] ids = widgets.createWidgets(UrgeWidget.class, R.layout.urge_widget, 2);
        View first = widgets.getViewFor(ids[0]);
        assertFalse(first.findViewById(R.id.urge_undo).isEnabled());
        assertTrue(first.findViewById(R.id.urge_resist).performClick());
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        assertEquals(1, UrgeCounter.today(context, System.currentTimeMillis()));
        for (int id : ids) {
            View view = widgets.getViewFor(id);
            assertEquals("1 pause today", ((TextView) view.findViewById(R.id.urge_count)).getText().toString());
            assertTrue(view.findViewById(R.id.urge_undo).isEnabled());
        }
        assertNull(Shadows.shadowOf(RuntimeEnvironment.getApplication()).getNextStartedActivity());
        assertTrue(widgets.getViewFor(ids[1]).findViewById(R.id.urge_undo).performClick());
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        assertEquals(0, UrgeCounter.today(context, System.currentTimeMillis()));
        for (int id : ids) assertFalse(widgets.getViewFor(id).findViewById(R.id.urge_undo).isEnabled());
    }

    @Test public void staleWidgetAndUnrelatedBroadcastCannotCount() {
        new UrgeWidget().onReceive(context, new Intent(context, UrgeWidget.class)
            .setAction(UrgeWidget.RESIST).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, 999));
        new UrgeWidget().onReceive(context, new Intent("unrelated"));
        assertEquals(0, UrgeCounter.today(context, System.currentTimeMillis()));
    }

    @Test public void manifestRegistersPrivateDiscoverableHomeScreenWidget() throws Exception {
        ActivityInfo info = context.getPackageManager().getReceiverInfo(
            new ComponentName(context, UrgeWidget.class), PackageManager.GET_META_DATA);
        assertFalse(info.exported);
        assertEquals(R.xml.urge_widget_info, info.metaData.getInt("android.appwidget.provider"));
    }

    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
    public void minimumLayoutKeepsButtonsAndPromptVisibleWithLargerText() throws Exception {
        assertLayout(260, 260, 1f);
        assertLayout(260, 260, 1.3f);
    }

    private void assertLayout(int width, int height, float fontScale) throws Exception {
        Configuration config = new Configuration(context.getResources().getConfiguration());
        config.fontScale = fontScale;
        Context scaled = context.createConfigurationContext(config);
        float density = scaled.getResources().getDisplayMetrics().density;
        width = Math.round(width * density);
        height = Math.round(height * density);
        FrameLayout host = new FrameLayout(scaled);
        View view = android.view.LayoutInflater.from(scaled).inflate(R.layout.urge_widget, host, false);
        host.addView(view, new FrameLayout.LayoutParams(width, height));
        host.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
        host.layout(0, 0, width, height);
        android.graphics.Bitmap image = android.graphics.Bitmap.createBitmap(width, height,
            android.graphics.Bitmap.Config.ARGB_8888);
        host.draw(new android.graphics.Canvas(image));
        java.io.File directory = new java.io.File("build/reports/widget");
        directory.mkdirs();
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(
                new java.io.File(directory, "preview-" + fontScale + ".png"))) {
            image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out);
        }
        assertTextsVisible((ViewGroup) view, height);
        assertTrue(view.findViewById(R.id.urge_resist).getHeight() >= Math.round(48 * density));
        assertTrue(view.findViewById(R.id.urge_undo).getHeight() >= Math.round(48 * density));
    }

    private void assertTextsVisible(ViewGroup group, int rootHeight) {
        for (int i = 0; i < group.getChildCount(); i++) {
            View child = group.getChildAt(i);
            if (child instanceof TextView) {
                TextView text = (TextView) child;
                assertTrue(text.getText() + " clipped vertically: height=" + text.getHeight()
                    + ", content=" + text.getLayout().getHeight()
                    + ", textSize=" + text.getTextSize() + ", width=" + text.getWidth()
                    + ", padding=" + (text.getCompoundPaddingTop() + text.getCompoundPaddingBottom()), text.getHeight() >=
                    text.getLayout().getHeight() + text.getCompoundPaddingTop() + text.getCompoundPaddingBottom());
                int[] location = new int[2]; text.getLocationInWindow(location);
                assertTrue(text.getText() + " outside widget", location[1] + text.getHeight() <= rootHeight);
            } else if (child instanceof ViewGroup) assertTextsVisible((ViewGroup) child, rootHeight);
        }
    }
}
