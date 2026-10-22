package com.garthtrickett.notes;

import android.util.AtomicFile;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.function.Supplier;
import org.json.JSONException;
import org.json.JSONObject;

// One serialized writer calls this object. No command is acknowledged until
// save returns. A failed write faults this instance until disk is re-opened.
final class AudioStateFile {
    enum Kind { STORAGE, CORRUPT, FUTURE_SCHEMA, RECOVERY_REQUIRED }
    static final class Failure extends IOException {
        final Kind kind;
        Failure(Kind kind, String message) { super(message); this.kind = kind; }
        Failure(Kind kind, String message, Exception cause) { super(message, cause); this.kind = kind; }
    }
    interface Disk {
        byte[] primary() throws IOException;
        byte[] previous() throws IOException;
        void primary(byte[] bytes) throws IOException;
        void previous(byte[] bytes) throws IOException;
        void preservePrimary() throws IOException;
    }
    private final Disk disk;
    private AudioLedger current;
    private byte[] currentBytes;
    private boolean faulted, recoveryRequired;
    private String warning;

    AudioStateFile(Disk disk) throws Failure {
        this.disk = disk;
        try {
            byte[] bytes = disk.primary();
            if (bytes != null) {
                try { current = decode(bytes); currentBytes = bytes; return; }
                catch (Failure failure) { if (failure.kind == Kind.FUTURE_SCHEMA) throw failure; }
            }
            byte[] prior = disk.previous();
            if (prior != null) {
                current = decode(prior); currentBytes = prior; recoveryRequired = true;
                warning = "Recovered an older audio checkpoint for inspection. The latest bookmark or marks may be lost. Restore it explicitly before saving or deleting.";
            } else if (bytes == null) {
                current = AudioLedger.empty(); currentBytes = encode(current);
            } else throw new Failure(Kind.CORRUPT, "Audio state is corrupt and no prior checkpoint is available. Original file retained; deletion disabled.");
        } catch (Failure failure) { throw failure; }
        catch (IOException e) { throw new Failure(Kind.STORAGE, "Could not read audio state. No empty library or missing marks are being assumed.", e); }
    }

    AudioLedger current() { return current; }
    String warning() { return warning; }
    boolean recoveryRequired() { return recoveryRequired; }
    boolean writable() { return !recoveryRequired && !faulted; }

    void save(AudioLedger next) throws Failure {
        if (recoveryRequired) throw new Failure(Kind.RECOVERY_REQUIRED, warning);
        if (faulted) throw new Failure(Kind.STORAGE, "Reopen audio state after the failed write before retrying.");
        byte[] bytes = encode(next);
        try {
            // Keep the last validated checkpoint before replacing its successor.
            disk.previous(currentBytes);
            disk.primary(bytes);
            current = next; currentBytes = bytes;
        } catch (IOException e) {
            faulted = true;
            throw new Failure(Kind.STORAGE, "Audio state could not be saved. The action has not been acknowledged.", e);
        }
    }

    void restorePrior() throws Failure {
        if (!recoveryRequired) return;
        try {
            disk.preservePrimary();
            disk.primary(currentBytes);
            recoveryRequired = false;
            warning = "Restored an older audio checkpoint. The latest bookmark or marks may be lost; original damaged state was preserved.";
        } catch (IOException e) {
            faulted = true;
            throw new Failure(Kind.STORAGE, "Could not restore the prior checkpoint; original state retained.", e);
        }
    }

    private static byte[] encode(AudioLedger ledger) throws Failure {
        try {
            JSONObject json = ledger.json();
            AudioLedger.parse(json); // Never persist an invalid deletion target/checkpoint.
            return json.toString().getBytes(StandardCharsets.UTF_8);
        } catch (JSONException e) { throw new Failure(Kind.CORRUPT, "Invalid audio state was refused before writing.", e); }
    }
    private static AudioLedger decode(byte[] bytes) throws Failure {
        try {
            JSONObject json = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            long schema = AudioLedger.integer(json, "schema");
            if (schema != AudioLedger.SCHEMA) throw new Failure(Kind.FUTURE_SCHEMA,
                "Unknown audio state schema. Install a compatible app version; original state retained and deletion disabled.");
            return AudioLedger.parse(json);
        } catch (JSONException e) { throw new Failure(Kind.CORRUPT, "Corrupt audio state; original file retained.", e); }
    }

    static Disk android(File directory, Supplier<String> newId) {
        return new Disk() {
            final AtomicFile primary = new AtomicFile(new File(directory, "audio-state.json"));
            final AtomicFile previous = new AtomicFile(new File(directory, "audio-state.previous.json"));
            public byte[] primary() throws IOException { return AudioAtomicFiles.read(primary); }
            public byte[] previous() throws IOException { return AudioAtomicFiles.read(previous); }
            public void primary(byte[] bytes) throws IOException { AudioAtomicFiles.write(primary, bytes); }
            public void previous(byte[] bytes) throws IOException { AudioAtomicFiles.write(previous, bytes); }
            public void preservePrimary() throws IOException {
                byte[] original = primary();
                if (original == null) return;
                String id = newId.get();
                if (!id.matches("[a-zA-Z0-9-]+")) throw new IOException("Invalid recovery archive ID");
                File archive = new File(directory, "audio-state.corrupt-" + id + ".json");
                if (archive.exists()) throw new IOException("Recovery archive already exists; it was not overwritten.");
                AudioAtomicFiles.write(new AtomicFile(archive), original);
            }
        };
    }
}
