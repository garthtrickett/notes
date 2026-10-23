package com.garthtrickett.notes;

import static org.junit.Assert.*;
import static org.robolectric.util.ReflectionHelpers.ClassParameter.from;

import android.appwidget.AppWidgetHostView;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProviderInfo;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Parcel;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.TextView;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.shadow.api.Shadow;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36)
public class WidgetRecoveryTest {
    public static class WithoutWebEngine extends MainActivity {
        // The JVM has no WebView service-worker engine. Only skip Capacitor's
        // bootstrap; retain the real MainActivity onResume and OS lifecycle.
        @Override protected void load() {}
    }

    private Context context;
    private AppWidgetManager manager;

    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("urge-widget", Context.MODE_PRIVATE).edit().clear().commit();
        manager = AppWidgetManager.getInstance(context);
        // The manager shadow ignores explicit root IDs when deciding to reuse
        // views. The two real-host tests below exercise that decision instead.
        Shadows.shadowOf(manager).setAlwaysRecreateViewsDuringUpdate(true);
    }

    // Bypass Robolectric's host shadow: it only inflates/reapplies and omits
    // Android's actual recycling and error-view recovery. Parcel the update
    // too, as the real launcher receives it across the widget-service boundary.
    private AppWidgetHostView host() throws Exception {
        AppWidgetHostView host = new AppWidgetHostView(context);
        ComponentName provider = new ComponentName(context, UrgeWidget.class);
        AppWidgetProviderInfo info = new AppWidgetProviderInfo();
        info.provider = provider;
        info.initialLayout = R.layout.urge_widget;
        info.label = "Back to my day";
        ReflectionHelpers.setField(info, "providerInfo", context.getPackageManager()
            .getReceiverInfo(provider, PackageManager.GET_META_DATA));
        Shadow.directlyOn(host, AppWidgetHostView.class, "setAppWidget",
            from(int.class, 42), from(AppWidgetProviderInfo.class, info));
        return host;
    }

    private void publish(AppWidgetHostView host, RemoteViews views) {
        Parcel parcel = Parcel.obtain();
        try {
            views.writeToParcel(parcel, 0);
            parcel.setDataPosition(0);
            RemoteViews delivered = RemoteViews.CREATOR.createFromParcel(parcel);
            Shadow.directlyOn(host, AppWidgetHostView.class, "updateAppWidget",
                from(RemoteViews.class, delivered));
        } finally {
            parcel.recycle();
        }
    }

    private void assertState(View view) {
        assertEquals("1 pause today", ((TextView) view.findViewById(R.id.urge_count)).getText().toString());
        assertEquals(context.getString(R.string.urge_widget_eating_on),
            ((TextView) view.findViewById(R.id.urge_eating)).getText().toString());
        assertTrue(view.findViewById(R.id.urge_undo).isEnabled());
        assertTrue(view.findViewById(R.id.urge_lookup).hasOnClickListeners());
        assertTrue(view.findViewById(R.id.urge_resist).hasOnClickListeners());
        assertTrue(view.findViewById(R.id.urge_eating).hasOnClickListeners());
    }

    private void setState() {
        UrgeCounter.adjust(context, System.currentTimeMillis(), 1);
        UrgeCounter.toggleEating(context);
    }

    @Test public void completeUpdateRecoversFrameworkErrorPlaceholderWithoutLosingState() throws Exception {
        setState();
        AppWidgetHostView host = host();
        // Deliberately invalid resources exercise Android's error fallback;
        // this does not claim to reproduce the unknown phone-side trigger.
        publish(host, new RemoteViews(context.getPackageName(), 0x7fffffff));
        assertNull(host.findViewById(R.id.urge_eating));
        assertEquals(1, host.getChildCount());
        publish(host, UrgeWidget.views(context, 42));
        assertState(host);
        assertEquals(1, UrgeCounter.today(context, System.currentTimeMillis()));
        assertTrue(UrgeCounter.isEating(context));
    }

    @Test public void upgradeReplacesOldHierarchyButOrdinaryRefreshCanReuseIt() throws Exception {
        setState();
        AppWidgetHostView host = host();
        publish(host, new RemoteViews(context.getPackageName(), R.layout.urge_widget));
        View legacy = host.getChildAt(0);
        publish(host, UrgeWidget.views(context, 42));
        View current = host.getChildAt(0);
        assertNotSame(legacy, current);
        assertState(host);
        publish(host, UrgeWidget.views(context, 42));
        assertSame(current, host.getChildAt(0));
        PackageInfo next = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        next.versionCode++;
        Shadows.shadowOf(context.getPackageManager()).installPackage(next);
        publish(host, UrgeWidget.views(context, 42));
        assertNotSame(current, host.getChildAt(0));
        assertState(host);
    }

    @Test public void resizingPublishesCurrentStateWithoutCountingAnotherTap() {
        int id = Shadows.shadowOf(manager).createWidget(UrgeWidget.class, R.layout.urge_widget);
        setState();
        new UrgeWidget().onAppWidgetOptionsChanged(context, manager, id, new Bundle());
        assertState(Shadows.shadowOf(manager).getViewFor(id));
        assertEquals(1, UrgeCounter.today(context, System.currentTimeMillis()));
    }

    @Test public void refreshRecoversAllCopiesAndOneRemovedIdDoesNotBlockOthers() {
        int[] ids = Shadows.shadowOf(manager).createWidgets(UrgeWidget.class, R.layout.urge_widget, 2);
        setState();
        new UrgeWidget().onUpdate(context, manager, new int[] {99999, ids[0]});
        assertState(Shadows.shadowOf(manager).getViewFor(ids[0]));
        UrgeWidget.refresh(context);
        for (int id : ids) assertState(Shadows.shadowOf(manager).getViewFor(id));
    }

    @Test public void returningToNotesRefreshesExistingWidgets() {
        int id = Shadows.shadowOf(manager).createWidget(UrgeWidget.class, R.layout.urge_widget);
        var activity = Robolectric.buildActivity(WithoutWebEngine.class).setup();
        try {
            activity.pause();
            setState();
            activity.resume();
            assertState(Shadows.shadowOf(manager).getViewFor(id));
            assertEquals(1, UrgeCounter.today(context, System.currentTimeMillis()));
        } finally {
            activity.pause().stop().destroy();
        }
    }

    @Test public void bootAndPackageReplacementRestoreEveryCopyWithoutOpeningNotes() {
        int[] ids = Shadows.shadowOf(manager).createWidgets(UrgeWidget.class, R.layout.urge_widget, 2);
        setState();
        for (String action : new String[] {Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED}) {
            // Simulate a launcher holding only the static layout. A new
            // receiver instance must restore all state/actions from storage.
            for (int id : ids) manager.updateAppWidget(id,
                new RemoteViews(context.getPackageName(), R.layout.urge_widget));
            new UrgeWidget().onReceive(context, new Intent(action));
            for (int id : ids) assertState(Shadows.shadowOf(manager).getViewFor(id));
        }
        assertEquals(1, UrgeCounter.today(context, System.currentTimeMillis()));
        assertTrue(UrgeCounter.isEating(context));
        assertNull(Shadows.shadowOf(RuntimeEnvironment.getApplication()).getNextStartedActivity());
    }

    @Test public void manifestReceivesPostUnlockBootAndKeepsPrivateStateOutOfDirectBoot() throws Exception {
        var pm = context.getPackageManager();
        var info = pm.getReceiverInfo(new ComponentName(context, UrgeWidget.class), 0);
        assertFalse(info.exported);
        assertFalse(info.directBootAware);
        assertTrue(pm.queryBroadcastReceivers(new Intent(Intent.ACTION_BOOT_COMPLETED)
            .setPackage(context.getPackageName()), 0).stream()
            .anyMatch(r -> UrgeWidget.class.getName().equals(r.activityInfo.name)));
        assertFalse(pm.queryBroadcastReceivers(new Intent(Intent.ACTION_LOCKED_BOOT_COMPLETED)
            .setPackage(context.getPackageName()), 0).stream()
            .anyMatch(r -> UrgeWidget.class.getName().equals(r.activityInfo.name)));
    }
}
