package com.garthtrickett.notes;

import static org.junit.Assert.*;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.Test;

public class AudioStateFileTest {
    private static final class Disk implements AudioStateFile.Disk {
        byte[] main, prior, archived;
        boolean failPrimary, failPrevious, failArchive, failAfterCommit;
        int writes;
        public byte[] primary() { return main; }
        public byte[] previous() { return prior; }
        public void primary(byte[] bytes) throws IOException {
            writes++;
            if (failPrimary) throw new IOException("disk full");
            main = bytes;
            if (failAfterCommit) throw new IOException("uncertain commit");
        }
        public void previous(byte[] bytes) throws IOException {
            if (failPrevious) throw new IOException("previous write failed");
            prior = bytes;
        }
        public void preservePrimary() throws IOException {
            if (failArchive) throw new IOException("cannot preserve original");
            archived = main;
        }
    }
    @Test public void successfulSaveSurvivesAColdReopenAndKeepsPriorVersion() throws Exception {
        Disk disk = new Disk(); AudioStateFile file = new AudioStateFile(disk);
        file.save(AudioLedger.empty().bind(AudioLedgerTest.ROOT));
        file.save(file.current().bind(AudioLedgerTest.ROOT + "-other"));
        AudioStateFile cold = new AudioStateFile(disk);
        assertEquals(AudioLedgerTest.ROOT + "-other", cold.current().root);
        assertEquals(2, cold.current().rootGeneration);
        assertEquals(AudioLedgerTest.ROOT, AudioLedger.parse(new JSONObject(new String(disk.prior, StandardCharsets.UTF_8))).root);
    }
    @Test public void failedIntentSaveDoesNotAdvanceMemoryOrAcknowledgeIt() throws Exception {
        Disk disk = new Disk(); AudioStateFile file = new AudioStateFile(disk);
        file.save(AudioLedger.empty().bind(AudioLedgerTest.ROOT));
        disk.failPrimary = true;
        AudioStateFile.Failure error = assertThrows(AudioStateFile.Failure.class,
            () -> file.save(file.current().bind(AudioLedgerTest.ROOT + "-other")));
        assertEquals(AudioStateFile.Kind.STORAGE, error.kind);
        assertEquals(AudioLedgerTest.ROOT, file.current().root);
        assertFalse(file.writable());
        int writes = disk.writes; disk.failPrimary = false;
        assertThrows(AudioStateFile.Failure.class, () -> file.save(file.current()));
        assertEquals(writes, disk.writes);
    }
    @Test public void failedPriorWriteCannotReplacePrimary() throws Exception {
        Disk disk = new Disk(); AudioStateFile file = new AudioStateFile(disk);
        file.save(AudioLedger.empty().bind(AudioLedgerTest.ROOT));
        byte[] main = disk.main; disk.failPrevious = true;
        assertThrows(AudioStateFile.Failure.class, () -> file.save(file.current().bind(AudioLedgerTest.ROOT + "-other")));
        assertSame(main, disk.main);
    }
    @Test public void uncertainCommitRequiresReopenRatherThanOverwritingADurableIntent() throws Exception {
        Disk disk = new Disk(); AudioStateFile file = new AudioStateFile(disk); disk.failAfterCommit = true;
        assertThrows(AudioStateFile.Failure.class, () -> file.save(AudioLedger.empty().bind(AudioLedgerTest.ROOT)));
        assertEquals("", file.current().root);
        assertFalse(file.writable());
        disk.failAfterCommit = false;
        assertEquals(AudioLedgerTest.ROOT, new AudioStateFile(disk).current().root);
    }
    @Test public void corruptionReportsOlderCheckpointAndRequiresExplicitRestore() throws Exception {
        Disk disk = new Disk(); AudioStateFile file = new AudioStateFile(disk);
        file.save(AudioLedger.empty().bind(AudioLedgerTest.ROOT));
        file.save(file.current().bind(AudioLedgerTest.ROOT + "-other"));
        disk.main = "truncated".getBytes(StandardCharsets.UTF_8);
        byte[] damaged = disk.main;
        AudioStateFile recovered = new AudioStateFile(disk);
        assertEquals(AudioLedgerTest.ROOT, recovered.current().root);
        assertNotNull(recovered.warning()); assertFalse(recovered.writable());
        assertSame(damaged, disk.main);
        assertThrows(AudioStateFile.Failure.class, () -> recovered.save(recovered.current()));
        recovered.restorePrior();
        assertTrue(recovered.writable()); assertSame(damaged, disk.archived);
        assertNotNull(recovered.warning());
        assertEquals(AudioLedgerTest.ROOT, new AudioStateFile(disk).current().root);
    }
    @Test public void failedPreservationLeavesDamagedOriginalIntact() throws Exception {
        Disk disk = new Disk(); AudioStateFile file = new AudioStateFile(disk);
        file.save(AudioLedger.empty().bind(AudioLedgerTest.ROOT));
        disk.main = "broken".getBytes(StandardCharsets.UTF_8); disk.failArchive = true;
        byte[] damaged = disk.main;
        AudioStateFile recovered = new AudioStateFile(disk);
        assertThrows(AudioStateFile.Failure.class, recovered::restorePrior);
        assertSame(damaged, disk.main);
    }
    @Test public void futureSchemaNeverFallsBackAndOverwritesANewerAppsState() throws Exception {
        Disk disk = new Disk(); AudioStateFile file = new AudioStateFile(disk);
        file.save(AudioLedger.empty().bind(AudioLedgerTest.ROOT));
        disk.main = new JSONObject(new String(disk.main, StandardCharsets.UTF_8)).put("schema", 999).toString().getBytes(StandardCharsets.UTF_8);
        byte[] future = disk.main;
        AudioStateFile.Failure error = assertThrows(AudioStateFile.Failure.class, () -> new AudioStateFile(disk));
        assertEquals(AudioStateFile.Kind.FUTURE_SCHEMA, error.kind);
        assertSame(future, disk.main); assertNull(disk.archived);
    }
    @Test public void unrecoverableCorruptionNeverResetsToEmpty() {
        Disk disk = new Disk(); disk.main = "broken".getBytes(StandardCharsets.UTF_8);
        AudioStateFile.Failure error = assertThrows(AudioStateFile.Failure.class, () -> new AudioStateFile(disk));
        assertEquals(AudioStateFile.Kind.CORRUPT, error.kind); assertEquals(0, disk.writes);
    }
}
