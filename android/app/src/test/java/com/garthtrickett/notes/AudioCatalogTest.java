package com.garthtrickett.notes;

import static org.junit.Assert.*;
import java.util.Arrays;
import java.util.Collections;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;
import org.junit.Test;

public class AudioCatalogTest {
    private final AtomicInteger count = new AtomicInteger();
    private final Supplier<String> ids = () -> "opaque-" + count.incrementAndGet();
    private AudioDocuments.Entry entry(String path, long modified) throws Exception {
        int slash = path.lastIndexOf('/');
        return new AudioDocuments.Entry("primary:phone-media/" + path, path.substring(slash + 1), "audio/ogg", 42, modified, 0, path.substring(0, slash));
    }
    private AudioCatalog listed(AudioDocuments.Entry... entries) {
        return AudioCatalog.listed(AudioCatalog.empty(), AudioLedgerTest.ROOT, 1, Arrays.asList(entries), ids);
    }
    private AudioCatalog.Target target(AudioCatalog.Row row) { return new AudioCatalog.Target("epoch", 1, row.id, row.version); }
    @Test public void identicalTitlesStayDistinctAndStableAcrossRefresh() throws Exception {
        AudioCatalog initial = listed(entry("youtube/same.opus", 1), entry("podcasts/same.opus", 1));
        assertNotEquals(initial.rows.get(0).id, initial.rows.get(1).id);
        AudioCatalog refreshed = AudioCatalog.listed(initial, initial.root, 1,
            Arrays.asList(entry("youtube/same.opus", 1), entry("podcasts/same.opus", 1)), ids);
        assertSame(initial.rows.get(0), refreshed.rows.get(0)); assertSame(initial.rows.get(1), refreshed.rows.get(1));
    }
    @Test public void mp3FallbackTitleRemainsReadableAfterInvalidationAndRefresh() throws Exception {
        AudioDocuments.Entry document = entry("japanese/lessons/Japanese lesson.MP3", 1);
        AudioCatalog catalog = listed(document);
        AudioCatalog.Row row = catalog.rows.get(0);
        assertEquals("Japanese lesson", row.title);
        AudioCatalog invalidated = catalog.invalidate(row.id, row.version, ids);
        assertEquals("Japanese lesson", invalidated.rows.get(0).title);
        AudioCatalog refreshed = AudioCatalog.listed(invalidated, invalidated.root, 1,
            Collections.singletonList(document), ids);
        assertSame(invalidated.rows.get(0), refreshed.rows.get(0));
    }
    @Test public void staleEpochRootAndCallerInventedVersionsAreRefused() throws Exception {
        AudioCatalog catalog = listed(entry("youtube/a.opus", 1)); AudioCatalog.Row row = catalog.rows.get(0);
        AudioLedger ledger = AudioLedger.empty().bind(AudioLedgerTest.ROOT);
        assertSame(row, catalog.target(target(row), "epoch", ledger));
        assertThrows(AudioProblem.class, () -> catalog.target(target(row), "other-epoch", ledger));
        assertThrows(AudioProblem.class, () -> catalog.target(new AudioCatalog.Target("epoch", 0, row.id, row.version), "epoch", ledger));
        assertThrows(AudioProblem.class, () -> catalog.target(new AudioCatalog.Target("epoch", 1, row.id, "invented-version"), "epoch", ledger));
    }
    @Test public void changedMetadataGetsANewCapability() throws Exception {
        AudioCatalog first = listed(entry("youtube/a.opus", 1));
        AudioCatalog refreshed = AudioCatalog.listed(first, first.root, 1, Collections.singletonList(entry("youtube/a.opus", 2)), ids);
        assertNotEquals(first.rows.get(0).version, refreshed.rows.get(0).version);
        assertThrows(AudioProblem.class, () -> refreshed.target(target(first.rows.get(0)), "epoch", AudioLedger.empty().bind(AudioLedgerTest.ROOT)));
    }
    @Test public void replacingBytesWithSameHintsCannotKeepAnIdentifiedRowPinnedForever() throws Exception {
        AudioCatalog catalog = listed(entry("youtube/a.opus", 1)); AudioCatalog.Row row = catalog.rows.get(0);
        AudioDelete.Version version = new AudioDelete.Version(catalog.root, row.document.path, row.document.id, 42, 1, "a".repeat(64));
        AudioLedger.Item item = new AudioLedger.Item("durable-version", version, "Real title", null, AudioListening.unplayed(120000));
        catalog = catalog.identified(row.id, row.version, item);
        AudioCatalog.Row identified = catalog.rows.get(0);
        AudioCatalog invalidated = catalog.invalidate(identified.id, identified.version, ids);
        AudioCatalog.Row next = invalidated.rows.get(0);
        assertNull(next.fingerprint); assertNull(next.durableId); assertNotEquals(identified.version, next.version);
        assertEquals(row.id, next.id);
        AudioCatalog refreshed = AudioCatalog.listed(invalidated, invalidated.root, 1, Collections.singletonList(entry("youtube/a.opus", 1)), ids);
        assertSame(next, refreshed.rows.get(0));
    }
}
