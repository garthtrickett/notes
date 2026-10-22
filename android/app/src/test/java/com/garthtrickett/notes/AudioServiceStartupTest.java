package com.garthtrickett.notes;

import static org.junit.Assert.*;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Looper;
import android.net.Uri;
import androidx.media3.session.DefaultMediaNotificationProvider;
import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Duration;
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
    @Test public void directServiceStartupRegistersTheSessionForMediaNotifications() throws Exception {
        AudioPlaybackService service = create();
        assertEquals("Direct Play must register without an external controller binding", 1, service.getSessions().size());
        assertSame(service.onGetSession(null), service.getSessions().get(0));
        assertNull(Shadows.shadowOf(service).getLastForegroundNotification());
    }

    private void loadSyntheticRecording(AudioPlaybackService service) throws Exception {
        // Silent PCM avoids relying on a host Opus decoder or audio device.
        int bytes = 16000 * 2 * 30;
        ByteBuffer wave = ByteBuffer.allocate(44 + bytes).order(ByteOrder.LITTLE_ENDIAN);
        wave.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + bytes)
            .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16)
            .putShort((short) 1).putShort((short) 1).putInt(16000).putInt(32000)
            .putShort((short) 2).putShort((short) 16)
            .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(bytes);
        File audio = new File(context.getCacheDir(), "notification-tone.wav");
        Files.write(audio.toPath(), wave.array());
        AudioDelete.Version v = new AudioDelete.Version(AudioLedgerTest.ROOT,
            "youtube/notification-test.opus", "synthetic-document", bytes, 123, "a".repeat(64));
        AudioLedger.Item item = new AudioLedger.Item("shade-test", v, "Synthetic recording", "Test speaker", AudioListening.unplayed(30000));
        service.install(new AudioRuntime.Prepared(item, Uri.fromFile(audio), 1));
    }
    private Notification awaitMediaNotification(String actionTitle) throws Exception {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20));
            Notification notification = Shadows.shadowOf(manager).getNotification(DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID);
            if (notification != null && notification.extras.getParcelable(Notification.EXTRA_MEDIA_SESSION) != null && notification.actions != null)
                for (Notification.Action action : notification.actions) if (actionTitle.contentEquals(action.title)) return notification;
            Thread.sleep(2);
        }
        throw new AssertionError("Direct playback did not publish a media-session notification");
    }
    @Test public void directPlaybackPublishesMediaControlsAndKeepsThemWhilePaused() throws Exception {
        AudioPlaybackService service = create();
        loadSyntheticRecording(service);
        Notification notification = awaitMediaNotification("Pause");
        assertEquals("Synthetic recording", notification.extras.getCharSequence(Notification.EXTRA_TITLE).toString());
        assertEquals("Test speaker", notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString());
        assertEquals("android.app.Notification$MediaStyle", notification.extras.getString(Notification.EXTRA_TEMPLATE));
        assertNotNull(notification.contentIntent); assertNotNull(notification.actions); assertTrue(notification.actions.length > 0);
        Notification.Action pause = null;
        for (Notification.Action action : notification.actions) if ("Pause".contentEquals(action.title)) pause = action;
        assertNotNull(pause);
        service.onStartCommand(Shadows.shadowOf(pause.actionIntent).getSavedIntent(), 0, 2);
        Notification paused = awaitMediaNotification("Play");
        assertNotNull(paused.extras.getParcelable(Notification.EXTRA_MEDIA_SESSION));
        assertFalse(service.onGetSession(null).getPlayer().getPlayWhenReady());
        service.clear(); Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200));
        assertNull(Shadows.shadowOf(context.getSystemService(NotificationManager.class))
            .getNotification(DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID));
    }
    @Test public void cancellingPreparationRestoresThePausedRecordingsMediaNotification() throws Exception {
        AudioPlaybackService service = create(); loadSyntheticRecording(service); awaitMediaNotification("Pause");
        service.pausePlayer(); awaitMediaNotification("Play");
        java.lang.reflect.Method foreground = AudioPlaybackService.class.getDeclaredMethod("foregroundPreparation", String.class);
        foreground.setAccessible(true); foreground.invoke(service, "synthetic-preparation-token");
        Field preparing = AudioPlaybackService.class.getDeclaredField("preparing"); preparing.setAccessible(true); preparing.setBoolean(service, true);
        service.abortPreparation();
        Notification restored = awaitMediaNotification("Play");
        assertEquals("Synthetic recording", restored.extras.getCharSequence(Notification.EXTRA_TITLE).toString());
        assertFalse(service.onGetSession(null).getPlayer().getPlayWhenReady());
    }

}
