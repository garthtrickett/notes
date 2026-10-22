package com.garthtrickett.notes;

import java.io.IOException;

final class AudioProblem extends IOException {
    enum Kind { PERMISSION, MISSING, VERSION_CHANGED, UNSUPPORTED, STORAGE, PLAYBACK, CANCELLED, STALE, RECOVERY }
    final Kind kind;
    AudioProblem(Kind kind, String message) { super(message); this.kind = kind; }
    static AudioProblem from(Exception error) {
        Throwable value = error;
        while ((value instanceof java.util.concurrent.ExecutionException || value instanceof java.util.concurrent.CompletionException) && value.getCause() != null)
            value = value.getCause();
        if (value instanceof AudioProblem) return (AudioProblem) value;
        Kind kind = value instanceof SecurityException ? Kind.PERMISSION :
            value instanceof android.os.OperationCanceledException || value instanceof java.util.concurrent.CancellationException ? Kind.CANCELLED :
            value instanceof AudioStateFile.Failure ? Kind.STORAGE : Kind.PLAYBACK;
        return new AudioProblem(kind, value.getMessage() == null ? "Audio operation failed." : value.getMessage());
    }
}
