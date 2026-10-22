package com.garthtrickett.notes;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import androidx.core.content.ContextCompat;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.function.Supplier;

// Process lifetime, not Activity lifetime. Main owns presentation/player handles;
// STATE owns durable mutations; FILES owns bounded provider/hash/probe work.
final class AudioRuntime {
    interface Listener { void changed(Snapshot snapshot); }
    interface Reply { void complete(String operation, boolean durable, AudioProblem failure); }
    static final class Snapshot {
        final String epoch, operation, warning;
        final long revision;
        final AudioLedger ledger;
        final AudioCatalog catalog;
        final AudioPlaybackService.Position player;
        final AudioProblem failure;
        final boolean recoveryRequired;
        Snapshot(String epoch, long revision, AudioLedger ledger, AudioCatalog catalog,
            AudioPlaybackService.Position player, String operation, String warning, AudioProblem failure, boolean recoveryRequired) {
            this.epoch = epoch; this.revision = revision; this.ledger = ledger; this.catalog = catalog;
            this.player = player; this.operation = operation; this.warning = warning; this.failure = failure;
            this.recoveryRequired = recoveryRequired;
        }
    }
    static final class Pending {
        final String token, operation;
        final AudioCatalog.Target target;
        final CancellationSignal cancellation = new CancellationSignal();
        final Reply reply;
        final long generation;
        boolean replied;
        Pending(String token, String operation, long generation, AudioCatalog.Target target, Reply reply) {
            this.token = token; this.operation = operation; this.generation = generation; this.target = target; this.reply = reply;
        }
    }
    static final class Prepared {
        final AudioLedger.Item item;
        final Uri uri;
        final long generation;
        Prepared(AudioLedger.Item item, Uri uri, long generation) { this.item = item; this.uri = uri; this.generation = generation; }
    }

    private static AudioRuntime instance;
    static synchronized AudioRuntime get(Context context) {
        if (instance == null) instance = new AudioRuntime(context.getApplicationContext(), () -> UUID.randomUUID().toString());
        return instance;
    }
    static void pauseExisting() {
        AudioRuntime runtime = instance;
        if (runtime != null) runtime.onMain(runtime::pause);
    }
    static void rootChanging() {
        AudioRuntime runtime = instance;
        if (runtime != null) runtime.onMain(() -> {
            runtime.cancelPending();
            runtime.cancelRootWork();
            if (runtime.scan != null) runtime.scan.cancel();
            if (runtime.service != null) runtime.service.clear();
        });
    }
    static void beforeDiagnosticDelete(AudioDelete.Version version) {
        AudioRuntime runtime = instance;
        if (runtime != null) runtime.onMain(() -> {
            AudioCatalog.Row preparing = runtime.pending == null ? null : runtime.catalog.find(runtime.pending.target.item);
            if (preparing != null && runtime.catalog.root.equals(version.root) && preparing.document.path.equals(version.path)) runtime.cancelPending();
            if (runtime.service != null && runtime.service.loaded() != null) {
                AudioDelete.Version playing = runtime.service.loaded().item.version;
                if (playing.root.equals(version.root) && playing.path.equals(version.path)) runtime.service.clear();
            }
        });
    }
    private final Context context;
    private final Supplier<String> ids;
    final Handler main = new Handler(Looper.getMainLooper());
    final String epoch;
    private final List<Listener> listeners = new ArrayList<>();
    private final CompletableFuture<AudioStateFile> state;
    private final Map<String, Long> sessions = new HashMap<>(); // STATE only
    private volatile AudioLedger ledger = AudioLedger.empty();
    private volatile AudioCatalog catalog = AudioCatalog.empty();
    private volatile long generation;
    private volatile Snapshot snapshot;
    private AudioPlaybackService service;
    private Pending pending;
    private CancellationSignal scan;
    private volatile CancellationSignal rootWork = new CancellationSignal();
    private String operation = "Loading audio state…", warning;
    private boolean recoveryRequired;
    private AudioProblem failure;
    private long revision;

    private AudioRuntime(Context context, Supplier<String> ids) {
        this.context = context; this.ids = ids; epoch = ids.get();
        snapshot = new Snapshot(epoch, 0, ledger, catalog, null, operation, null, null, false);
        state = CompletableFuture.supplyAsync(() -> {
            try {
                AudioStateFile file = new AudioStateFile(AudioStateFile.android(context.getFilesDir(), ids));
                ledger = file.current(); return file;
            } catch (AudioStateFile.Failure e) { throw new CompletionException(e); }
        }, AudioTasks.STATE);
        state.whenComplete((file, error) -> main.post(() -> {
            operation = null;
            if (error == null) { warning = file.warning(); recoveryRequired = file.recoveryRequired(); }
            else failure = AudioProblem.from((Exception) error);
            emit();
        }));
    }

    Snapshot snapshot() { return snapshot; }
    private void onMain(Runnable action) { if (Looper.myLooper() == Looper.getMainLooper()) action.run(); else main.post(action); }
    void subscribe(Listener listener) { listeners.add(listener); listener.changed(snapshot); }
    void unsubscribe(Listener listener) { listeners.remove(listener); }
    AudioCatalog.Target target(AudioCatalog.Row row) { return new AudioCatalog.Target(epoch, ledger.rootGeneration, row.id, row.version); }
    private void emit() {
        snapshot = new Snapshot(epoch, ++revision, ledger, catalog, service == null ? null : service.position(), operation, warning, failure, recoveryRequired);
        for (Listener listener : new ArrayList<>(listeners)) listener.changed(snapshot);
    }
    private <T> T write(Callable<T> action) throws Exception { return AudioTasks.STATE.submit(action).get(); }
    private void save(AudioLedger next) throws Exception {
        AudioStateFile file = state.get(); file.save(next); ledger = file.current();
    }
    private void report(Exception error) { main.post(() -> { failure = AudioProblem.from(error); operation = null; emit(); }); }

    void refresh() {
        if (scan != null) scan.cancel();
        CancellationSignal cancellation = new CancellationSignal(); scan = cancellation;
        operation = "Reading local audio…"; failure = null; emit();
        AudioTasks.FILES.execute(() -> {
            try {
                state.get();
                String root = new AudioSpikeJournal(context.getFilesDir()).root();
                if (root.isEmpty()) throw new AudioProblem(AudioProblem.Kind.PERMISSION, "Select Phone media in the storage test first.");
                if (!root.equals(ledger.root)) {
                    CompletableFuture<Void> paused = new CompletableFuture<>();
                    main.post(() -> { cancelPending(); cancelRootWork(); if (service != null) service.clear(); paused.complete(null); });
                    paused.get();
                    write(() -> { save(ledger.bind(root)); return null; });
                }
                long rootGeneration = ledger.rootGeneration;
                AudioDocuments documents = new AudioDocuments(context.getContentResolver(), root, cancellation);
                AudioCatalog result = AudioCatalog.listed(catalog, root, rootGeneration, documents.list(), ids);
                main.post(() -> {
                    if (scan != cancellation || cancellation.isCanceled() || ledger.rootGeneration != rootGeneration) return;
                    catalog = result; operation = null; failure = null; emit();
                });
            } catch (Exception error) { if (!cancellation.isCanceled()) report(error); }
        });
    }

    void play(AudioCatalog.Target target, Reply reply) {
        String op = ids.get();
        try {
            catalog.target(target, epoch, ledger);
            cancelPending();
            if (service != null) service.pausePlayer();
            Pending next = new Pending(ids.get(), op, ++generation, target, reply); pending = next;
            operation = "Preparing local audio…"; failure = null; emit();
            ContextCompat.startForegroundService(context, new Intent(context, AudioPlaybackService.class)
                .setAction(AudioPlaybackService.PREPARE).putExtra("token", next.token));
        } catch (Exception error) {
            AudioProblem problem = AudioProblem.from(error); failure = problem; operation = null;
            if (pending != null && pending.operation.equals(op)) finish(pending, problem);
            else reply.complete(op, false, problem);
            emit();
        }
    }
    boolean authorized(String token) { return pending != null && pending.token.equals(token) && !pending.cancellation.isCanceled(); }
    void attach(AudioPlaybackService service) { this.service = service; }
    void preparationFailed(String token, Exception error) {
        if (!authorized(token)) return;
        AudioProblem problem = AudioProblem.from(error);
        failure = problem; operation = null; finish(pending, problem); emit();
    }
    void detach(AudioPlaybackService source) { if (service == source) { service = null; emit(); } }
    void prepareFromService(String token) {
        if (!authorized(token)) return;
        Pending request = pending;
        AudioTasks.FILES.execute(() -> {
            try {
                AudioCatalog.Row row = catalog.target(request.target, epoch, ledger);
                AudioDocuments documents = new AudioDocuments(context.getContentResolver(), ledger.root, request.cancellation);
                Identified identified = identifyAndProbe(documents, row, request.cancellation);
                AudioDelete.Version version = identified.version; AudioProbe probe = identified.probe;
                AudioLedger.Item item = write(() -> {
                    if (request.cancellation.isCanceled() || request.generation != generation)
                        throw new AudioProblem(AudioProblem.Kind.CANCELLED, "Play was cancelled before state was saved.");
                    catalog.target(request.target, epoch, ledger);
                    AudioLedger.Item known = ledger.find(version);
                    AudioLedger.Item next = known == null ? new AudioLedger.Item(ids.get(), version, probe.title, probe.author,
                        AudioListening.unplayed(probe.durationMs)) : known;
                    next = next.listening(AudioListening.play(next.listening));
                    save(ledger.put(next).select(next.id)); sessions.put(next.id, request.generation); return next;
                });
                Prepared prepared = new Prepared(item, documents.playbackUri(version), request.generation);
                main.post(() -> {
                    if (pending != request || request.cancellation.isCanceled() || request.generation != generation || service == null) return;
                    catalog = catalog.identified(row.id, row.version, item);
                    try {
                        service.install(prepared); operation = null; failure = null; finish(request, null); emit();
                    } catch (Exception error) {
                        failure = AudioProblem.from(error); operation = null;
                        service.abortPreparation(); finish(request, failure); emit();
                    }
                });
            } catch (Exception error) { main.post(() -> {
                if (pending != request) return;
                AudioProblem problem = AudioProblem.from(error); failure = problem; operation = null;
                if (problem.kind == AudioProblem.Kind.VERSION_CHANGED) catalog = catalog.invalidate(request.target.item, request.target.version, ids);
                if (service != null) service.abortPreparation(); finish(request, problem); emit();
            }); }
        });
    }

    private AudioDelete.Version identify(AudioDocuments documents, AudioCatalog.Row row) throws Exception {
        AudioDelete.Version version = documents.identify(row.document.path);
        if (version == null) throw new AudioProblem(AudioProblem.Kind.MISSING, "This download is no longer present on the phone.");
        if (!version.document.equals(row.document.id) || version.size != row.document.size || version.modified != row.document.modified ||
            (row.fingerprint != null && !row.fingerprint.sha256.equals(version.sha256)))
            throw new AudioProblem(AudioProblem.Kind.VERSION_CHANGED, "This file version changed. Refresh before selecting it again.");
        return version;
    }
    private static final class Identified {
        final AudioDelete.Version version; final AudioProbe probe;
        Identified(AudioDelete.Version version, AudioProbe probe) { this.version = version; this.probe = probe; }
    }
    private Identified identifyAndProbe(AudioDocuments documents, AudioCatalog.Row row, CancellationSignal signal) throws Exception {
        AudioDelete.Version before = identify(documents, row);
        AudioProbe probe = AudioProbe.read(context, documents.playbackUri(before), row.document.name, signal);
        AudioDelete.Version after = identify(documents, row);
        if (!before.same(after)) throw new AudioProblem(AudioProblem.Kind.VERSION_CHANGED, "The recording changed while metadata was prepared. Refresh and retry.");
        return new Identified(after, probe);
    }
    private void finish(Pending request, AudioProblem error) {
        if (request.replied) return;
        request.replied = true; if (pending == request) pending = null;
        request.reply.complete(request.operation, error == null, error);
    }
    private void cancelPending() {
        ++generation;
        if (pending != null) {
            Pending previous = pending; previous.cancellation.cancel();
            finish(previous, new AudioProblem(AudioProblem.Kind.CANCELLED, "Preparation was cancelled."));
        }
    }
    private void cancelRootWork() { rootWork.cancel(); rootWork = new CancellationSignal(); }
    void pause() {
        cancelPending();
        if (service != null) { service.pausePlayer(); service.abortPreparation(); }
        operation = null; emit();
    }
    void resumeActive() {
        if (service == null || service.loaded() == null) return;
        String id = service.loaded().item.id;
        for (AudioCatalog.Row row : catalog.rows) if (id.equals(row.durableId)) { play(target(row), (op, durable, error) -> {}); return; }
        failure = new AudioProblem(AudioProblem.Kind.STALE, "Open the playback test and refresh before resuming."); emit();
    }
    void seek(long positionMs) {
        try { if (service != null) service.seek(positionMs); }
        catch (Exception error) { failure = AudioProblem.from(error); emit(); }
    }
    void mark(AudioCatalog.Target target, AudioListening.Mark mark, Reply reply) {
        String op = ids.get();
        try {
            AudioCatalog.Row row = catalog.target(target, epoch, ledger);
            if (pending != null && pending.target.item.equals(row.id)) cancelPending();
            if (service != null && service.loaded() != null && service.loaded().item.version.root.equals(catalog.root) &&
                service.loaded().item.version.path.equals(row.document.path)) service.pausePlayer();
            CancellationSignal cancellation = rootWork;
            operation = "Saving listening mark…"; failure = null; emit();
            AudioTasks.FILES.execute(() -> {
                try {
                    AudioDocuments documents = new AudioDocuments(context.getContentResolver(), ledger.root, cancellation);
                    Identified identified = identifyAndProbe(documents, row, cancellation);
                    AudioDelete.Version version = identified.version; AudioProbe probe = identified.probe;
                    AudioLedger.Item item = write(() -> {
                        cancellation.throwIfCanceled();
                        catalog.target(target, epoch, ledger);
                        AudioLedger.Item known = ledger.find(version);
                        if (known == null) known = new AudioLedger.Item(ids.get(), version, probe.title, probe.author, AudioListening.unplayed(probe.durationMs));
                        AudioLedger.Item next = known.listening(AudioListening.mark(known.listening, mark));
                        save(ledger.put(next)); sessions.remove(next.id); return next;
                    });
                    main.post(() -> {
                        if (ledger.rootGeneration == target.rootGeneration) {
                            catalog = catalog.identified(row.id, row.version, item); operation = null;
                            if (mark == AudioListening.Mark.UNPLAYED && service != null && service.loaded() != null && service.loaded().item.id.equals(item.id))
                                service.resetPosition();
                            emit();
                        }
                        reply.complete(op, true, null);
                    });
                } catch (Exception error) { main.post(() -> {
                    AudioProblem problem = AudioProblem.from(error);
                    if (ledger.rootGeneration == target.rootGeneration) {
                        failure = problem; operation = null;
                        if (problem.kind == AudioProblem.Kind.VERSION_CHANGED) catalog = catalog.invalidate(target.item, target.version, ids);
                        emit();
                    }
                    reply.complete(op, false, problem);
                }); }
            });
        } catch (Exception error) { reply.complete(op, false, AudioProblem.from(error)); }
    }

    void checkpoint(Prepared stream, long positionMs, long durationMs, boolean ended) {
        if (stream == null) return;
        AudioTasks.STATE.execute(() -> {
            try {
                if (!Long.valueOf(stream.generation).equals(sessions.get(stream.item.id))) return;
                AudioLedger.Item known = ledger.items.get(stream.item.id);
                if (known == null) return;
                AudioListening.State next = ended ? AudioListening.ended(known.listening, positionMs, durationMs) :
                    AudioListening.checkpoint(known.listening, positionMs, durationMs);
                if (next == known.listening) return;
                save(ledger.put(known.listening(next)));
                main.post(this::emit);
            } catch (Exception error) { main.post(() -> {
                failure = AudioProblem.from(error); if (service != null) service.pauseAfterFailure(); emit();
            }); }
        });
    }
    void playerChanged() { emit(); }
    void playbackFailed(Exception error) { failure = AudioProblem.from(error); operation = null; emit(); }
    void restore(Reply reply) {
        pause(); String op = ids.get();
        AudioTasks.STATE.execute(() -> {
            try {
                AudioStateFile file = state.get(); file.restorePrior(); ledger = file.current();
                main.post(() -> { warning = file.warning(); recoveryRequired = file.recoveryRequired(); failure = null; emit(); reply.complete(op, true, null); });
            } catch (Exception error) { main.post(() -> { failure = AudioProblem.from(error); emit(); reply.complete(op, false, failure); }); }
        });
    }
}
