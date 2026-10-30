package com.garthtrickett.notes;

import java.util.Locale;

// One allowlist for the storage spike and the eventual native library.
final class AudioPaths {
    static boolean segment(String name) {
        if (name == null || name.isEmpty() || name.startsWith(".") ||
            name.indexOf('/') >= 0 || name.indexOf('\\') >= 0 || name.indexOf('\0') >= 0) return false;
        String lower = name.toLowerCase(Locale.ROOT);
        return !lower.contains("sync-conflict") && !lower.endsWith(".part") &&
            !lower.endsWith(".partial") && !lower.endsWith(".tmp") && !lower.endsWith(".download");
    }

    static boolean source(String name) {
        return "youtube".equals(name) || "podcasts".equals(name) || "audiobooks".equals(name) || "japanese".equals(name);
    }

    static boolean audio(String path) {
        String[] parts = path.split("/", -1);
        if (parts.length < 2 || !source(parts[0])) return false;
        for (String part : parts) if (!segment(part)) return false;
        String lower = path.toLowerCase(Locale.ROOT);
        // More formats are advertised only after actual-phone qualification.
        return lower.endsWith(".opus") || lower.endsWith(".m4b");
    }

    static boolean specimen(String path) {
        // This first spike cannot delete a user's recording, even by mistake.
        return "youtube/notes-audio-storage-test.opus".equals(path) ||
            "audiobooks/notes-audio-storage-test.m4b".equals(path);
    }
}
