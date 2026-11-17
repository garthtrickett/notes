package com.garthtrickett.notes;

import static org.junit.Assert.*;
import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.view.View;
import android.widget.FrameLayout;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.json.JSONObject;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36)
public class WidgetRefreshTest {
    private final java.util.List<VaultSyncSession.Handle> handles = new java.util.ArrayList<>();
    private VaultSyncSession.Handle session() {
        VaultSyncSession.Handle handle = VaultSyncSession.request(RuntimeEnvironment.getApplication(), ok -> {});
        handles.add(handle); return handle;
    }
    @org.junit.After public void cleanup() throws Exception {
        for (VaultSyncSession.Handle handle : handles) handle.cancel();
        for (int i = 0; i < 400; i++) {
            Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            if (org.robolectric.util.ReflectionHelpers.getStaticField(VaultSyncSession.class, "active") == null) return;
            Thread.sleep(5);
        }
        fail("Sync session did not release its native operations");
    }
    @Test public void repeatedRequestsCoalesceAndStaleCompletionCannotFinishNewRun() throws Exception {
        var controller = Robolectric.buildService(WidgetRefreshService.class).create();
        WidgetRefreshService service = controller.get();
        service.onStartCommand(new Intent(), 0, 1);
        VaultSyncSession.Handle first = session();
        service.onStartCommand(new Intent(), 0, 2);
        assertSame(first.session, session().session);
        VaultSyncSession.complete("old-request", true);
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        assertEquals("syncing", service.getSharedPreferences("widget-refresh", Context.MODE_PRIVATE).getString("state", ""));
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(121));
        controller.destroy();
    }
    @Test public void widgetSyncStartsOnlyServiceAndRejectsRemovedWidget() {
        Context context = RuntimeEnvironment.getApplication();
        var widgets = Shadows.shadowOf(AppWidgetManager.getInstance(context));
        int[] ids = widgets.createWidgets(UrgeWidget.class, R.layout.urge_widget, 1);
        var app = Shadows.shadowOf((android.app.Application) context);
        while (app.getNextStartedService() != null) {}
        Intent request = new Intent(context, UrgeWidget.class).setAction(UrgeWidget.SYNC)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, ids[0]);
        new UrgeWidget().onReceive(context, request);
        Intent service = app.getNextStartedService();
        assertNotNull(service);
        assertEquals(WidgetRefreshService.class.getName(), service.getComponent().getClassName());
        assertNull(app.getNextStartedActivity());
        request.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -100);
        new UrgeWidget().onReceive(context, request);
        assertNull(app.getNextStartedService());
    }

    @Test public void syncButtonSurvivesRemoteViewsAndFailureCanRetry() {
        Context context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("widget-refresh", Context.MODE_PRIVATE).edit().putString("state", "error").commit();
        View root = UrgeWidget.views(context, 9).apply(context, new FrameLayout(context));
        assertTrue(root.findViewById(R.id.urge_refresh).hasOnClickListeners());
        assertTrue(root.findViewById(R.id.urge_refresh).isEnabled());
        assertTrue(((android.widget.TextView)root.findViewById(R.id.urge_sync)).getText().toString().contains("incomplete"));
    }

    @Test public void hiddenWorkerServesOnlyBundledAssetsAndPrivatePhotoRoute() throws Exception {
        VaultSyncSession service = session().session;
        assertEquals(404, service.resource(android.net.Uri.parse("https://example.com/" )).getStatusCode());
        assertEquals(404, service.resource(android.net.Uri.parse("file:///data/data/private")).getStatusCode());
        assertEquals(404, service.resource(android.net.Uri.parse("https://localhost/../private")).getStatusCode());
        assertEquals(404, service.resource(android.net.Uri.parse("https://localhost/_sync_photo/not-an-id/0")).getStatusCode());
        assertNull(service.resource(android.net.Uri.parse("https://api.github.com/repos/owner/repo")));
        assertNotNull(service.resource(android.net.Uri.parse("https://localhost/background.html")).getData());
        try { service.dispatch("readArbitraryFile", new JSONObject()); fail("Unrecognised bridge call accepted"); }
        catch (IllegalArgumentException expected) {}
    }

    @Test public void nativeCaptureIsRetainedUntilExplicitAcknowledgement() throws Exception {
        VaultSyncSession service = session().session;
        LookupInbox inbox = new LookupInbox(RuntimeEnvironment.getApplication());
        String id = java.util.UUID.randomUUID().toString();
        inbox.save(id, "remember this", System.currentTimeMillis());
        JSONObject result = (JSONObject) service.dispatch("lookups", new JSONObject());
        assertEquals(id, result.getJSONArray("captures").getJSONObject(0).getString("id"));
        assertTrue(inbox.hasPending());
        service.dispatch("lookupAck", new JSONObject().put("id", id));
        assertFalse(inbox.hasPending());
    }
}
