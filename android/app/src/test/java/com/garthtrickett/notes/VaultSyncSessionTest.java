package com.garthtrickett.notes;

import static org.junit.Assert.*;
import android.content.Context;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36)
public class VaultSyncSessionTest {
    private final Context context = RuntimeEnvironment.getApplication();
    private final List<VaultSyncSession.Handle> handles = new ArrayList<>();
    private VaultSyncSession.Handle request(VaultSyncSession.Listener listener) {
        VaultSyncSession.Handle handle = VaultSyncSession.request(context, listener);
        handles.add(handle); return handle;
    }
    static void await(java.util.function.BooleanSupplier done) throws Exception {
        for (int i = 0; i < 400; i++) {
            Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            if (done.getAsBoolean()) return;
            Thread.sleep(5);
        }
        fail("Native sync did not settle");
    }
    @After public void cleanup() throws Exception {
        for (var handle : handles) handle.cancel();
        await(() -> ReflectionHelpers.getStaticField(VaultSyncSession.class, "active") == null);
    }
    @Test public void scheduledAndManualOwnersShareOneWriterAndCancelIndependently() throws Exception {
        List<Boolean> manual = new ArrayList<>(), scheduled = new ArrayList<>();
        var first = request(scheduled::add);
        var second = request(manual::add);
        assertSame(first.session, second.session);
        first.cancel();
        assertSame(second.session, ReflectionHelpers.getStaticField(VaultSyncSession.class, "active"));
        second.session.dispatch("finished", new JSONObject().put("ok", true));
        await(() -> !manual.isEmpty());
        assertEquals(List.of(true), manual);
        assertTrue(scheduled.isEmpty());
    }
    @Test public void lastOwnerCancellationReleasesWriterAndReportsIncomplete() throws Exception {
        var handle = request(ok -> fail("Cancelled owner received a callback"));
        handle.cancel();
        await(() -> ReflectionHelpers.getStaticField(VaultSyncSession.class, "active") == null);
        assertEquals("error", context.getSharedPreferences("widget-refresh", Context.MODE_PRIVATE).getString("state", ""));
    }
    @Test public void anOldCompletionCannotFinishTheCurrentWriter() throws Exception {
        List<Boolean> results = new ArrayList<>();
        var handle = request(results::add);
        VaultSyncSession.complete("a-stale-request", true);
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        assertTrue(results.isEmpty());
        handle.session.dispatch("finished", new JSONObject().put("ok", false));
        await(() -> !results.isEmpty());
        assertEquals(List.of(false), results);
    }
    @Test public void timedOutSessionReportsFailureAndReleasesItsOwners() throws Exception {
        List<Boolean> results = new ArrayList<>();
        request(results::add);
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(121));
        await(() -> !results.isEmpty());
        assertEquals(List.of(false), results);
        assertNull(ReflectionHelpers.getStaticField(VaultSyncSession.class, "active"));
    }
    @Test public void stoppingManualServiceLeavesScheduledOwnerRunning() throws Exception {
        List<Boolean> results = new ArrayList<>();
        var scheduled = request(results::add);
        var controller = org.robolectric.Robolectric.buildService(WidgetRefreshService.class).create();
        controller.get().onStartCommand(new android.content.Intent(), 0, 1);
        controller.destroy();
        assertSame(scheduled.session, ReflectionHelpers.getStaticField(VaultSyncSession.class, "active"));
        assertTrue(results.isEmpty());
        scheduled.session.dispatch("finished", new JSONObject().put("ok", true));
        await(() -> !results.isEmpty());
        assertEquals(List.of(true), results);
    }
    @Test public void scheduledEngineStartsNeitherActivityNorForegroundService() {
        var app = Shadows.shadowOf((android.app.Application) context);
        request(ok -> {});
        assertNull(app.getNextStartedActivity());
        assertNull(app.getNextStartedService());
    }
    @Test public void cancellationDrainsNativeOperationsBeforeAnotherWriterCanStart() throws Exception {
        var first = request(ok -> {});
        ExecutorService executor = ReflectionHelpers.getField(first.session, "calls");
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        executor.execute(() -> {
            entered.countDown();
            try { release.await(2, TimeUnit.SECONDS); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        });
        assertTrue(entered.await(2, TimeUnit.SECONDS));
        first.cancel();
        List<Boolean> results = new ArrayList<>();
        var joining = request(results::add);
        assertSame(first.session, joining.session);
        assertTrue(results.isEmpty());
        release.countDown();
        await(() -> !results.isEmpty());
        assertEquals(List.of(false), results);
    }
}
