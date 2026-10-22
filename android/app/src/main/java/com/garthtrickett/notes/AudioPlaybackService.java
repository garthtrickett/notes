package com.garthtrickett.notes;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import androidx.media3.session.SessionCommands;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import java.util.List;

// The only player in the process. No Activity, WebView or bridge owns it.
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
public class AudioPlaybackService extends MediaSessionService {
    static final String PREPARE = "com.garthtrickett.notes.audio.PREPARE";
    private static final String CANCEL = "com.garthtrickett.notes.audio.CANCEL";
    private static final String CHANNEL = "audio_preparing";
    private AudioRuntime runtime;
    private ExoPlayer player;
    private MediaSession session;
    private AudioRuntime.Prepared loaded;
    private PowerManager.WakeLock preparingWakeLock;
    private boolean installing, preparing, checkpointEnabled = true;

    static final class Position {
        final String item;
        final long elapsedMs, durationMs;
        final boolean playing;
        Position(String item, long elapsedMs, long durationMs, boolean playing) {
            this.item = item; this.elapsedMs = elapsedMs; this.durationMs = durationMs; this.playing = playing;
        }
    }

    @Override public void onCreate() {
        super.onCreate();
        runtime = AudioRuntime.get(this);
        player = new ExoPlayer.Builder(this).setSeekBackIncrementMs(15000).setSeekForwardIncrementMs(30000).build();
        player.setAudioAttributes(new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).build(), true);
        player.setHandleAudioBecomingNoisy(true);
        player.setWakeMode(C.WAKE_MODE_LOCAL);
        player.setRepeatMode(Player.REPEAT_MODE_OFF);
        player.setShuffleModeEnabled(false);
        player.addListener(events);
        session = new MediaSession.Builder(this, controlledPlayer()).setCallback(new MediaSession.Callback() {
            @Override public MediaSession.ConnectionResult onConnect(MediaSession session, MediaSession.ControllerInfo controller) {
                Player.Commands commands = new Player.Commands.Builder().addAll(Player.COMMAND_PLAY_PAUSE,
                    Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, Player.COMMAND_SEEK_BACK, Player.COMMAND_SEEK_FORWARD,
                    Player.COMMAND_GET_CURRENT_MEDIA_ITEM, Player.COMMAND_GET_METADATA, Player.COMMAND_GET_TIMELINE).build();
                return new MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                    .setAvailableSessionCommands(new SessionCommands.Builder().build()).setAvailablePlayerCommands(commands).build();
            }
            @Override public ListenableFuture<List<MediaItem>> onAddMediaItems(MediaSession session,
                MediaSession.ControllerInfo controller, List<MediaItem> items) {
                return Futures.immediateFailedFuture(new UnsupportedOperationException("Select an identified local recording in Notes."));
            }
            @Override public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onSetMediaItems(MediaSession session,
                MediaSession.ControllerInfo controller, List<MediaItem> items, int index, long position) {
                return Futures.immediateFailedFuture(new UnsupportedOperationException("Caller-supplied media IDs and URIs are not accepted."));
            }
            @Override public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onPlaybackResumption(MediaSession session,
                MediaSession.ControllerInfo controller, boolean forPlayback) {
                return Futures.immediateFailedFuture(new UnsupportedOperationException("Open Notes and explicitly Play to revalidate the file."));
            }
        }).setSessionActivity(PendingIntent.getActivity(this, 3101, new Intent(this, MainActivity.class),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)).build();
        // Notes starts playback directly rather than binding a MediaController.
        // Register here so Media3 publishes the media notification on that path.
        addSession(session);
        runtime.attach(this);
    }

    // Ordinary transport commands go through the same native state owner as UI
    // commands. In particular headset Play on Done must durably restart at zero.
    private Player controlledPlayer() {
        return new ForwardingPlayer(player) {
            @Override public void play() { runtime.resumeActive(); }
            @Override public void pause() { runtime.pause(); }
            @Override public void stop() { runtime.pause(); }
            @Override public void setPlayWhenReady(boolean play) { if (play) runtime.resumeActive(); else runtime.pause(); }
            @Override public void seekTo(long position) { runtime.seek(position); }
            @Override public void seekTo(int index, long position) { if (index == 0) runtime.seek(position); }
            @Override public void seekBack() { runtime.seek(Math.max(0, player.getCurrentPosition() - 15000)); }
            @Override public void seekForward() { runtime.seek(player.getCurrentPosition() + 30000); }
        };
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && PREPARE.equals(intent.getAction())) {
            String token = intent.getStringExtra("token");
            if (!runtime.authorized(token)) { if (loaded == null) stopSelf(); return START_NOT_STICKY; }
            try {
                preparing = true;
                foregroundPreparation(token);
                releasePreparationWakeLock();
                PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
                if (manager != null) {
                    preparingWakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "notes:audio-prepare");
                    preparingWakeLock.acquire(5 * 60 * 1000L);
                }
                runtime.prepareFromService(token);
            } catch (Exception error) { runtime.preparationFailed(token, error); abortPreparation(); }
            return START_NOT_STICKY;
        }
        if (intent != null && CANCEL.equals(intent.getAction())) {
            if (runtime.authorized(intent.getStringExtra("token"))) runtime.pause();
            return START_NOT_STICKY;
        }
        // Never restore a playlist on a system restart. Active media controls
        // can use the session, whose callbacks reject arbitrary media input.
        super.onStartCommand(intent, flags, startId);
        return START_NOT_STICKY;
    }

    private void foregroundPreparation(String token) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Audio preparation", NotificationManager.IMPORTANCE_LOW);
            channel.setSound(null, null);
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
        PendingIntent cancel = PendingIntent.getService(this, 3102, new Intent(this, AudioPlaybackService.class)
            .setAction(CANCEL).putExtra("token", token), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new NotificationCompat.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("Preparing audio").setContentText("Checking this phone's recording…")
            .setContentIntent(session.getSessionActivity()).setOngoing(true).setSilent(true)
            .addAction(android.R.drawable.ic_media_pause, "Cancel", cancel).build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID, notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID, notification);
    }

    AudioRuntime.Prepared loaded() { return loaded; }
    Position position() {
        if (loaded == null) return null;
        long duration = player.getDuration() > 0 ? player.getDuration() : loaded.item.listening.durationMs;
        return new Position(loaded.item.id, Math.max(0, player.getCurrentPosition()), duration, player.isPlaying());
    }
    void install(AudioRuntime.Prepared next) {
        installing = true;
        try {
            player.pause(); player.clearMediaItems(); loaded = next; checkpointEnabled = true;
            MediaMetadata metadata = new MediaMetadata.Builder().setTitle(next.item.title).setArtist(next.item.author).build();
            player.setMediaItem(new MediaItem.Builder().setMediaId(next.item.id).setUri(next.uri).setMediaMetadata(metadata).build(), next.item.listening.positionMs);
            player.prepare(); player.play();
            preparing = false; releasePreparationWakeLock();
        } finally { installing = false; }
        if (player.isPlaying()) startTimers();
        runtime.playerChanged();
    }
    void pausePlayer() {
        player.pause(); checkpoint(false); runtime.playerChanged();
    }
    void pauseAfterFailure() {
        // Avoid retrying a failed checkpoint recursively from the pause event.
        installing = true; checkpointEnabled = false;
        try { player.pause(); } finally { installing = false; }
        stopTimers();
    }
    void seek(long requested) {
        Position position = position();
        if (position == null) throw new IllegalArgumentException("No identified recording is loaded.");
        player.seekTo(AudioListening.seek(requested, position.durationMs));
        checkpoint(false); runtime.playerChanged();
    }
    void resetPosition() {
        installing = true;
        try { player.pause(); player.seekTo(0); } finally { installing = false; }
        stopTimers(); runtime.playerChanged();
    }
    void abortPreparation() {
        if (!preparing) return;
        preparing = false; releasePreparationWakeLock();
        stopForeground(STOP_FOREGROUND_REMOVE);
        if (loaded == null) stopSelf(); else triggerNotificationUpdate();
    }
    void clear() {
        pausePlayer(); installing = true;
        try { player.stop(); player.clearMediaItems(); loaded = null; }
        finally { installing = false; }
        stopTimers(); preparing = false; releasePreparationWakeLock(); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
        runtime.playerChanged();
    }
    private void checkpoint(boolean ended) {
        Position position = position();
        if (installing || !checkpointEnabled || loaded == null || position == null) return;
        runtime.checkpoint(loaded, position.elapsedMs, position.durationMs, ended);
    }
    private final Runnable tick = new Runnable() {
        public void run() { if (player.isPlaying()) { runtime.playerChanged(); runtime.main.postDelayed(this, 1000); } }
    };
    private final Runnable saveTick = new Runnable() {
        public void run() { if (player.isPlaying()) { checkpoint(false); runtime.main.postDelayed(this, 15000); } }
    };
    private void stopTimers() { runtime.main.removeCallbacks(tick); runtime.main.removeCallbacks(saveTick); }
    private void startTimers() { stopTimers(); runtime.main.postDelayed(tick, 1000); runtime.main.postDelayed(saveTick, 15000); }
    private final Player.Listener events = new Player.Listener() {
        @Override public void onIsPlayingChanged(boolean playing) {
            if (installing) return;
            stopTimers();
            if (playing) startTimers();
            else checkpoint(false);
            runtime.playerChanged();
        }
        @Override public void onPlayWhenReadyChanged(boolean ready, int reason) {
            if (!ready && !installing) checkpoint(false);
        }
        @Override public void onPositionDiscontinuity(Player.PositionInfo before, Player.PositionInfo after, int reason) {
            if (reason == Player.DISCONTINUITY_REASON_SEEK && !installing) checkpoint(false);
        }
        @Override public void onPlaybackStateChanged(int state) {
            if (state == Player.STATE_ENDED && player.getPlaybackState() == Player.STATE_ENDED && !installing) {
                checkpoint(true); player.pause(); stopTimers(); runtime.playerChanged();
            }
        }
        @Override public void onPlayerError(PlaybackException error) {
            checkpoint(false); stopTimers(); runtime.playbackFailed(error);
        }
    };
    private void releasePreparationWakeLock() {
        if (preparingWakeLock != null && preparingWakeLock.isHeld()) preparingWakeLock.release();
        preparingWakeLock = null;
    }
    @Override public MediaSession onGetSession(MediaSession.ControllerInfo controller) { return session; }
    @Override public void onDestroy() {
        checkpoint(false); stopTimers(); releasePreparationWakeLock(); runtime.detach(this);
        player.removeListener(events); player.release(); session.release(); super.onDestroy();
    }
}
