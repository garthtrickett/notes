package com.garthtrickett.notes;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.HashMap;
import java.util.function.Supplier;

// Ephemeral enumeration capabilities. Paths/URIs never act as command handles.
// A fingerprinted row points at a separate durable ledger version.
final class AudioCatalog {
    static final class Row {
        final String id, version, title, author, durableId;
        final AudioDocuments.Entry document;
        final AudioDelete.Version fingerprint;
        final long durationMs;
        final String error;
        Row(String id, String version, AudioDocuments.Entry document, String title, String author,
            long durationMs, String durableId, AudioDelete.Version fingerprint) {
            this(id, version, document, title, author, durationMs, durableId, fingerprint, null);
        }
        Row(String id, String version, AudioDocuments.Entry document, String title, String author,
            long durationMs, String durableId, AudioDelete.Version fingerprint, String error) {
            this.error = error;
            this.id = id; this.version = version; this.document = document; this.title = title; this.author = author;
            this.durationMs = durationMs; this.durableId = durableId; this.fingerprint = fingerprint;
        }
        Row identified(AudioLedger.Item item) {
            return new Row(id, item.id, document, item.title, item.author, item.listening.durationMs, item.id, item.version);
        }
    }
    static final class Target {
        final String epoch, item, version;
        final long rootGeneration;
        Target(String epoch, long rootGeneration, String item, String version) {
            this.epoch = epoch; this.rootGeneration = rootGeneration; this.item = item; this.version = version;
        }
    }
    final String root;
    final long rootGeneration;
    final List<Row> rows;
    AudioCatalog(String root, long generation, List<Row> rows) {
        this.root = root; rootGeneration = generation; this.rows = Collections.unmodifiableList(new ArrayList<>(rows));
    }
    static AudioCatalog empty() { return new AudioCatalog("", 0, Collections.emptyList()); }
    Row find(String id) { for (Row row : rows) if (row.id.equals(id)) return row; return null; }
    Row target(Target target, String epoch, AudioLedger ledger) throws AudioProblem {
        Row row = find(target.item);
        if (!epoch.equals(target.epoch) || target.rootGeneration != rootGeneration || rootGeneration != ledger.rootGeneration ||
            !root.equals(ledger.root) || row == null || !row.version.equals(target.version))
            throw new AudioProblem(AudioProblem.Kind.STALE, "The audio target changed. Refresh and try again.");
        return row;
    }
    AudioCatalog identified(String id, String expectedVersion, AudioLedger.Item item) {
        List<Row> next = new ArrayList<>();
        for (Row row : rows) next.add(row.id.equals(id) && row.version.equals(expectedVersion) ? row.identified(item) : row);
        return new AudioCatalog(root, rootGeneration, next);
    }
    AudioCatalog invalidate(String id, String expectedVersion, Supplier<String> ids) {
        List<Row> next = new ArrayList<>();
        for (Row row : rows) next.add(row.id.equals(id) && row.version.equals(expectedVersion) ?
            new Row(row.id, ids.get(), row.document, row.document.name.replaceFirst("(?i)\\.(opus|m4b|mp3)$", ""), null, -1, null, null) : row);
        return new AudioCatalog(root, rootGeneration, next);
    }
    AudioCatalog metadata(String id, String version, AudioProbe probe, String error) {
        List<Row> next = new ArrayList<>();
        for (Row row : rows) next.add(row.id.equals(id) && row.version.equals(version) ?
            new Row(row.id, row.version, row.document, probe == null ? row.title : probe.title,
                probe == null ? row.author : probe.author, probe == null ? row.durationMs : probe.durationMs,
                row.durableId, row.fingerprint, error) : row);
        return new AudioCatalog(root, rootGeneration, next);
    }
    AudioCatalog cached(AudioLedger ledger) {
        List<Row> next = new ArrayList<>();
        for (Row row : rows) {
            Row cached = row;
            if (row.durableId == null) for (AudioLedger.Item item : ledger.items.values()) {
                AudioDelete.Version v = item.version;
                if (v.root.equals(root) && v.path.equals(row.document.path) && v.document.equals(row.document.id) &&
                    v.size == row.document.size && v.modified == row.document.modified) cached = row.identified(item);
            }
            next.add(cached);
        }
        return new AudioCatalog(root, rootGeneration, next);
    }
    AudioCatalog removed(AudioDelete.Version version) {
        List<Row> next = new ArrayList<>();
        for (Row row : rows) if (!(root.equals(version.root) && row.document.path.equals(version.path))) next.add(row);
        return new AudioCatalog(root, rootGeneration, next);
    }
    static AudioCatalog listed(AudioCatalog previous, String root, long generation, List<AudioDocuments.Entry> documents, Supplier<String> ids) {
        List<Row> rows = new ArrayList<>();
        Map<String, Row> byPath = new HashMap<>();
        if (previous.root.equals(root) && previous.rootGeneration == generation)
            for (Row row : previous.rows) byPath.put(row.document.path, row);
        for (AudioDocuments.Entry document : documents) {
            Row known = byPath.get(document.path);
            if (known != null && !known.document.sameMetadata(document)) known = null;
            rows.add(known != null ? known : new Row(ids.get(), ids.get(), document,
                document.name.replaceFirst("(?i)\\.(opus|m4b|mp3)$", ""), null, -1, null, null));
        }
        return new AudioCatalog(root, generation, rows);
    }
}
