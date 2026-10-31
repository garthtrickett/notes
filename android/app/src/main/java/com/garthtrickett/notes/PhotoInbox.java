package com.garthtrickett.notes;

import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.AtomicFile;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/** Temporary transport, not a second vault. A ready batch survives lost URI
 * grants and process restarts; only a durable web-vault receipt releases it. */
final class PhotoInbox {
    static final String READY = "com.garthtrickett.notes.PHOTOS_READY";
    static final int MAX_FILES = 10;
    static final long MAX_FILE_BYTES = 25_000_000;
    static final long MAX_BATCH_BYTES = 50_000_000;
    static final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Context context;
    private final File root;

    PhotoInbox(Context context) {
        this.context = context.getApplicationContext();
        root = new File(this.context.getFilesDir(), "photo-inbox");
    }

    private File directory(String id) throws IOException {
        if (id == null || !id.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))
            throw new IOException("Invalid photo share identifier.");
        return new File(root, id);
    }

    boolean hasPending() {
        File[] dirs = root.listFiles();
        if (dirs == null) return false;
        for (File dir : dirs) if (dir.isDirectory()) return true;
        return false;
    }

    @SuppressWarnings("deprecation")
    static List<Uri> sources(Intent intent) throws IOException {
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action))
            throw new IOException("Select a photo to share with Notes.");
        LinkedHashSet<Uri> uris = new LinkedHashSet<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Object stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (stream instanceof Uri) uris.add((Uri) stream);
        } else {
            ArrayList<?> streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (streams != null) for (Object stream : streams) {
                if (!(stream instanceof Uri)) throw new IOException("Invalid shared photo.");
                uris.add((Uri) stream);
            }
        }
        ClipData clip = intent.getClipData();
        if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) {
            Uri uri = clip.getItemAt(i).getUri();
            if (uri != null) uris.add(uri);
        }
        if (uris.isEmpty() || uris.size() > MAX_FILES)
            throw new IOException("Share between one and ten photos at a time.");
        for (Uri uri : uris) if (!"content".equals(uri.getScheme()))
            throw new IOException("The photo app did not provide readable photo access.");
        return new ArrayList<>(uris);
    }

    private static boolean image(String mime) {
        return mime != null && mime.startsWith("image/") && !mime.equals("image/svg+xml");
    }

    private JSONObject manifest(File dir) throws Exception {
        AtomicFile file = new AtomicFile(new File(dir, "ready.json"));
        byte[] bytes = file.readFully();
        if (bytes.length > 32_768) throw new IOException("Invalid saved photo share.");
        JSONObject value = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        JSONArray files = value.getJSONArray("files");
        if (value.getInt("schema") != 1 || !dir.getName().equals(value.getString("id")) ||
                value.getLong("receivedAt") < 0 || files.length() < 1 || files.length() > MAX_FILES)
            throw new IOException("Invalid saved photo share.");
        for (int i = 0; i < files.length(); i++) {
            JSONObject item = files.getJSONObject(i);
            if (!Integer.toString(i).equals(item.getString("key")) || !image(item.getString("mime")))
                throw new IOException("Invalid saved photo metadata.");
        }
        return value;
    }

    private String name(Uri uri, int index) {
        try (Cursor row = context.getContentResolver().query(uri,
                new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (row != null && row.moveToFirst()) {
                String value = row.getString(0);
                if (value != null && !value.trim().isEmpty())
                    return value.replaceAll("[\\p{Cntrl}/\\\\]", "_").substring(0, Math.min(value.length(), 160));
            }
        } catch (Exception ignored) { /* The bytes, not a display name, are required. */ }
        return "Photo " + (index + 1);
    }

    JSONObject receive(String id, long receivedAt, Intent intent) throws Exception {
        File dir = directory(id);
        if (new File(dir, "ready.json").exists()) return manifest(dir);
        List<Uri> uris = sources(intent);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Could not save the shared photos.");
        try {
            JSONArray files = new JSONArray();
            long total = 0;
            for (int i = 0; i < uris.size(); i++) {
                Uri uri = uris.get(i);
                String mime = context.getContentResolver().getType(uri);
                if (mime == null) mime = intent.getType();
                if (!image(mime)) throw new IOException("Only photos can be shared with Notes.");
                File target = new File(dir, i + ".image");
                long size = 0;
                try (InputStream in = context.getContentResolver().openInputStream(uri);
                     FileOutputStream out = new FileOutputStream(target)) {
                    if (in == null) throw new IOException("Could not read a shared photo.");
                    byte[] buffer = new byte[32_768];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        size += read;
                        total += read;
                        if (size > MAX_FILE_BYTES || total > MAX_BATCH_BYTES)
                            throw new IOException("Photos are too large. Share fewer or smaller photos.");
                        out.write(buffer, 0, read);
                    }
                    if (size == 0) throw new IOException("A shared photo was empty.");
                    out.getFD().sync();
                }
                files.put(new JSONObject().put("key", Integer.toString(i)).put("mime", mime).put("name", name(uri, i)));
            }
            JSONObject value = new JSONObject().put("schema", 1).put("id", id)
                .put("receivedAt", receivedAt).put("files", files);
            AtomicFile ready = new AtomicFile(new File(dir, "ready.json"));
            FileOutputStream out = null;
            try {
                out = ready.startWrite();
                out.write(value.toString().getBytes(StandardCharsets.UTF_8));
                out.getFD().sync();
                ready.finishWrite(out);
            } catch (Exception error) { ready.failWrite(out); throw error; }
            UrgeWidget.refresh(context);
            return value;
        } catch (Exception error) {
            remove(dir);
            throw error;
        }
    }

    JSArray pending() throws Exception {
        JSArray result = new JSArray();
        File[] dirs = root.listFiles();
        if (dirs == null) return result;
        java.util.Arrays.sort(dirs, java.util.Comparator.comparingLong(File::lastModified));
        for (File dir : dirs) if (dir.isDirectory() && new File(dir, "ready.json").exists())
            result.put(manifest(directory(dir.getName())));
        return result;
    }

    JSObject read(String id, String key) throws Exception {
        File dir = directory(id);
        JSONObject value = manifest(dir);
        if (key == null || !key.matches("[0-9]")) throw new IOException("Invalid photo selection.");
        JSONObject metadata = value.getJSONArray("files").getJSONObject(Integer.parseInt(key));
        File image = new File(dir, key + ".image");
        if (!image.isFile() || image.length() == 0 || image.length() > MAX_FILE_BYTES)
            throw new IOException("The saved photo could not be read.");
        return new JSObject().put("uri", Uri.fromFile(image).toString())
            .put("name", metadata.getString("name")).put("mime", metadata.getString("mime"));
    }

    void acknowledge(String id) throws Exception {
        File dir = directory(id);
        // Idempotent, including a lost bridge reply after deletion completed.
        if (dir.exists()) remove(dir);
        UrgeWidget.refresh(context);
    }

    private static void remove(File file) throws IOException {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) remove(child);
        if (file.exists() && !file.delete()) throw new IOException("Could not release a temporary photo copy.");
    }
}
