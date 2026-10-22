package com.garthtrickett.notes;

import static org.junit.Assert.*;
import org.json.JSONException;
import org.junit.Test;

public class AudioSpikeJournalTest {
    private String intent(String path, String outcome, String hash) {
        return "{\"schema\":1,\"root\":\"tree\",\"deletion\":{\"root\":\"tree\",\"path\":\"" + path +
            "\",\"document\":\"doc\",\"size\":42,\"modified\":123,\"sha256\":\"" + hash + "\",\"outcome\":\"" + outcome + "\"}}";
    }
    @Test public void validIntentHasExactContentIdentity() throws Exception {
        assertEquals("pending", AudioSpikeJournal.parse(intent("youtube/notes-audio-storage-test.opus", "pending", "a".repeat(64)))
            .getJSONObject("deletion").getString("outcome"));
    }
    @Test public void unknownOrCorruptStateCannotBecomeDestructiveReplay() {
        for (String input : new String[] {"broken", "{}", "{\"schema\":2,\"root\":\"tree\"}",
            "{\"schema\":1.5,\"root\":\"tree\"}",
            "{\"schema\":1,\"root\":\"tree\",\"deletion\":{\"outcome\":\"pending\"}}",
            intent("youtube/real-recording.opus", "pending", "a".repeat(64)),
            intent("youtube/notes-audio-storage-test.opus", "unknown", "a".repeat(64)),
            intent("youtube/notes-audio-storage-test.opus", "pending", "not-a-sha")}) {
            assertThrows(input, JSONException.class, () -> AudioSpikeJournal.parse(input));
        }
    }
}
