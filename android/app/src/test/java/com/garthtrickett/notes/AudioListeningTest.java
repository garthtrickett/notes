package com.garthtrickett.notes;

import static org.junit.Assert.*;
import org.junit.Test;

public class AudioListeningTest {
    @Test public void explicitPlayStartsAndResumesWithoutChangingFiles() {
        AudioListening.State state = AudioListening.play(AudioListening.unplayed(120000));
        assertEquals(AudioListening.Mark.IN_PROGRESS, state.mark);
        state = AudioListening.checkpoint(state, 35000, 120000);
        assertEquals(35000, AudioListening.play(state).positionMs);
    }
    @Test public void markDoneRetainsBookmarkAndPlayAgainStartsAtZero() {
        AudioListening.State state = AudioListening.checkpoint(AudioListening.play(AudioListening.unplayed(120000)), 35000, 120000);
        state = AudioListening.mark(state, AudioListening.Mark.DONE);
        assertEquals(35000, state.positionMs);
        assertEquals(AudioListening.Mark.DONE, state.mark);
        state = AudioListening.play(state);
        assertEquals(0, state.positionMs);
        assertEquals(AudioListening.Mark.IN_PROGRESS, state.mark);
    }
    @Test public void unplayedResetsBookmarkAndLateCallbacksCannotUndoIt() {
        AudioListening.State playing = AudioListening.checkpoint(AudioListening.play(AudioListening.unplayed(120000)), 35000, 120000);
        AudioListening.State reset = AudioListening.mark(playing, AudioListening.Mark.UNPLAYED);
        assertSame(reset, AudioListening.checkpoint(reset, 36000, 120000));
        assertSame(reset, AudioListening.ended(reset, 120000, 120000));
        assertEquals(0, reset.positionMs);
    }
    @Test public void completionRetainsFinalBookmarkAndLatePauseKeepsDone() {
        AudioListening.State ended = AudioListening.ended(AudioListening.play(AudioListening.unplayed(120000)), 119999, 120000);
        assertEquals(AudioListening.Mark.DONE, ended.mark);
        assertEquals(120000, ended.positionMs);
        assertSame(ended, AudioListening.checkpoint(ended, 0, 120000));
    }
    @Test public void seeksClampAndUnknownDurationRefuses() {
        assertEquals(0, AudioListening.seek(-15000, 120000));
        assertEquals(120000, AudioListening.seek(Long.MAX_VALUE, 120000));
        assertEquals(20000, AudioListening.seek(20000, 120000));
        assertThrows(IllegalArgumentException.class, () -> AudioListening.seek(100, -1));
        assertThrows(IllegalArgumentException.class, () -> AudioListening.seek(100, 0));
    }
}
