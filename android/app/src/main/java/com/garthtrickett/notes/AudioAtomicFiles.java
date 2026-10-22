package com.garthtrickett.notes;

import android.util.AtomicFile;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Arrays;

// Android's atomic replacement plus explicit fsync and commit verification.
// Shared by the diagnostic journal and the production checkpoint file.
final class AudioAtomicFiles {
    private static final int MAX_BYTES = 16 * 1024 * 1024;
    static byte[] read(AtomicFile file) throws IOException {
        if (!file.getBaseFile().exists() && !new File(file.getBaseFile() + ".bak").exists()) return null;
        try (InputStream stream = file.openRead(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16384];
            int count;
            while ((count = stream.read(buffer)) != -1) {
                if (bytes.size() + count > MAX_BYTES) throw new IOException("Audio state exceeds the storage limit; original file retained.");
                bytes.write(buffer, 0, count);
            }
            return bytes.toByteArray();
        }
    }

    static void write(AtomicFile file, byte[] bytes) throws IOException {
        if (bytes.length > MAX_BYTES) throw new IOException("Audio state exceeds the storage limit.");
        FileOutputStream stream = null;
        try {
            stream = file.startWrite();
            stream.write(bytes);
            stream.flush();
            stream.getFD().sync();
            file.finishWrite(stream);
            if (!Arrays.equals(read(file), bytes)) throw new IOException("The audio state commit could not be verified.");
        } catch (IOException e) {
            if (stream != null) file.failWrite(stream);
            throw e;
        }
    }
}
