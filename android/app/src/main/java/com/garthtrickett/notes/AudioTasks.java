package com.garthtrickett.notes;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// External file work must never hold up the small app-private checkpoint writer.
// Sharing FILES also serializes the diagnostic's delete with playback preparation.
final class AudioTasks {
    static final ExecutorService FILES = Executors.newSingleThreadExecutor(r -> new Thread(r, "notes-audio-files"));
    static final ExecutorService STATE = Executors.newSingleThreadExecutor(r -> new Thread(r, "notes-audio-state"));
}
