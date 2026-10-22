package com.garthtrickett.notes;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.Intent;
import android.os.Looper;
import java.io.File;
import java.lang.reflect.Field;
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
public class AudioServiceStartupTest {
    private ServiceController<AudioPlaybackService> controller;
    private Context context;
    @Before public void setUp() throws Exception {
        AudioTasks.FILES.submit(() -> {}).get(10, TimeUnit.SECONDS);
        AudioTasks.STATE.submit(() -> {}).get(10, TimeUnit.SECONDS);
        Field singleton = AudioRuntime.class.getDeclaredField("instance"); singleton.setAccessible(true); singleton.set(null, null);
        context = RuntimeEnvironment.getApplication();
        File[] files = context.getFilesDir().listFiles();
        if (files != null) for (File file : files) if (file.getName().startsWith("audio-state")) assertTrue(file.delete());
    }
    @After public void tearDown() throws Exception {
        if (controller != null) controller.destroy();
        AudioTasks.FILES.submit(() -> {}).get(10, TimeUnit.SECONDS);
        AudioTasks.STATE.submit(() -> {}).get(10, TimeUnit.SECONDS);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
    }
    private AudioPlaybackService create() throws Exception {
        controller = Robolectric.buildService(AudioPlaybackService.class).create();
        AudioTasks.STATE.submit(() -> {}).get(10, TimeUnit.SECONDS);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        return controller.get();
    }
    @Test public void aColdServiceDoesNotRestorePlaybackEvenWithASavedSelectedItem() throws Exception {
        AudioStateFile file = new AudioStateFile(AudioStateFile.android(context.getFilesDir(), () -> "recovery"));
        AudioDelete.Version v = new AudioDelete.Version(AudioLedgerTest.ROOT, "youtube/a.opus", "primary:phone-media/youtube/a.opus", 42, 123, "a".repeat(64));
        AudioListening.State progress = AudioListening.checkpoint(AudioListening.play(AudioListening.unplayed(120000)), 35000, 120000);
        file.save(file.current().bind(AudioLedgerTest.ROOT).put(new AudioLedger.Item("one", v, "Recording", null, progress)).select("one"));
        AudioPlaybackService service = create();
        assertEquals("one", AudioRuntime.get(context).snapshot().ledger.selected);
        assertEquals(35000, AudioRuntime.get(context).snapshot().ledger.items.get("one").listening.positionMs);
        assertNull(service.position()); assertNull(service.loaded());
        assertFalse(service.onGetSession(null).getPlayer().isPlaying());
        assertEquals(0, service.onGetSession(null).getPlayer().getMediaItemCount());
        assertNull(Shadows.shadowOf(service).getLastForegroundNotification());
    }
    @Test public void arbitraryPreparationIntentCannotStartForegroundOrLoadMedia() throws Exception {
        AudioPlaybackService service = create();
        service.onStartCommand(new Intent(context, AudioPlaybackService.class).setAction(AudioPlaybackService.PREPARE)
            .putExtra("token", "caller-invented-token"), 0, 1);
        assertNull(service.loaded()); assertNull(Shadows.shadowOf(service).getLastForegroundNotification());
        assertFalse(service.onGetSession(null).getPlayer().isPlaying());
    }
    @Test public void repeatedConnectionsShareTheSameEmptySession() throws Exception {
        AudioPlaybackService service = create();
        assertSame(service.onGetSession(null), service.onGetSession(null));
        assertNull(service.position()); assertNull(Shadows.shadowOf(service).getLastForegroundNotification());
    }
}
