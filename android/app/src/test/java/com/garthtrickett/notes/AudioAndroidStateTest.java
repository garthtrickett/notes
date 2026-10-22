package com.garthtrickett.notes;

import static org.junit.Assert.*;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

// Real Android AtomicFile code and real host file IO under Robolectric. These
// tests do not qualify power loss or the actual phone's storage provider.
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36)
public class AudioAndroidStateTest {
    @Rule public TemporaryFolder directory = new TemporaryFolder();
    private AudioStateFile open() throws Exception { return new AudioStateFile(AudioStateFile.android(directory.getRoot(), () -> "test-recovery")); }
    @Test public void actualAtomicDriverKeepsAcknowledgedMarkAndBookmarkAcrossReopen() throws Exception {
        AudioStateFile file = open();
        AudioDelete.Version version = new AudioDelete.Version(AudioLedgerTest.ROOT, "youtube/a.opus", "primary:phone-media/youtube/a.opus", 42, 123, "a".repeat(64));
        AudioListening.State position = AudioListening.checkpoint(AudioListening.play(AudioListening.unplayed(120000)), 35000, 120000);
        AudioLedger.Item item = new AudioLedger.Item("one", version, "Recording", null, position);
        file.save(file.current().bind(AudioLedgerTest.ROOT).put(item).select("one"));
        file.save(file.current().put(item.listening(AudioListening.mark(position, AudioListening.Mark.DONE))));
        AudioLedger restored = open().current();
        assertEquals(AudioListening.Mark.DONE, restored.items.get("one").listening.mark);
        assertEquals(35000, restored.items.get("one").listening.positionMs);
        assertEquals("one", restored.selected);
        assertTrue(new File(directory.getRoot(), "audio-state.previous.json").isFile());
    }
    @Test public void interruptedNewFileCannotReplaceTheLastAcknowledgedState() throws Exception {
        AudioStateFile file = open(); file.save(file.current().bind(AudioLedgerTest.ROOT));
        AtomicFile primary = new AtomicFile(new File(directory.getRoot(), "audio-state.json"));
        FileOutputStream interrupted = primary.startWrite(); interrupted.write("{incomplete".getBytes(StandardCharsets.UTF_8)); interrupted.close();
        assertEquals(AudioLedgerTest.ROOT, open().current().root);
    }
    @Test public void damagedOriginalIsPreservedBeforeExplicitPriorRecovery() throws Exception {
        AudioStateFile file = open(); file.save(file.current().bind(AudioLedgerTest.ROOT));
        file.save(file.current().bind(AudioLedgerTest.ROOT + "-other"));
        Files.write(new File(directory.getRoot(), "audio-state.json").toPath(), "broken".getBytes(StandardCharsets.UTF_8));
        AudioStateFile recovered = open();
        assertFalse(recovered.writable()); assertNotNull(recovered.warning());
        assertEquals("broken", new String(Files.readAllBytes(new File(directory.getRoot(), "audio-state.json").toPath()), StandardCharsets.UTF_8));
        recovered.restorePrior();
        assertEquals("broken", new String(Files.readAllBytes(new File(directory.getRoot(), "audio-state.corrupt-test-recovery.json").toPath()), StandardCharsets.UTF_8));
        assertEquals(AudioLedgerTest.ROOT, open().current().root);
    }
}
