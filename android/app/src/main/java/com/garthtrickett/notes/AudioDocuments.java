package com.garthtrickett.notes;

import android.content.ContentResolver;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

// SAF only: no guessed /storage paths, cloud providers, or bridge audio blobs.
final class AudioDocuments implements AudioDelete.Documents {
    static final String AUTHORITY = "com.android.externalstorage.documents";
    private static final String[] COLUMNS = {Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME,
        Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS};
    final ContentResolver resolver;
    final Uri tree, root;
    final CancellationSignal cancellation;
    private int queried;

    static final class Entry {
        final String id, name, mime, path;
        final long size, modified, flags;
        Entry(Cursor cursor, String parent) throws IOException {
            this(cursor.getString(0), cursor.getString(1), cursor.getString(2), cursor.isNull(3) ? -1 : cursor.getLong(3),
                cursor.isNull(4) ? -1 : cursor.getLong(4), cursor.getLong(5), parent);
        }
        Entry(String id, String name, String mime, long size, long modified, long flags, String parent) throws IOException {
            if (id == null || name == null || mime == null) throw new IOException("The provider returned incomplete metadata.");
            this.id = id; this.name = name; this.mime = mime; this.size = size; this.modified = modified; this.flags = flags;
            path = parent.isEmpty() ? name : parent + "/" + name;
        }
        boolean directory() { return Document.MIME_TYPE_DIR.equals(mime); }
        boolean sameMetadata(Entry other) {
            return other != null && id.equals(other.id) && name.equals(other.name) &&
                size == other.size && modified == other.modified && mime.equals(other.mime);
        }
    }

    AudioDocuments(ContentResolver resolver, String binding, CancellationSignal cancellation) throws IOException {
        this.resolver = resolver;
        this.cancellation = cancellation;
        tree = Uri.parse(binding);
        if (!"content".equals(tree.getScheme()) || !AUTHORITY.equals(tree.getAuthority()) ||
            !DocumentsContract.isTreeUri(tree)) throw new IOException("Choose phone-media from this phone's local storage.");
        root = uri(DocumentsContract.getTreeDocumentId(tree));
        if (!hasGrant(false)) throw new SecurityException("Folder permission is missing. Select phone-media again.");
        Entry entry = stat(root, "");
        if (!entry.directory()) throw new IOException("Select the local folder receiving Phone media, not an individual file.");
    }

    boolean hasGrant(boolean write) {
        for (UriPermission permission : resolver.getPersistedUriPermissions()) {
            if (tree.equals(permission.getUri()) && permission.isReadPermission() &&
                (!write || permission.isWritePermission())) return true;
        }
        return false;
    }

    private Uri uri(String id) { return DocumentsContract.buildDocumentUriUsingTree(tree, id); }
    Uri playbackUri(AudioDelete.Version version) throws IOException {
        if (!tree.toString().equals(version.root) || !AudioPaths.audio(version.path)) throw new IOException("The selected audio root changed.");
        descendant(version.document);
        return uri(version.document);
    }
    private void check() { if (cancellation != null) cancellation.throwIfCanceled(); }
    private void descendant(String id) throws IOException {
        check();
        if (!DocumentsContract.isChildDocument(resolver, root, uri(id)))
            throw new IOException("The provider returned a document outside the selected root.");
    }

    private Entry stat(Uri uri, String parent) throws IOException {
        check();
        try (Cursor cursor = resolver.query(uri, COLUMNS, null, null, null, cancellation)) {
            if (cursor == null || !cursor.moveToFirst()) throw new IOException("The provider could not read the selected document.");
            Entry entry = new Entry(cursor, parent);
            if (cursor.moveToNext()) throw new IOException("The provider returned an ambiguous document.");
            return entry;
        }
    }

    private List<Entry> children(String id, String parent) throws IOException {
        check();
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, id);
        List<Entry> result = new ArrayList<>();
        try (Cursor cursor = resolver.query(children, COLUMNS, null, null, null, cancellation)) {
            if (cursor == null) throw new IOException("The provider did not answer the folder query. This is not evidence of absence.");
            Set<String> names = new HashSet<>();
            while (cursor.moveToNext()) {
                check();
                if (++queried > 10000) throw new IOException("Folder is too large for this storage test.");
                Entry entry = new Entry(cursor, parent);
                if (!AudioPaths.segment(entry.name)) continue;
                if (!names.add(entry.name)) throw new IOException("The provider returned duplicate names in one folder.");
                // Validate ancestry before using a returned document ID.
                descendant(entry.id);
                result.add(entry);
            }
        }
        return result;
    }

    List<Entry> list() throws IOException {
        List<Entry> result = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Entry source : children(DocumentsContract.getTreeDocumentId(tree), "")) {
            if (source.directory() && AudioPaths.source(source.name)) walk(source, result, seen, 0);
        }
        result.sort(Comparator.comparing((Entry e) -> e.name.toLowerCase(java.util.Locale.ROOT)).thenComparing(e -> e.path));
        return result;
    }

    private void walk(Entry folder, List<Entry> result, Set<String> seen, int depth) throws IOException {
        if (depth > 16 || !seen.add(folder.id) || seen.size() + result.size() > 10000)
            throw new IOException("Folder traversal limit reached; the last listing is retained.");
        for (Entry entry : children(folder.id, folder.path)) {
            if (entry.directory()) walk(entry, result, seen, depth + 1);
            else if (AudioPaths.audio(entry.path) && (entry.flags & Document.FLAG_VIRTUAL_DOCUMENT) == 0) result.add(entry);
        }
    }

    // A successful parent listing establishes absence; permission/query errors
    // propagate. Resolve the current path as well as the old document identity.
    private Entry find(String path) throws IOException {
        if (!AudioPaths.audio(path)) throw new IOException("Outside the audio sources.");
        String id = DocumentsContract.getTreeDocumentId(tree), parent = "";
        String[] parts = path.split("/");
        for (int i = 0; i < parts.length; i++) {
            Entry found = null;
            for (Entry entry : children(id, parent)) if (entry.name.equals(parts[i])) found = entry;
            if (found == null) return null;
            if (i == parts.length - 1) return found;
            if (!found.directory()) throw new IOException("An audio folder was replaced by a file.");
            id = found.id; parent = found.path;
        }
        throw new IOException("Invalid audio location.");
    }

    AudioDelete.Version identify(String path) throws IOException {
        Entry before = find(path);
        if (before == null) return null;
        if (before.directory() || (before.flags & Document.FLAG_VIRTUAL_DOCUMENT) != 0)
            throw new IOException("Only local, nonvirtual audio files can be used.");
        try {
            MessageDigest hash = MessageDigest.getInstance("SHA-256");
            long count = 0;
            try (InputStream stream = resolver.openInputStream(uri(before.id))) {
                if (stream == null) throw new IOException("The provider did not open the recording.");
                byte[] buffer = new byte[65536];
                int n;
                while ((n = stream.read(buffer)) != -1) {
                    check(); hash.update(buffer, 0, n); count += n;
                }
            }
            Entry after = find(path);
            if (!before.sameMetadata(after) || before.size != count || before.modified < 0)
                throw new IOException("The file changed during preparation. Wait for delivery to finish and retry.");
            StringBuilder digest = new StringBuilder();
            for (byte b : hash.digest()) digest.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
            return new AudioDelete.Version(tree.toString(), path, before.id, count, before.modified, digest.toString());
        } catch (java.security.NoSuchAlgorithmException impossible) { throw new IOException(impossible); }
    }

    public AudioDelete.Version identify(AudioDelete.Version expected) throws IOException {
        if (!tree.toString().equals(expected.root)) throw new IOException("The selected folder changed.");
        return identify(expected.path);
    }

    public void remove(AudioDelete.Version expected) throws IOException {
        if (!AudioPaths.specimen(expected.path)) throw new IOException("This test only deletes its disposable specimens.");
        if (!tree.toString().equals(expected.root)) throw new IOException("The selected folder changed.");
        if (!hasGrant(true)) throw new SecurityException("Write permission is missing. Reselect the folder.");
        Entry current = find(expected.path);
        if (current == null || !current.id.equals(expected.document) || current.size != expected.size ||
            current.modified != expected.modified) throw new IOException("The selected file changed before deletion.");
        if ((current.flags & Document.FLAG_SUPPORTS_DELETE) == 0) throw new IOException("This provider does not permit deleting that file.");
        if (!DocumentsContract.deleteDocument(resolver, uri(expected.document))) throw new IOException("The provider refused deletion.");
    }

    public boolean absent(AudioDelete.Version expected) throws IOException {
        if (!tree.toString().equals(expected.root)) throw new IOException("The selected folder changed.");
        return find(expected.path) == null;
    }
}
