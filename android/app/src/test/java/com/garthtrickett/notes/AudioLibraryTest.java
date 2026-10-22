package com.garthtrickett.notes;

import static org.junit.Assert.*;
import android.content.*;
import android.content.pm.ProviderInfo;
import android.database.*;
import android.net.Uri;
import android.os.*;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import java.io.*;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.util.concurrent.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowContentResolver;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36)
public class AudioLibraryTest {
    private static final String DOC = "root/youtube/ordinary.opus";
    private Context context;
    private AudioRuntime runtime;
    private Provider provider;
    private String root;
    public static class Provider extends ContentProvider {
        File bytes;
        boolean denyDelete;
        int removes;
        Context app;
        @Override public boolean onCreate() { return true; }
        @Override public String getType(Uri uri) { return "audio/ogg"; }
        @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
        @Override public int update(Uri uri, ContentValues values, String where, String[] args) { throw new UnsupportedOperationException(); }
        @Override public int delete(Uri uri, String where, String[] args) { throw new UnsupportedOperationException(); }
        @Override public Bundle call(String method, String arg, Bundle extras) {
            Bundle result = new Bundle();
            Uri uri = extras.getParcelable("uri", Uri.class);
            if (method.equals("android:isChildDocument")) {
                Uri child = extras.getParcelable("android.content.extra.TARGET_URI", Uri.class);
                result.putBoolean("result", isChildDocument(DocumentsContract.getDocumentId(uri), DocumentsContract.getDocumentId(child)));
            } else if (method.equals("android:deleteDocument")) deleteDocument(DocumentsContract.getDocumentId(uri));
            else throw new UnsupportedOperationException(method);
            return result;
        }
        private MatrixCursor cursor() { return new MatrixCursor(new String[]{Document.COLUMN_DOCUMENT_ID,
            Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE,
            Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS}); }
        private void row(MatrixCursor c, String id) {
            boolean dir = !id.equals(DOC);
            c.addRow(new Object[]{id, id.equals("root") ? "phone-media" : id.substring(id.lastIndexOf('/') + 1),
                dir ? Document.MIME_TYPE_DIR : "audio/ogg", dir ? 0 : bytes.length(), 123L, Document.FLAG_SUPPORTS_DELETE});
        }
        // Robolectric's resolver dispatches the legacy overload directly; a
        // real ContentResolver converts it to the provider's Bundle query.
        @Override public Cursor query(Uri uri, String[] p, String selection, String[] args, String sort) {
            String id = DocumentsContract.getDocumentId(uri);
            return uri.getPathSegments().contains("children") ? queryChildDocuments(id, p, sort) : queryDocument(id, p);
        }
        public Cursor queryDocument(String id, String[] p) {
            MatrixCursor c = cursor(); if (!id.equals(DOC) || bytes.exists()) row(c, id); return c;
        }
        public Cursor queryChildDocuments(String parent, String[] p, String sort) {
            MatrixCursor c = cursor();
            if (parent.equals("root")) row(c, "root/youtube");
            else if (parent.equals("root/youtube") && bytes.exists()) row(c, DOC);
            return c;
        }
        public boolean isChildDocument(String parent, String id) { return id.startsWith(parent + "/"); }
        public ParcelFileDescriptor openDocument(String id, String mode, CancellationSignal s) throws FileNotFoundException {
            return ParcelFileDescriptor.open(bytes, ParcelFileDescriptor.MODE_READ_ONLY);
        }
        public void deleteDocument(String id) {
            try {
                AudioLedger disk = new AudioStateFile(AudioStateFile.android(app.getFilesDir(), () -> "test")).current();
                assertTrue("intent precedes removal", disk.deletions.containsValue(AudioLedger.DeletePhase.INTENT));
                assertEquals(DOC, id);
                if (denyDelete) throw new SecurityException("Write permission revoked");
                assertTrue(bytes.delete()); removes++;
            } catch (AudioStateFile.Failure error) { throw new AssertionError(error); }
        }
    }
    private void await(CompletableFuture<?> result) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!result.isDone() && System.nanoTime() < end) { Shadows.shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(2); }
        result.get(1, TimeUnit.SECONDS); Shadows.shadowOf(Looper.getMainLooper()).idle();
    }
    @Before public void setup() throws Exception {
        AudioTasks.FILES.submit(() -> {}).get(10, TimeUnit.SECONDS); AudioTasks.STATE.submit(() -> {}).get(10, TimeUnit.SECONDS);
        Field singleton = AudioRuntime.class.getDeclaredField("instance"); singleton.setAccessible(true); singleton.set(null, null);
        context = RuntimeEnvironment.getApplication();
        for (File f : context.getFilesDir().listFiles()) if (f.getName().startsWith("audio-")) assertTrue(f.delete());
        provider = new Provider(); provider.app = context;
        provider.bytes = new File(context.getCacheDir(), "ordinary-audio.bin"); Files.write(provider.bytes.toPath(), new byte[]{1,2,3,4});
        ProviderInfo info = new ProviderInfo(); info.authority = AudioDocuments.AUTHORITY;
        info.exported = true; info.grantUriPermissions = true; info.readPermission = info.writePermission = "android.permission.MANAGE_DOCUMENTS";
        provider.attachInfo(context, info); ShadowContentResolver.registerProviderInternal(AudioDocuments.AUTHORITY, provider);
        Uri tree = DocumentsContract.buildTreeDocumentUri(AudioDocuments.AUTHORITY, "root"); root = tree.toString();
        context.getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        Shadows.shadowOf(context.getContentResolver()).registerInputStreamSupplier(DocumentsContract.buildDocumentUriUsingTree(tree, DOC), () -> {
            try { return new FileInputStream(provider.bytes); } catch (FileNotFoundException e) { throw new RuntimeException(e); }
        });
        runtime = AudioRuntime.get(context); runtime.state.get(10, TimeUnit.SECONDS);
        runtime.write(() -> { runtime.save(runtime.ledger.bind(root)); return null; });
        new AudioSpikeJournal(context.getFilesDir()).bind(root);
        AudioDocuments docs = AudioDocuments.library(context.getContentResolver(), root, null);
        runtime.catalog = AudioCatalog.listed(AudioCatalog.empty(), root, runtime.ledger.rootGeneration, docs.list(), runtime.ids);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
    }
    private AudioLibrary.Confirmation prepare() throws Exception {
        CompletableFuture<AudioLibrary.Confirmation> done = new CompletableFuture<>();
        runtime.library.prepare(runtime.target(runtime.catalog.rows.get(0)), (c, e) -> { if (e != null) done.completeExceptionally(e); else done.complete(c); });
        await(done); return done.get();
    }
    private AudioProblem confirm(AudioLibrary.Confirmation c) throws Exception {
        CompletableFuture<AudioProblem> done = new CompletableFuture<>(); runtime.library.confirm(c.token, (o, d, e) -> done.complete(e));
        await(done); return done.get();
    }
    @Test public void preparingAndCancellingNeverWritesIntentOrRemovesBytes() throws Exception {
        AudioLibrary.Confirmation c = prepare(); runtime.library.cancel(c.token);
        assertTrue(runtime.ledger.items.isEmpty()); assertTrue(runtime.ledger.deletions.isEmpty());
        assertTrue(provider.bytes.exists()); assertEquals(0, provider.removes);
        assertEquals(AudioProblem.Kind.STALE, confirm(c).kind);
    }
    @Test public void ordinaryDeletePersistsIntentThenRemovesBytesAndRetainsDoneHistory() throws Exception {
        AudioLibrary.Confirmation c = prepare();
        AudioLedger.Item known = new AudioLedger.Item("heard", c.version, "Ordinary recording", null,
            AudioListening.mark(AudioListening.unplayed(5000), AudioListening.Mark.DONE));
        runtime.write(() -> { runtime.save(runtime.ledger.put(known)); return null; });
        assertNull(confirm(c)); assertFalse(provider.bytes.exists()); assertEquals(1, provider.removes);
        assertEquals(AudioLedger.DeletePhase.ABSENT, runtime.ledger.deletions.get("heard"));
        assertEquals(AudioListening.Mark.DONE, runtime.ledger.items.get("heard").listening.mark);
        assertTrue(runtime.catalog.rows.isEmpty());
        AudioLedger reopened = new AudioStateFile(AudioStateFile.android(context.getFilesDir(), runtime.ids)).current();
        assertEquals(AudioLedger.DeletePhase.ABSENT, reopened.deletions.get("heard"));
    }
    @Test public void sameSizeSameTimeReplacementAfterPreparationIsKept() throws Exception {
        AudioLibrary.Confirmation c = prepare(); Files.write(provider.bytes.toPath(), new byte[]{4,3,2,1});
        assertEquals(AudioProblem.Kind.VERSION_CHANGED, confirm(c).kind);
        assertTrue(provider.bytes.exists()); assertEquals(0, provider.removes);
        assertTrue(runtime.ledger.deletions.containsValue(AudioLedger.DeletePhase.CHANGED));
    }
    @Test public void revokedWriteStaysPendingAndRetryNeverTargetsReplacement() throws Exception {
        AudioLibrary.Confirmation c = prepare(); provider.denyDelete = true;
        assertNotNull(confirm(c)); assertTrue(provider.bytes.exists());
        String id = runtime.ledger.items.values().iterator().next().id;
        assertEquals(AudioLedger.DeletePhase.INTENT, runtime.ledger.deletions.get(id));
        provider.denyDelete = false; Files.write(provider.bytes.toPath(), new byte[]{4,3,2,1});
        CompletableFuture<AudioProblem> done = new CompletableFuture<>(); runtime.library.retry(id, (o, d, e) -> done.complete(e));
        await(done); assertEquals(AudioProblem.Kind.VERSION_CHANGED, done.get().kind);
        assertEquals(0, provider.removes); assertTrue(provider.bytes.exists());
    }
    @Test public void diagnosticStillRejectsOrdinaryDownloads() throws Exception {
        AudioLibrary.Confirmation c = prepare(); AudioDocuments diagnostic = new AudioDocuments(context.getContentResolver(), root, null);
        assertThrows(IOException.class, () -> diagnostic.remove(c.version));
        assertTrue(provider.bytes.exists()); assertEquals(0, provider.removes);
    }
    @Test public void reconciliationOnlyObservesAndStoppingRetryNeverRemovesBytes() throws Exception {
        AudioLibrary.Confirmation c = prepare(); provider.denyDelete = true;
        assertNotNull(confirm(c));
        String id = runtime.ledger.items.values().iterator().next().id;
        provider.denyDelete = false;
        runtime.library.reconcile(AudioDocuments.library(context.getContentResolver(), root, null));
        assertEquals(AudioLedger.DeletePhase.INTENT, runtime.ledger.deletions.get(id));
        assertEquals(0, provider.removes);
        assertThrows(AudioProblem.class, () -> runtime.library.canUse(runtime.catalog.rows.get(0)));
        CompletableFuture<AudioProblem> done = new CompletableFuture<>(); runtime.library.stopRetrying(id, (o, d, e) -> done.complete(e));
        await(done); assertNull(done.get()); assertFalse(runtime.ledger.deletions.containsKey(id));
        assertTrue(provider.bytes.exists()); assertEquals(0, provider.removes);
    }

    @Test public void cancelledRefreshCannotRebindTheSelectedRoot() throws Exception {
        new AudioSpikeJournal(context.getFilesDir()).bind(root + "-other");
        runtime.refresh(); runtime.stopRootOperations();
        CompletableFuture<Void> done = new CompletableFuture<>(); AudioTasks.FILES.execute(() -> done.complete(null));
        await(done); assertEquals(root, runtime.ledger.root);
    }
    @Test public void staleMarkCannotCancelAnUnrelatedRefresh() throws Exception {
        AudioCatalog.Row row = runtime.catalog.rows.get(0);
        runtime.scan = new CancellationSignal(); runtime.operation = "Reading local audio…";
        CompletableFuture<AudioProblem> done = new CompletableFuture<>();
        runtime.mark(new AudioCatalog.Target(runtime.epoch, runtime.ledger.rootGeneration, row.id, "stale"),
            AudioListening.Mark.DONE, (o, d, e) -> done.complete(e));
        await(done); assertEquals(AudioProblem.Kind.STALE, done.get().kind); assertFalse(runtime.scan.isCanceled());
    }

}
