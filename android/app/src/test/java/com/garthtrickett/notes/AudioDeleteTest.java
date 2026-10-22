package com.garthtrickett.notes;

import static org.junit.Assert.*;
import java.io.IOException;
import org.junit.Test;

public class AudioDeleteTest {
    private final AudioDelete.Version original = version("original");
    private static AudioDelete.Version version(String sha) {
        return new AudioDelete.Version("tree", "youtube/notes-audio-storage-test.opus", "document", 42, 100, sha);
    }
    private static final class Files implements AudioDelete.Documents {
        AudioDelete.Version current;
        boolean denied, failRemove, falseSuccess;
        int removes;
        Files(AudioDelete.Version v) { current = v; }
        public AudioDelete.Version identify(AudioDelete.Version expected) throws IOException {
            if (denied) throw new IOException("permission");
            return current;
        }
        public void remove(AudioDelete.Version expected) throws IOException {
            removes++;
            if (failRemove) throw new IOException("read only");
            if (!falseSuccess) current = null;
        }
        public boolean absent(AudioDelete.Version expected) throws IOException { return identify(expected) == null; }
    }
    private static final class Store implements AudioDelete.Journal {
        boolean failIntent, failResult;
        String saved;
        AudioDelete.Version pending;
        Runnable afterIntent = () -> {};
        public void intent(AudioDelete.Version v) throws IOException {
            if (failIntent) throw new IOException("disk full");
            pending = v;
            saved = "pending";
            afterIntent.run();
        }
        public void result(AudioDelete.Version v, String outcome) throws IOException {
            if (failResult) throw new IOException("disk full");
            saved = outcome;
        }
    }
    @Test public void removesBytesBeforeDurableAcknowledgment() throws Exception {
        Files files = new Files(original); Store store = new Store();
        assertEquals("absent", AudioDelete.delete(original, files, store));
        assertNull(files.current); assertEquals("absent", store.saved); assertEquals(1, files.removes);
        assertEquals("absent", AudioDelete.delete(original, files, store));
        assertEquals(1, files.removes);
    }
    @Test public void intentWriteFailureCannotDelete() {
        Files files = new Files(original); Store store = new Store(); store.failIntent = true;
        assertThrows(IOException.class, () -> AudioDelete.delete(original, files, store));
        assertEquals(0, files.removes); assertNull(store.pending);
    }
    @Test public void replacementAfterIntentIsNeverRemoved() throws Exception {
        Files files = new Files(original); Store store = new Store();
        store.afterIntent = () -> files.current = version("replacement");
        assertEquals("changed", AudioDelete.delete(original, files, store));
        assertEquals(0, files.removes); assertEquals("changed", store.saved);
    }
    @Test public void accessFailureIsNotAbsence() {
        Files files = new Files(original); Store store = new Store(); files.denied = true;
        assertThrows(IOException.class, () -> AudioDelete.delete(original, files, store));
        assertEquals("pending", store.saved); assertEquals(0, files.removes);
    }
    @Test public void failedDeleteAndFalseProviderSuccessRemainPending() {
        Files files = new Files(original); Store store = new Store(); files.failRemove = true;
        assertThrows(IOException.class, () -> AudioDelete.delete(original, files, store));
        assertEquals("pending", store.saved);
        files.failRemove = false; files.falseSuccess = true;
        assertThrows(IOException.class, () -> AudioDelete.delete(original, files, store));
        assertEquals("pending", store.saved);
    }
    @Test public void crashAfterRemovalReconcilesWithoutAnotherDelete() throws Exception {
        Files files = new Files(original); Store store = new Store(); store.failResult = true;
        assertThrows(IOException.class, () -> AudioDelete.delete(original, files, store));
        assertNull(files.current); assertEquals("pending", store.saved);
        store.failResult = false;
        assertEquals("absent", AudioDelete.reconcile(store.pending, files, store));
        assertEquals(1, files.removes);
    }
    @Test public void recoveryObservesPendingOrReplacedFileWithoutDeleting() throws Exception {
        Files files = new Files(original); Store store = new Store(); store.intent(original);
        assertEquals("pending", AudioDelete.reconcile(original, files, store));
        files.current = version("new");
        assertEquals("changed", AudioDelete.reconcile(original, files, store));
        assertEquals(0, files.removes);
    }
    @Test public void pathAndDocumentArePartOfIdentityEvenForIdenticalBytes() {
        assertFalse(original.same(new AudioDelete.Version("tree", "podcasts/other.opus", "document", 42, 100, "original")));
        assertFalse(original.same(new AudioDelete.Version("tree", original.path, "other-document", 42, 100, "original")));
        assertFalse(original.same(new AudioDelete.Version("other-tree", original.path, "document", 42, 100, "original")));
    }
}
