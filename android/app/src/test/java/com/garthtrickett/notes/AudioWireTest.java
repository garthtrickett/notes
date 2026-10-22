package com.garthtrickett.notes;

import static org.junit.Assert.*;
import com.getcapacitor.JSObject;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Collections;
import java.util.Iterator;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import org.json.JSONObject;
import org.json.JSONArray;

public class AudioWireTest {
    private static void sameJson(Object expected, Object actual) throws Exception {
        if (expected instanceof JSONObject) {
            assertTrue(actual instanceof JSONObject);
            JSONObject left = (JSONObject) expected, right = (JSONObject) actual;
            Set<String> leftKeys = new TreeSet<>(), rightKeys = new TreeSet<>();
            for (Iterator<String> keys = left.keys(); keys.hasNext();) leftKeys.add(keys.next());
            for (Iterator<String> keys = right.keys(); keys.hasNext();) rightKeys.add(keys.next());
            assertEquals(leftKeys, rightKeys);
            for (String key : leftKeys) sameJson(left.get(key), right.get(key));
        } else if (expected instanceof JSONArray) {
            assertTrue(actual instanceof JSONArray);
            JSONArray left = (JSONArray) expected, right = (JSONArray) actual;
            assertEquals(left.length(), right.length());
            for (int i = 0; i < left.length(); i++) sameJson(left.get(i), right.get(i));
        } else if (expected instanceof Number) {
            assertTrue(actual instanceof Number);
            assertEquals(((Number) expected).doubleValue(), ((Number) actual).doubleValue(), 0);
        } else assertEquals(expected, actual);
    }
    private AudioLedger ledger() {
        AudioDelete.Version version = new AudioDelete.Version(AudioLedgerTest.ROOT, "youtube/test.opus",
            "primary:phone-media/youtube/test.opus", 42, 123, "a".repeat(64));
        return AudioLedger.empty().bind(AudioLedgerTest.ROOT).put(new AudioLedger.Item("known-one", version,
            "Synthetic recording", null, AudioListening.mark(AudioListening.unplayed(5000), AudioListening.Mark.DONE)));
    }
    @Test public void reconnectProjectionIncludesListeningAndPlayerButNoStorageAuthority() throws Exception {
        AudioLedger ledger = ledger();
        AudioDocuments.Entry entry = new AudioDocuments.Entry("primary:phone-media/youtube/test.opus", "test.opus", "audio/ogg", 42, 123, 0, "youtube");
        AtomicInteger ids = new AtomicInteger();
        AudioCatalog catalog = AudioCatalog.listed(AudioCatalog.empty(), ledger.root, ledger.rootGeneration,
            Collections.singletonList(entry), () -> "cap-" + ids.incrementAndGet());
        AudioCatalog.Row row = catalog.rows.get(0);
        catalog = catalog.identified(row.id, row.version, ledger.items.get("known-one"));
        JSObject result = AudioWire.snapshot(new AudioRuntime.Snapshot("epoch-one", 4, ledger, catalog,
            new AudioPlaybackService.Position("known-one", 2000, 5000, false), null, null, null, false));
        assertEquals(1, result.getInt("protocol")); assertEquals("epoch-one", result.getString("epoch"));
        assertEquals(ledger.rootGeneration, result.getLong("rootGeneration")); assertEquals(4, result.getLong("revision"));
        assertEquals("DONE", result.getJSONArray("rows").getJSONObject(0).getJSONObject("listening").getString("mark"));
        assertEquals(2000, result.getJSONObject("player").getLong("positionMs"));
        assertTrue(result.getJSONArray("history").getJSONObject(0).getBoolean("currentRoot"));
        assertFalse(result.toString().contains("content://")); assertFalse(result.toString().contains("primary:"));
        assertFalse(result.toString().contains("a".repeat(64))); assertTrue(result.isNull("failure"));
        // The web parser reads this same fixture. Either side changing the
        // protocol without the other must fail this contract check.
        JSONObject contract = new JSONObject(new String(Files.readAllBytes(Paths.get("..", "..", "src", "audio-snapshot.fixture.json")), StandardCharsets.UTF_8));
        sameJson(contract, result);
    }
    @Test public void historySurvivesAnEmptyListingAndAnotherRootWithoutClaimingAbsence() throws Exception {
        AudioLedger ledger = ledger().bind(AudioLedgerTest.ROOT + "-other");
        JSObject result = AudioWire.snapshot(new AudioRuntime.Snapshot("epoch-two", 0, ledger, AudioCatalog.empty(),
            null, null, "Prior checkpoint recovered.", null, true));
        assertEquals(0, result.getJSONArray("rows").length()); assertEquals(1, result.getJSONArray("history").length());
        assertFalse(result.getJSONArray("history").getJSONObject(0).getBoolean("currentRoot"));
        assertTrue(result.getBoolean("recoveryRequired")); assertTrue(result.isNull("player"));
        assertFalse(result.toString().contains("MISSING"));
    }
}
