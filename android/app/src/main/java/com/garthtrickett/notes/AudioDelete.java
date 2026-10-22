package com.garthtrickett.notes;

import java.io.IOException;
import java.util.Objects;

// Version-bound transaction, independent of Android providers and the UI.
// Recovery only observes: it NEVER replays a destructive call automatically.
final class AudioDelete {
    static final class Version {
        final String root, path, document, sha256;
        final long size, modified;

        Version(String root, String path, String document, long size, long modified, String sha256) {
            this.root = Objects.requireNonNull(root);
            this.path = Objects.requireNonNull(path);
            this.document = Objects.requireNonNull(document);
            this.size = size;
            this.modified = modified;
            this.sha256 = Objects.requireNonNull(sha256);
        }

        boolean same(Version other) {
            return other != null && root.equals(other.root) && path.equals(other.path) &&
                document.equals(other.document) && size == other.size &&
                modified == other.modified && sha256.equals(other.sha256);
        }
    }

    interface Documents {
        // null means a successful query established absence; errors must throw.
        Version identify(Version expected) throws IOException;
        void remove(Version expected) throws IOException;
        boolean absent(Version expected) throws IOException;
    }

    interface Journal {
        void intent(Version version) throws IOException;
        void result(Version version, String outcome) throws IOException;
    }

    static String delete(Version expected, Documents documents, Journal journal) throws IOException {
        // Even already-absent acknowledgments must be durable.
        journal.intent(expected);
        Version current = documents.identify(expected);
        if (current == null) {
            journal.result(expected, "absent");
            return "absent";
        }
        if (!expected.same(current)) {
            journal.result(expected, "changed");
            return "changed";
        }
        documents.remove(expected);
        if (!documents.absent(expected)) throw new IOException("Deletion is pending: the provider still lists the document.");
        journal.result(expected, "absent");
        return "absent";
    }

    static String reconcile(Version expected, Documents documents, Journal journal) throws IOException {
        Version current = documents.identify(expected);
        String outcome = current == null ? "absent" : expected.same(current) ? "pending" : "changed";
        journal.result(expected, outcome);
        return outcome;
    }
}
