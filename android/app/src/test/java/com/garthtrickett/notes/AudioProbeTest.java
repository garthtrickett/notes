package com.garthtrickett.notes;

import static org.junit.Assert.*;
import android.net.Uri;
import android.os.CancellationSignal;
import java.io.File;
import java.io.InputStream;
import java.nio.file.Files;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

// Actual Media3 extractors, synthetic local tones. This qualifies container
// metadata preparation on the host, not Android decoder/audio-device output.
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36)
@LooperMode(LooperMode.Mode.INSTRUMENTATION_TEST)
public class AudioProbeTest {
    @Rule public TemporaryFolder directory = new TemporaryFolder();
    @After public void awaitRetrieverRelease() throws Exception {
        // Media3 closes its shared HandlerThread asynchronously. Let that
        // release finish before Robolectric resets this test's loopers;
        // otherwise the next test can inherit a stopped worker with a live
        // reference count and queue forever behind it.
        for (Thread thread : Thread.getAllStackTraces().keySet()) {
            if (thread.getName().equals("Inspector:MetadataRetriever")) {
                thread.join(5000);
                assertFalse("Media3 metadata worker must release before sandbox reset", thread.isAlive());
            }
        }
    }
    private File fixture(String extension) throws Exception {
        String name = "notes-audio-storage-test." + extension;
        File target = new File(directory.getRoot(), name);
        try (InputStream source = getClass().getResourceAsStream("/audio/" + name)) {
            assertNotNull(source); Files.copy(source, target.toPath());
        }
        return target;
    }
    private void probeTone(String extension) throws Exception {
        File tone = fixture(extension);
        AudioProbe probe = AudioProbe.read(RuntimeEnvironment.getApplication(), Uri.fromFile(tone), tone.getName(), new CancellationSignal());
        assertTrue("duration " + probe.durationMs, probe.durationMs >= 4900 && probe.durationMs <= 5100);
        assertEquals("Notes audio storage test", probe.title);
        assertNull(probe.author);
    }
    @Test public void oggOpusHasAnAudioTrackAndDuration() throws Exception { probeTone("opus"); }
    @Test public void mp4AacM4bHasAnAudioTrackAndDuration() throws Exception { probeTone("m4b"); }
    @Test public void mp3HasAnAudioTrackDurationAndId3Title() throws Exception { probeTone("mp3"); }
    @Test public void malformedMp3IsNotOfferedAsPlayable() throws Exception {
        File invalid = new File(directory.getRoot(), "invalid.mp3");
        Files.write(invalid.toPath(), new byte[]{1,2,3,4});
        AudioProblem failure = assertThrows(AudioProblem.class, () -> AudioProbe.read(
            RuntimeEnvironment.getApplication(), Uri.fromFile(invalid), invalid.getName(), new CancellationSignal()));
        assertEquals(AudioProblem.Kind.UNSUPPORTED, failure.kind);
    }
    @Test public void cancelledPreparationDoesNotOpenTheFile() throws Exception {
        CancellationSignal cancelled = new CancellationSignal(); cancelled.cancel();
        try {
            AudioProbe.read(RuntimeEnvironment.getApplication(), Uri.fromFile(new File(directory.getRoot(), "missing.opus")), "missing.opus", cancelled);
            fail("cancelled preparation must stop");
        } catch (android.os.OperationCanceledException expected) { }
    }
}
