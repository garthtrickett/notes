package com.garthtrickett.notes;

import android.content.Context;
import android.net.Uri;
import android.os.CancellationSignal;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.TrackGroup;
import androidx.media3.exoplayer.source.TrackGroupArray;
import androidx.media3.inspector.MetadataRetriever;
import com.google.common.util.concurrent.ListenableFuture;
import java.util.concurrent.TimeUnit;

// The same Media3 extractors as playback, with no player/foreground service.
// One retriever at a time on FILES, bounded waits, cancellation and prompt close.
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
final class AudioProbe {
    final String title, author;
    final long durationMs;
    private AudioProbe(String title, String author, long durationMs) {
        this.title = title; this.author = author; this.durationMs = durationMs;
    }
    static AudioProbe read(Context context, Uri uri, String filename, CancellationSignal cancellation) throws Exception {
        cancellation.throwIfCanceled();
        MetadataRetriever.setMaximumParallelRetrievals(1);
        try (MetadataRetriever retriever = new MetadataRetriever.Builder(context, MediaItem.fromUri(uri)).build()) {
            ListenableFuture<TrackGroupArray> groups = retriever.retrieveTrackGroups();
            ListenableFuture<Long> duration = retriever.retrieveDurationUs();
            cancellation.setOnCancelListener(() -> { groups.cancel(true); duration.cancel(true); });
            try {
                TrackGroupArray tracks = groups.get(10, TimeUnit.SECONDS);
                long durationUs = duration.get(10, TimeUnit.SECONDS);
                cancellation.throwIfCanceled();
                boolean audio = false;
                MediaMetadata.Builder metadata = new MediaMetadata.Builder();
                for (int i = 0; i < tracks.length; i++) {
                    TrackGroup group = tracks.get(i);
                    for (int j = 0; j < group.length; j++) {
                        Format format = group.getFormat(j);
                        if (format.sampleMimeType != null && format.sampleMimeType.startsWith("audio/")) audio = true;
                        if (format.metadata != null) metadata.populateFromMetadata(format.metadata);
                    }
                }
                if (!audio || durationUs == C.TIME_UNSET || durationUs <= 0)
                    throw new AudioProblem(AudioProblem.Kind.UNSUPPORTED, "Could not probe an audio track and duration. The file is not offered as playable.");
                MediaMetadata fields = metadata.build();
                String title = text(fields.title);
                String author = text(fields.artist);
                if (author == null) author = text(fields.author);
                return new AudioProbe(title == null ? filename.replaceFirst("(?i)\\.(opus|m4b|mp3)$", "") : title, author, durationUs / 1000);
            } finally {
                cancellation.setOnCancelListener(null);
                groups.cancel(true); duration.cancel(true);
            }
        } catch (java.util.concurrent.ExecutionException error) {
            AudioProblem problem = AudioProblem.from(error);
            if (problem.kind != AudioProblem.Kind.PLAYBACK) throw problem;
            throw new AudioProblem(AudioProblem.Kind.UNSUPPORTED, "The local recording could not be probed. It is not offered as playable.");
        } catch (java.util.concurrent.TimeoutException error) {
            throw new AudioProblem(AudioProblem.Kind.UNSUPPORTED, "Audio metadata preparation timed out. Retry after the local file settles.");
        }
    }
    private static String text(CharSequence value) { return value == null || value.toString().trim().isEmpty() ? null : value.toString().trim(); }
}
