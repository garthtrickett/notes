package com.garthtrickett.notes;

import static org.junit.Assert.*;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

public class AudioLedgerTest {
    static final String ROOT = "content://com.android.externalstorage.documents/tree/primary%3Aphone-media";
    private AudioLedger.Item item(String id, String path, String digest, long modified) {
        return new AudioLedger.Item(id, new AudioDelete.Version(ROOT, path, "primary:phone-media/" + path, 42, modified, digest),
            "Same title", null, AudioListening.unplayed(120000));
    }
    private AudioLedger populated() {
        return AudioLedger.empty().bind(ROOT).put(item("one", "youtube/a.opus", "a".repeat(64), 10));
    }
    @Test public void roundTripKeepsKnownVersionsMarksAndDeletionIndependent() throws Exception {
        AudioLedger state = populated();
        AudioLedger.Item item = state.items.get("one");
        state = state.put(item.listening(AudioListening.mark(AudioListening.play(item.listening), AudioListening.Mark.DONE)))
            .select("one").deletion("one", AudioLedger.DeletePhase.ABSENT);
        AudioLedger restored = AudioLedger.parse(new JSONObject(state.json().toString()));
        assertEquals(AudioListening.Mark.DONE, restored.items.get("one").listening.mark);
        assertEquals(AudioLedger.DeletePhase.ABSENT, restored.deletions.get("one"));
        assertEquals("one", restored.selected);
        assertEquals(1, restored.rootGeneration);
        assertNull(restored.items.get("one").author);
        assertFalse(restored.json().has("isPlaying"));
    }
    @Test public void replacementAndDuplicateTitlesDoNotInheritBookmarks() {
        AudioLedger state = populated();
        AudioLedger.Item original = state.items.get("one");
        state = state.put(original.listening(AudioListening.checkpoint(AudioListening.play(original.listening), 35000, 120000)));
        AudioLedger.Item replacement = item("two", "youtube/a.opus", "b".repeat(64), 10);
        assertNull(state.find(replacement.version));
        state = state.put(replacement).put(item("three", "podcasts/a.opus", "a".repeat(64), 10));
        assertEquals(3, state.items.size());
        assertEquals(35000, state.items.get("one").listening.positionMs);
        assertEquals(0, state.items.get("two").listening.positionMs);
        assertEquals(AudioListening.Mark.UNPLAYED, state.items.get("three").listening.mark);
        AudioLedger before = state;
        assertThrows(IllegalArgumentException.class, () -> before.put(item("one", "youtube/a.opus", "c".repeat(64), 10)));
    }
    @Test public void mtimeIsOnlyAHintAndChangingRootKeepsHistory() {
        AudioLedger state = populated();
        assertNotNull(state.find(item("unused", "youtube/a.opus", "a".repeat(64), 999).version));
        AudioLedger other = state.bind(ROOT + "-other");
        assertEquals(2, other.rootGeneration);
        assertNull(other.selected);
        assertEquals(1, other.items.size());
        assertThrows(IllegalArgumentException.class, () -> other.select("one"));
        AudioLedger pending = state.deletion("one", AudioLedger.DeletePhase.INTENT);
        assertThrows(IllegalStateException.class, () -> pending.bind(ROOT + "-other"));
    }
    @Test public void malformedFutureOrAmbiguousStateIsRejected() throws Exception {
        JSONObject normal = populated().json();
        for (String field : new String[] {"schema", "rootGeneration", "selected", "items", "deletions"}) {
            JSONObject broken = new JSONObject(normal.toString()); broken.remove(field);
            assertThrows(field, JSONException.class, () -> AudioLedger.parse(broken));
        }
        JSONObject future = new JSONObject(normal.toString()).put("schema", 999);
        assertThrows(JSONException.class, () -> AudioLedger.parse(future));
        JSONObject floatSchema = new JSONObject(normal.toString()).put("schema", 1.5);
        assertThrows(JSONException.class, () -> AudioLedger.parse(floatSchema));
        JSONObject duplicate = new JSONObject(normal.toString());
        JSONObject second = new JSONObject(duplicate.getJSONArray("items").getJSONObject(0).toString()).put("id", "two");
        duplicate.getJSONArray("items").put(second);
        assertThrows(JSONException.class, () -> AudioLedger.parse(duplicate));
    }
    @Test public void corruptDeletionTargetCannotBecomeAnOperation() throws Exception {
        JSONObject invalid = populated().json().put("deletions", new JSONArray().put(
            new JSONObject().put("item", "another-file").put("phase", "INTENT")));
        assertThrows(JSONException.class, () -> AudioLedger.parse(invalid));
        JSONObject phase = populated().json().put("deletions", new JSONArray().put(
            new JSONObject().put("item", "one").put("phase", "DELETE_EVERYTHING")));
        assertThrows(JSONException.class, () -> AudioLedger.parse(phase));
    }
    @Test public void corruptBookmarkIsNotSilentlyClamped() throws Exception {
        JSONObject invalid = populated().json();
        invalid.getJSONArray("items").getJSONObject(0).put("positionMs", 9999999);
        assertThrows(JSONException.class, () -> AudioLedger.parse(invalid));
    }
}
