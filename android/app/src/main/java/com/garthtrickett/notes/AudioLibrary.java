package com.garthtrickett.notes;

import android.content.Intent;
import android.net.Uri;
import java.io.IOException;
import java.util.ArrayList;
import java.util.concurrent.CompletableFuture;

// Local library transactions. Only native capabilities can name files; a
// confirmation is bound to a fingerprint, never a path supplied by JavaScript.
final class AudioLibrary {
    interface PreparedReply { void complete(Confirmation confirmation, AudioProblem failure); }
    static final class Confirmation {
        final String token, title, path;
        final long size;
        final AudioCatalog.Target target;
        final AudioDelete.Version version;
        Confirmation(String token, AudioCatalog.Target target, AudioCatalog.Row row, AudioDelete.Version version) {
            this.token = token; this.target = target; this.title = row.title;
            this.path = version.path; this.size = version.size; this.version = version;
        }
    }
    private final AudioRuntime runtime;
    private Confirmation confirmation;
    AudioLibrary(AudioRuntime runtime) { this.runtime = runtime; }
    void available() throws AudioProblem {
        if (runtime.mutating) throw new AudioProblem(AudioProblem.Kind.STALE, "Wait for the current audio action to finish.");
    }
    void canUse(AudioCatalog.Row row) throws AudioProblem {
        available();
        for (String id : runtime.ledger.deletions.keySet()) {
            AudioLedger.Item item = runtime.ledger.items.get(id);
            if (runtime.ledger.deletions.get(id) == AudioLedger.DeletePhase.INTENT && item.version.root.equals(runtime.ledger.root) &&
                item.version.path.equals(row.document.path)) throw new AudioProblem(AudioProblem.Kind.RECOVERY, "Resolve this pending deletion using Retry or Stop retrying first.");
        }
    }
    private void begin(String message) throws AudioProblem {
        available(); runtime.stopRootOperations(); runtime.mutating = true;
        runtime.operation = message; runtime.failure = null; runtime.emit();
    }
    private void finish(String op, AudioRuntime.Reply reply, Exception error) {
        runtime.main.post(() -> {
            runtime.mutating = false; runtime.operation = null;
            runtime.failure = error == null ? null : AudioProblem.from(error); runtime.emit();
            reply.complete(op, error == null, runtime.failure);
        });
    }
    void prepare(AudioCatalog.Target target, PreparedReply reply) {
        try {
            available();
            AudioCatalog.Row row = runtime.catalog.target(target, runtime.epoch, runtime.ledger);
            canUse(row);
            confirmation = null;
            // This phase does not pause, mutate the ledger, or create an intent.
            String request = runtime.ids.get();
            AudioTasks.FILES.execute(() -> {
                try {
                    AudioDocuments docs = AudioDocuments.library(runtime.context.getContentResolver(), runtime.ledger.root, null);
                    AudioDelete.Version version = runtime.identify(docs, row);
                    if (!docs.hasGrant(true)) throw new SecurityException("Select the folder again to grant write access.");
                    Confirmation prepared = new Confirmation(request, target, row, version);
                    runtime.main.post(() -> {
                        try {
                            available(); runtime.catalog.target(target, runtime.epoch, runtime.ledger);
                            confirmation = prepared; reply.complete(prepared, null);
                        } catch (Exception error) { reply.complete(null, AudioProblem.from(error)); }
                    });
                } catch (Exception error) { runtime.main.post(() -> reply.complete(null, AudioProblem.from(error))); }
            });
        } catch (Exception error) { reply.complete(null, AudioProblem.from(error)); }
    }
    void cancel(String token) { if (confirmation != null && confirmation.token.equals(token)) confirmation = null; }
    void confirm(String token, AudioRuntime.Reply reply) {
        String op = runtime.ids.get();
        try {
            Confirmation prepared = confirmation;
            if (prepared == null || !prepared.token.equals(token)) throw new AudioProblem(AudioProblem.Kind.STALE, "Select Delete download again.");
            AudioCatalog.Row row = runtime.catalog.target(prepared.target, runtime.epoch, runtime.ledger);
            begin("Deleting phone download…"); confirmation = null;
            release(prepared.version);
            AudioTasks.FILES.execute(() -> {
                try {
                    AudioLedger.Item item = runtime.write(() -> {
                        runtime.catalog.target(prepared.target, runtime.epoch, runtime.ledger);
                        AudioLedger.Item known = runtime.ledger.find(prepared.version);
                        if (known == null) known = new AudioLedger.Item(runtime.ids.get(), prepared.version, row.title, row.author,
                            AudioListening.unplayed(row.durationMs));
                        else known = new AudioLedger.Item(known.id, prepared.version, known.title, known.author, known.listening);
                        // Persisting the exact version precedes every destructive provider call.
                        runtime.save(runtime.ledger.put(known).deletion(known.id, AudioLedger.DeletePhase.INTENT));
                        return known;
                    });
                    delete(item); finish(op, reply, null);
                } catch (Exception error) { finish(op, reply, error); }
            });
        } catch (Exception error) { reply.complete(op, false, AudioProblem.from(error)); }
    }
    private void release(AudioDelete.Version version) {
        if (runtime.service == null || runtime.service.loaded() == null) return;
        AudioDelete.Version loaded = runtime.service.loaded().item.version;
        if (loaded.root.equals(version.root) && loaded.path.equals(version.path)) runtime.service.clear();
    }
    private AudioDelete.Journal journal(String id) {
        return new AudioDelete.Journal() {
            private void save(AudioLedger.DeletePhase phase) throws IOException {
                try { runtime.write(() -> { runtime.save(runtime.ledger.deletion(id, phase)); return null; }); }
                catch (Exception error) { throw new IOException("Deletion result could not be saved. Reopen audio state before retrying.", error); }
            }
            public void intent(AudioDelete.Version v) throws IOException { save(AudioLedger.DeletePhase.INTENT); }
            public void result(AudioDelete.Version v, String outcome) throws IOException {
                save(outcome.equals("absent") ? AudioLedger.DeletePhase.ABSENT :
                    outcome.equals("changed") ? AudioLedger.DeletePhase.CHANGED : AudioLedger.DeletePhase.INTENT);
            }
        };
    }
    private void delete(AudioLedger.Item item) throws Exception {
        if (!item.version.root.equals(runtime.ledger.root)) throw new AudioProblem(AudioProblem.Kind.STALE, "The selected audio folder changed before deletion.");
        AudioDocuments docs = AudioDocuments.library(runtime.context.getContentResolver(), item.version.root, null);
        String outcome = AudioDelete.delete(item.version, docs, journal(item.id));
        if (!outcome.equals("absent")) throw new AudioProblem(AudioProblem.Kind.VERSION_CHANGED,
            "The download was replaced. The replacement was kept; refresh to see it.");
        runtime.main.post(() -> { runtime.catalog = runtime.catalog.removed(item.version); runtime.emit(); });
    }
    void retry(String id, AudioRuntime.Reply reply) {
        String op = runtime.ids.get();
        try {
            available();
            AudioLedger.Item item = runtime.ledger.items.get(id);
            if (item == null || !item.version.root.equals(runtime.ledger.root) ||
                runtime.ledger.deletions.get(id) != AudioLedger.DeletePhase.INTENT)
                throw new AudioProblem(AudioProblem.Kind.STALE, "There is no pending deletion for this item.");
            begin("Retrying phone deletion…"); release(item.version);
            AudioTasks.FILES.execute(() -> { try { delete(item); finish(op, reply, null); }
                catch (Exception error) { finish(op, reply, error); } });
        } catch (Exception error) { reply.complete(op, false, AudioProblem.from(error)); }
    }
    void stopRetrying(String id, AudioRuntime.Reply reply) {
        String op = runtime.ids.get();
        try {
            begin("Saving deletion decision…");
            AudioTasks.STATE.execute(() -> { try {
                runtime.save(runtime.ledger.cancelDeletion(id)); finish(op, reply, null);
            } catch (Exception error) { finish(op, reply, error); } });
        } catch (Exception error) { reply.complete(op, false, AudioProblem.from(error)); }
    }
    // Called only after a successful root query. Reconciliation never removes bytes.
    void reconcile(AudioDocuments docs) throws Exception {
        if (!runtime.state.get().writable()) return;
        for (String id : new ArrayList<>(runtime.ledger.deletions.keySet())) {
            AudioLedger.Item item = runtime.ledger.items.get(id);
            if (runtime.ledger.deletions.get(id) == AudioLedger.DeletePhase.INTENT && item.version.root.equals(runtime.ledger.root))
                AudioDelete.reconcile(item.version, docs, journal(id));
        }
    }
    void bind(Uri chosen, int flags, AudioRuntime.Reply reply) {
        String op = runtime.ids.get();
        try {
            available(); runtime.ledger.bind(chosen.toString()); // refuse outstanding production intents before altering grants
            begin("Opening audio folder…"); confirmation = null;
            if (runtime.service != null) runtime.service.clear();
            AudioTasks.FILES.execute(() -> {
                try {
                    String old = runtime.ledger.root;
                    runtime.context.getContentResolver().takePersistableUriPermission(chosen, flags);
                    AudioDocuments docs = new AudioDocuments(runtime.context.getContentResolver(), chosen.toString(), null);
                    if (!docs.hasGrant(true)) throw new SecurityException("Choose a local folder with read and write access.");
                    // The existing selected-folder file is shared with the installed diagnostics.
                    AudioSpikeJournal binding = new AudioSpikeJournal(runtime.context.getFilesDir());
                    binding.bind(chosen.toString());
                    runtime.write(() -> { runtime.save(runtime.ledger.bind(chosen.toString())); return null; });
                    if (!old.isEmpty() && !old.equals(chosen.toString())) {
                        try { runtime.context.getContentResolver().releasePersistableUriPermission(Uri.parse(old),
                            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION); }
                        catch (SecurityException ignored) { /* A previously revoked grant is already released. */ }
                    }
                    runtime.main.post(() -> { runtime.catalog = AudioCatalog.empty(); });
                    finish(op, (operation, durable, failure) -> { reply.complete(operation, durable, failure); if (failure == null) runtime.refresh(); }, null);
                } catch (Exception error) { finish(op, reply, error); }
            });
        } catch (Exception error) { reply.complete(op, false, AudioProblem.from(error)); }
    }
    void reopen(AudioRuntime.Reply reply) {
        String op = runtime.ids.get();
        try {
            begin("Reopening audio state…"); confirmation = null;
            if (runtime.service != null) runtime.service.clear();
            AudioTasks.STATE.execute(() -> {
                try {
                    AudioStateFile file = new AudioStateFile(AudioStateFile.android(runtime.context.getFilesDir(), runtime.ids));
                    runtime.ledger = file.current(); runtime.state = CompletableFuture.completedFuture(file);
                    runtime.main.post(() -> { runtime.warning = file.warning(); runtime.recoveryRequired = file.recoveryRequired(); });
                    finish(op, (operation, durable, failure) -> { reply.complete(operation, durable, failure); if (failure == null) runtime.refresh(); }, null);
                } catch (Exception error) { finish(op, reply, error); }
            });
        } catch (Exception error) { reply.complete(op, false, AudioProblem.from(error)); }
    }
    void markHistory(String id, AudioListening.Mark mark, AudioRuntime.Reply reply) {
        String op = runtime.ids.get();
        try {
            available();
            AudioLedger.Item item = runtime.ledger.items.get(id);
            if (item == null) throw new AudioProblem(AudioProblem.Kind.STALE, "The listening history changed.");
            begin("Saving listening mark…"); release(item.version);
            AudioTasks.STATE.execute(() -> { try {
                AudioLedger.Item current = runtime.ledger.items.get(id);
                runtime.save(runtime.ledger.put(current.listening(AudioListening.mark(current.listening, mark))));
                finish(op, reply, null);
            } catch (Exception error) { finish(op, reply, error); } });
        } catch (Exception error) { reply.complete(op, false, AudioProblem.from(error)); }
    }
}
