package com.garthtrickett.notes;

import static org.junit.Assert.*;
import org.junit.Test;

public class AudioPathsTest {
    @Test public void onlyCompletedAudioInSelectedSources() {
        assertTrue(AudioPaths.audio("youtube/日本語 and spaces.opus"));
        assertTrue(AudioPaths.audio("audiobooks/author/title.M4B"));
        for (String path : new String[] { "video/a.opus", "a.opus", "youtube/a.mp4", "podcasts/a.mp3",
            "youtube/.a.opus", "youtube/.stversions/a.opus", "youtube/a.sync-conflict-2026.opus",
            "youtube/a.opus.part", "youtube/../a.opus", "youtube//a.opus", "youtube/a\\b.opus",
            "youtube/.syncthing.a.opus.tmp", "youtube/a.opus/" }) {
            assertFalse(path, AudioPaths.audio(path));
        }
    }
    @Test public void spikeOnlyDeletesItsTwoExactSpecimens() {
        assertTrue(AudioPaths.specimen("youtube/notes-audio-storage-test.opus"));
        assertTrue(AudioPaths.specimen("audiobooks/notes-audio-storage-test.m4b"));
        assertFalse(AudioPaths.specimen("youtube/real-recording.opus"));
        assertFalse(AudioPaths.specimen("youtube/sub/notes-audio-storage-test.opus"));
    }
    @Test public void japaneseIncludesNestedAudioButRejectsPartialsAndOtherFiles() {
        assertTrue(AudioPaths.audio("japanese/日本語.opus"));
        assertTrue(AudioPaths.audio("japanese/dialogue/Yuki and Shide.M4B"));
        for (String path : new String[] { "japanese/.lesson.opus", "japanese/lesson.opus.part",
            "japanese/lesson.sync-conflict-2026.opus", "japanese/../lesson.opus", "japanese/lesson.mp4",
            "japanese/transcript.md", "other/lesson.opus" }) {
            assertFalse(path, AudioPaths.audio(path));
        }
        assertFalse(AudioPaths.specimen("japanese/notes-audio-storage-test.opus"));
    }
}
