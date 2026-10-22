package com.garthtrickett.notes;

// Listening is independent of file availability and in-flight operations.
// Immutable values let the native writer commit a transition before acknowledging
// it. Only explicit Play may change Unplayed/Done to In progress.
final class AudioListening {
    enum Mark { UNPLAYED, IN_PROGRESS, DONE }

    static final class State {
        final Mark mark;
        final long positionMs, durationMs;

        State(Mark mark, long positionMs, long durationMs) {
            if (mark == null || positionMs < 0 || durationMs < -1)
                throw new IllegalArgumentException("Invalid listening checkpoint");
            this.mark = mark;
            this.durationMs = durationMs;
            this.positionMs = mark == Mark.UNPLAYED ? 0 : clamp(positionMs, durationMs);
        }
    }

    static State unplayed(long durationMs) { return new State(Mark.UNPLAYED, 0, durationMs); }

    static State play(State state) {
        return new State(Mark.IN_PROGRESS, state.mark == Mark.DONE ? 0 : state.positionMs, state.durationMs);
    }

    static State checkpoint(State state, long positionMs, long durationMs) {
        // A late pause/position callback must not undo an acknowledged mark.
        if (state.mark != Mark.IN_PROGRESS) return state;
        return new State(state.mark, positionMs, durationMs);
    }

    static State mark(State state, Mark desired) {
        if (desired == Mark.IN_PROGRESS) throw new IllegalArgumentException("In progress requires Play");
        return new State(desired, desired == Mark.UNPLAYED ? 0 : state.positionMs, state.durationMs);
    }

    static State ended(State state, long positionMs, long durationMs) {
        if (state.mark != Mark.IN_PROGRESS) return state;
        return new State(Mark.DONE, durationMs >= 0 ? durationMs : positionMs, durationMs);
    }

    static long seek(long requestedMs, long durationMs) {
        if (durationMs <= 0) throw new IllegalArgumentException("Seeking requires a known positive duration");
        return clamp(requestedMs, durationMs);
    }

    private static long clamp(long positionMs, long durationMs) {
        long nonnegative = Math.max(0, positionMs);
        return durationMs >= 0 ? Math.min(nonnegative, durationMs) : nonnegative;
    }
}
