package com.garthtrickett.notes;

import static org.junit.Assert.*;
import android.app.Activity;
import android.content.ClipData;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.Looper;
import android.provider.OpenableColumns;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CountDownLatch;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowContentResolver;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36)
public class PhotoInboxTest {
    private static final String ID = "12345678-1234-4123-8123-123456789abc";
    private static final Uri FIRST = Uri.parse("content://notes.test.photos/first");
    private static final Uri SECOND = Uri.parse("content://notes.test.photos/second");
    private Context context;
    private PhotoInbox inbox;
    private Provider provider;

    public static class Provider extends ContentProvider {
        String mime = "image/jpeg";
        @Override public boolean onCreate() { return true; }
        @Override public String getType(Uri uri) { return mime; }
        @Override public Cursor query(Uri uri, String[] columns, String selection, String[] args, String sort) {
            MatrixCursor row = new MatrixCursor(new String[] { OpenableColumns.DISPLAY_NAME });
            row.addRow(new Object[] { "camera.jpg" }); return row;
        }
        @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
        @Override public int update(Uri uri, ContentValues values, String where, String[] args) { throw new UnsupportedOperationException(); }
        @Override public int delete(Uri uri, String where, String[] args) { throw new UnsupportedOperationException(); }
    }

    @Before public void setup() throws Exception {
        PhotoInbox.worker.submit(() -> {}).get(10, TimeUnit.SECONDS);
        context = RuntimeEnvironment.getApplication();
        File old = new File(context.getFilesDir(), "photo-inbox");
        if (old.exists()) try (java.util.stream.Stream<java.nio.file.Path> paths = Files.walk(old.toPath())) {
            for (java.nio.file.Path path : paths.sorted(java.util.Comparator.reverseOrder()).toArray(java.nio.file.Path[]::new))
                Files.delete(path);
        }
        inbox = new PhotoInbox(context);
        provider = new Provider();
        ProviderInfo info = new ProviderInfo(); info.authority = "notes.test.photos";
        info.exported = true; info.grantUriPermissions = true;
        provider.attachInfo(context, info);
        ShadowContentResolver.registerProviderInternal(info.authority, provider);
        Shadows.shadowOf(context.getContentResolver()).registerInputStreamSupplier(FIRST,
            () -> new ByteArrayInputStream(new byte[] {1,2,3}));
        Shadows.shadowOf(context.getContentResolver()).registerInputStreamSupplier(SECOND,
            () -> new ByteArrayInputStream(new byte[] {4,5,6}));
    }

    private Intent single(Uri uri) {
        return new Intent(Intent.ACTION_SEND).setType("image/jpeg")
            .putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    }
    private Intent multiple(Uri... uris) {
        return new Intent(Intent.ACTION_SEND_MULTIPLE).setType("image/jpeg")
            .putParcelableArrayListExtra(Intent.EXTRA_STREAM, new ArrayList<>(Arrays.asList(uris)));
    }
    private File image(String id, String key) throws Exception {
        return new File(Uri.parse(inbox.read(id, key).getString("uri")).getPath());
    }

    @Test public void copiedPhotoSurvivesLostSourceGrantAndInboxRecreation() throws Exception {
        inbox.receive(ID, 1000, single(FIRST));
        Shadows.shadowOf(context.getContentResolver()).registerInputStreamSupplier(FIRST,
            () -> { throw new SecurityException("grant expired"); });
        PhotoInbox reopened = new PhotoInbox(context);
        assertEquals(1, reopened.pending().length());
        assertArrayEquals(new byte[] {1,2,3}, Files.readAllBytes(image(ID, "0").toPath()));
        // Replaying the same delivery after recreation never needs its old grant.
        assertEquals(ID, reopened.receive(ID, 2000, single(FIRST)).getString("id"));
        assertEquals(1, reopened.pending().length());
    }

    @Test public void multiplePhotosKeepOrderAndRepeatedClipDataDoesNotDuplicateThem() throws Exception {
        Intent source = multiple(FIRST, SECOND);
        source.setClipData(ClipData.newUri(context.getContentResolver(), "photo", FIRST));
        JSONObject value = inbox.receive(ID, 1000, source);
        assertEquals(2, value.getJSONArray("files").length());
        assertArrayEquals(new byte[] {4,5,6}, Files.readAllBytes(image(ID, "1").toPath()));
    }

    @Test public void supportsAClipOnlyImageShare() throws Exception {
        Intent source = new Intent(Intent.ACTION_SEND).setType("image/jpeg");
        source.setClipData(ClipData.newUri(context.getContentResolver(), "photo", FIRST));
        assertEquals(1, inbox.receive(ID, 1000, source).getJSONArray("files").length());
    }

    @Test public void refusesMissingImagesFileUrisAndNonPhotoActions() throws Exception {
        for (Intent source : new Intent[] { new Intent(Intent.ACTION_SEND).setType("image/jpeg"),
                single(Uri.fromFile(new File(context.getFilesDir(), "private"))), new Intent(Intent.ACTION_VIEW) }) {
            try { inbox.receive(ID, 1000, source); fail("invalid share accepted"); }
            catch (java.io.IOException expected) { }
            assertEquals(0, inbox.pending().length());
        }
    }

    @Test public void aFailedLaterPhotoLeavesNoPartialReadyBatch() throws Exception {
        Shadows.shadowOf(context.getContentResolver()).registerInputStreamSupplier(SECOND,
            () -> { throw new SecurityException("not granted"); });
        try { inbox.receive(ID, 1000, multiple(FIRST, SECOND)); fail(); }
        catch (SecurityException expected) { }
        assertEquals(0, inbox.pending().length());
        assertFalse(new File(context.getFilesDir(), "photo-inbox/" + ID).exists());
    }

    @Test public void rejectsSvgAndEmptyImagesWithoutCreatingANoteHandoff() throws Exception {
        provider.mime = "image/svg+xml";
        try { inbox.receive(ID, 1000, single(FIRST)); fail(); }
        catch (java.io.IOException expected) { }
        provider.mime = "image/jpeg";
        Shadows.shadowOf(context.getContentResolver()).registerInputStreamSupplier(FIRST, () -> new ByteArrayInputStream(new byte[0]));
        try { inbox.receive(ID, 1000, single(FIRST)); fail(); }
        catch (java.io.IOException expected) { }
        assertEquals(0, inbox.pending().length());
    }

    @Test public void rejectsAnOversizePhotoDuringStreamingAndCleansItsTemporaryBytes() throws Exception {
        Shadows.shadowOf(context.getContentResolver()).registerInputStreamSupplier(FIRST, () -> new InputStream() {
            long remaining = PhotoInbox.MAX_FILE_BYTES + 1;
            @Override public int read() { return remaining-- > 0 ? 0 : -1; }
            @Override public int read(byte[] buffer) {
                if (remaining <= 0) return -1;
                int n = (int) Math.min(remaining, buffer.length); remaining -= n; return n;
            }
        });
        try { inbox.receive(ID, 1000, single(FIRST)); fail(); }
        catch (java.io.IOException expected) { }
        assertEquals(0, inbox.pending().length());
        assertFalse(new File(context.getFilesDir(), "photo-inbox/" + ID).exists());
    }

    @Test public void rejectsTooManyImagesBeforeOpeningSources() throws Exception {
        Uri[] uris = new Uri[11];
        for (int i = 0; i < uris.length; i++) uris[i] = Uri.parse("content://notes.test.photos/" + i);
        try { inbox.receive(ID, 1000, multiple(uris)); fail(); }
        catch (java.io.IOException expected) { }
        assertEquals(0, inbox.pending().length());
    }

    @Test public void acknowledgmentIsIdempotentAndCannotEscapeTheInbox() throws Exception {
        File sentinel = new File(context.getFilesDir(), "keep.txt");
        Files.write(sentinel.toPath(), new byte[] {9});
        inbox.receive(ID, 1000, single(FIRST));
        try { inbox.acknowledge("../keep.txt"); fail(); }
        catch (java.io.IOException expected) { }
        try { inbox.read(ID, "../keep"); fail(); }
        catch (java.io.IOException expected) { }
        inbox.acknowledge(ID); inbox.acknowledge(ID);
        assertEquals(0, inbox.pending().length());
        assertTrue(sentinel.exists());
    }

    @Test public void androidChooserResolvesNotesForSingleAndMultipleImageSharesOnly() {
        for (String action : new String[] {Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE}) {
            Intent intent = new Intent(action).setType("image/jpeg").addCategory(Intent.CATEGORY_DEFAULT);
            assertTrue(context.getPackageManager().queryIntentActivities(intent, 0).stream()
                .anyMatch(r -> r.activityInfo.name.equals(PhotoShareActivity.class.getName()) && r.activityInfo.exported));
        }
        assertFalse(context.getPackageManager().queryIntentActivities(
            new Intent(Intent.ACTION_SEND).setType("text/plain").addCategory(Intent.CATEGORY_DEFAULT), 0).stream()
            .anyMatch(r -> r.activityInfo.name.equals(PhotoShareActivity.class.getName())));
    }

    @Test public void sharingActivityHandsOffToTheExistingSingleTaskNotesActivity() throws Exception {
        PhotoShareActivity activity = Robolectric.buildActivity(PhotoShareActivity.class, single(FIRST)).setup().get();
        PhotoInbox.worker.submit(() -> {}).get(10, TimeUnit.SECONDS);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        Intent launch = Shadows.shadowOf(activity).getNextStartedActivity();
        assertNotNull(launch);
        assertEquals(MainActivity.class.getName(), launch.getComponent().getClassName());
        assertEquals(PhotoInbox.READY, launch.getAction());
        assertTrue((launch.getFlags() & Intent.FLAG_ACTIVITY_SINGLE_TOP) != 0);
        assertTrue(activity.isFinishing());
        assertEquals(1, inbox.pending().length());
    }

    @Test public void backDuringReceivingDoesNotOpenNotesOrLeaveAPendingImport() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        Shadows.shadowOf(context.getContentResolver()).registerInputStreamSupplier(FIRST, () -> {
            try { assertTrue(release.await(10, TimeUnit.SECONDS)); }
            catch (InterruptedException error) { throw new RuntimeException(error); }
            return new ByteArrayInputStream(new byte[] {1,2,3});
        });
        org.robolectric.android.controller.ActivityController<PhotoShareActivity> controller =
            Robolectric.buildActivity(PhotoShareActivity.class, single(FIRST)).setup();
        PhotoShareActivity activity = controller.get();
        activity.finish(); controller.pause().stop().destroy();
        release.countDown();
        PhotoInbox.worker.submit(() -> {}).get(10, TimeUnit.SECONDS);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertNull(Shadows.shadowOf(activity).getNextStartedActivity());
        assertEquals(0, inbox.pending().length());
    }

    @Test public void recreationKeepsTheSameBatchAndLaunchesNotesOnce() throws Exception {
        CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
        Shadows.shadowOf(context.getContentResolver()).registerInputStreamSupplier(FIRST, () -> {
            started.countDown();
            try { assertTrue(release.await(10, TimeUnit.SECONDS)); }
            catch (InterruptedException error) { throw new RuntimeException(error); }
            return new ByteArrayInputStream(new byte[] {1,2,3});
        });
        org.robolectric.android.controller.ActivityController<PhotoShareActivity> first =
            Robolectric.buildActivity(PhotoShareActivity.class, single(FIRST)).setup();
        assertTrue(started.await(10, TimeUnit.SECONDS));
        android.os.Bundle state = new android.os.Bundle();
        first.saveInstanceState(state).pause().stop().destroy();
        PhotoShareActivity next = Robolectric.buildActivity(PhotoShareActivity.class, single(FIRST))
            .create(state).start().resume().visible().get();
        release.countDown();
        PhotoInbox.worker.submit(() -> {}).get(10, TimeUnit.SECONDS);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        // Robolectric's launch queue belongs to the instrumentation, not to
        // individual Activity shadows. Count the global handoffs exactly once.
        Intent launch = Shadows.shadowOf(RuntimeEnvironment.getApplication()).getNextStartedActivity();
        assertNotNull(launch);
        assertEquals(PhotoInbox.READY, launch.getAction());
        assertNull(Shadows.shadowOf(RuntimeEnvironment.getApplication()).getNextStartedActivity());
        assertEquals(1, inbox.pending().length());
    }
}
