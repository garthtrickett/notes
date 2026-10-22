package com.garthtrickett.notes;

import static org.junit.Assert.*;
import android.content.Context;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.File;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36)
public class AudioPluginLifetimeTest {
    private ServiceController<AudioPlaybackService> service;
    private static final class TestPlugin extends AudioPlugin {
        final List<JSObject> events = new ArrayList<>();
        @Override public Context getContext() { return RuntimeEnvironment.getApplication(); }
        @Override protected boolean hasListeners(String event) { return true; }
        @Override protected void notifyListeners(String event, JSObject data) { events.add(data); }
    }
    private static final class Call extends PluginCall {
        JSObject result; String failure;
        Call() { this(new JSObject()); }
        Call(JSObject args) { super(null, "Audio", "test", "audioSnapshot", args); }
        @Override public void resolve(JSObject data) { result = data; }
        @Override public void reject(String message, String code, Exception error, JSObject data) { failure = message; }
    }
    private void drain() throws Exception {
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        AudioTasks.STATE.submit(() -> {}).get(10, TimeUnit.SECONDS);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
    }
    @Before public void reset() throws Exception {
        AudioTasks.FILES.submit(() -> {}).get(10, TimeUnit.SECONDS);
        AudioTasks.STATE.submit(() -> {}).get(10, TimeUnit.SECONDS);
        Field singleton = AudioRuntime.class.getDeclaredField("instance"); singleton.setAccessible(true); singleton.set(null, null);
        File[] files = RuntimeEnvironment.getApplication().getFilesDir().listFiles();
        if (files != null) for (File file : files) if (file.getName().startsWith("audio-state")) assertTrue(file.delete());
    }
    @After public void finish() throws Exception { if (service != null) service.destroy(); drain(); }
    @Test public void handshakeDoesNotScanOrStartPlaybackAndDestroyedPluginRejectsCalls() throws Exception {
        TestPlugin plugin = new TestPlugin(); Call initial = new Call();
        plugin.audioSnapshot(initial); drain();
        assertNull(initial.failure); assertNotNull(initial.result); assertTrue(initial.result.isNull("player"));
        assertEquals(0, initial.result.getJSONArray("rows").length());
        assertNull(Shadows.shadowOf(RuntimeEnvironment.getApplication()).getNextStartedService());
        plugin.handleOnDestroy(); drain(); int count = plugin.events.size();
        AudioRuntime.get(plugin.getContext()).playerChanged();
        assertEquals(count, plugin.events.size());
        Call late = new Call(); plugin.audioSnapshot(late); drain();
        assertNotNull(late.failure); assertNull(late.result);
    }
    @Test public void webViewReconnectUsesTheSameRuntimeAndDoesNotDestroyTheService() throws Exception {
        service = Robolectric.buildService(AudioPlaybackService.class).create(); drain();
        TestPlugin first = new TestPlugin(); Call old = new Call(); first.audioSnapshot(old); drain();
        Object session = service.get().onGetSession(null);
        first.handleOnDestroy(); drain();
        TestPlugin second = new TestPlugin(); Call fresh = new Call(); second.audioSnapshot(fresh); drain();
        assertEquals(old.result.getString("epoch"), fresh.result.getString("epoch"));
        assertSame(session, service.get().onGetSession(null));
        assertNull(Shadows.shadowOf(service.get()).getLastForegroundNotification());
        int oldCount = first.events.size(), newCount = second.events.size();
        AudioRuntime.get(second.getContext()).playerChanged();
        assertEquals(oldCount, first.events.size()); assertTrue(second.events.size() > newCount);
        second.handleOnDestroy(); drain();
    }
    @Test public void productionCommandsAcceptJsonIntegersAndRejectStaleOrFractionalScope() throws Exception {
        TestPlugin plugin = new TestPlugin(); Call initial = new Call(); plugin.audioSnapshot(initial); drain();
        String epoch = initial.result.getString("epoch");
        Call pause = new Call(new JSObject("{\"action\":\"pause\",\"epoch\":\"" + epoch + "\",\"rootGeneration\":0}"));
        plugin.audioCommand(pause); drain(); assertNotNull(pause.result); assertTrue(pause.result.isNull("failure"));
        Call invalid = new Call(new JSObject("{\"action\":\"pause\",\"epoch\":\"" + epoch + "\",\"rootGeneration\":0.5}"));
        plugin.audioCommand(invalid); drain(); assertEquals("STALE", invalid.result.getJSONObject("failure").getString("kind"));
        plugin.handleOnDestroy(); drain();
        Call late = new Call(new JSObject().put("action", "pause").put("epoch", epoch).put("rootGeneration", 0));
        plugin.audioCommand(late); drain(); assertNotNull(late.failure); assertNull(late.result);
    }

}
