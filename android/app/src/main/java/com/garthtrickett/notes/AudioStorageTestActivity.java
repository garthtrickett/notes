package com.garthtrickett.notes;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.IOException;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// Temporary native diagnostic for PLAN-AUDIO step 1, not the Audio library UI.
// Single process-wide writer survives Activity recreation; no scan on app boot.
public class AudioStorageTestActivity extends Activity {
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor();
    private static final int PICK_ROOT = 61;
    private LinearLayout controls, rows;
    private TextView message, details;
    private CancellationSignal scan = new CancellationSignal();
    private boolean destroyed;
    private String binding = "";

    interface Job<T> { T run() throws Exception; }
    interface Done<T> { void accept(T result) throws Exception; }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (16 * getResources().getDisplayMetrics().density);
        page.setPadding(pad, pad, pad, pad);
        ScrollView scroll = new ScrollView(this); scroll.addView(page); setContentView(scroll);
        text(page, "Audio storage test", 24);
        text(page, "Select this phone's phone-media folder. This test lists Opus and M4B files only. " +
            "Deletion is limited to the two disposable notes-audio-storage-test files. Your recordings cannot be deleted here.", 16);
        details = text(page, "Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")", 14);
        try { details.append(" · Notes " + getPackageManager().getPackageInfo(getPackageName(), 0).versionName); }
        catch (Exception ignored) { details.append(" · build unavailable"); }
        message = text(page, "", 16);
        controls = new LinearLayout(this); controls.setOrientation(LinearLayout.VERTICAL); page.addView(controls);
        button(controls, "Select phone-media folder", this::selectRoot);
        button(controls, "Refresh / check deleted test copy", this::refresh);
        rows = new LinearLayout(this); rows.setOrientation(LinearLayout.VERTICAL); page.addView(rows);
        button(page, "Back to Notes", this::finish);
        refresh();
    }

    private TextView text(LinearLayout parent, String value, int size) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setPadding(0, 8, 0, 8);
        parent.addView(view); return view;
    }
    private void button(LinearLayout parent, String label, Runnable action) {
        Button view = new Button(this); view.setText(label); view.setOnClickListener(v -> action.run()); parent.addView(view);
    }
    private void enabled(boolean enabled) {
        for (int i = 0; i < controls.getChildCount(); i++) controls.getChildAt(i).setEnabled(enabled);
        for (int i = 0; i < rows.getChildCount(); i++) rows.getChildAt(i).setEnabled(enabled);
    }
    private <T> void run(String status, Job<T> job, Done<T> done) {
        enabled(false); message.setText(status);
        WORKER.execute(() -> {
            try {
                T result = job.run();
                runOnUiThread(() -> {
                    if (destroyed) return;
                    enabled(true);
                    try { done.accept(result); } catch (Exception e) { failure(e); }
                });
            } catch (Exception e) {
                runOnUiThread(() -> { if (!destroyed) { enabled(true); failure(e); } });
            }
        });
    }
    private void failure(Exception error) {
        String prefix = error instanceof SecurityException ? "Permission: " :
            error instanceof android.os.OperationCanceledException ? "Cancelled: " : "Storage test: ";
        message.setText(prefix + (error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage()) +
            "\nNo successful deletion or missing library is being assumed. Retry Refresh or reselect the folder.");
    }

    private void selectRoot() {
        scan.cancel(); scan = new CancellationSignal();
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION |
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        try { startActivityForResult(intent, PICK_ROOT); } catch (Exception e) { failure(e); }
    }

    @Override public void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK_ROOT) return;
        if (result != RESULT_OK || data == null || data.getData() == null) {
            message.setText("Folder selection cancelled. The previous folder and files are unchanged."); return;
        }
        Uri chosen = data.getData();
        int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        run("Checking folder permission…", () -> {
            AudioSpikeJournal journal = new AudioSpikeJournal(getFilesDir());
            String old = journal.root();
            getContentResolver().takePersistableUriPermission(chosen, flags);
            try {
                new AudioDocuments(getContentResolver(), chosen.toString(), null);
                journal.bind(chosen.toString());
            } catch (Exception error) {
                if (!chosen.toString().equals(old)) release(chosen);
                throw error;
            }
            if (!old.isEmpty() && !old.equals(chosen.toString())) release(Uri.parse(old));
            return chosen.toString();
        }, root -> { binding = root; refresh(); });
    }

    private void release(Uri root) {
        try { getContentResolver().releasePersistableUriPermission(root,
            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION); }
        catch (SecurityException ignored) { /* An already revoked grant needs no release. */ }
    }

    private static final class Listing {
        String root, outcome;
        AudioDelete.Version deletion;
        List<AudioDocuments.Entry> files;
        boolean writable;
    }
    private void refresh() {
        scan.cancel(); scan = new CancellationSignal();
        CancellationSignal cancellation = scan;
        run("Reading local audio…", () -> {
            AudioSpikeJournal journal = new AudioSpikeJournal(getFilesDir());
            Listing result = new Listing(); result.root = journal.root();
            if (result.root.isEmpty()) return result;
            AudioDocuments documents = new AudioDocuments(getContentResolver(), result.root, cancellation);
            result.deletion = journal.deletion();
            if (result.deletion != null) {
                // Also check completed deletions after reconnect/rescan/restart:
                // a returned document is reported instead of hidden.
                result.outcome = AudioDelete.reconcile(result.deletion, documents, journal);
            }
            result.files = documents.list(); result.writable = documents.hasGrant(true);
            return result;
        }, listing -> {
            binding = listing.root;
            if (binding.isEmpty()) { message.setText("Choose the local phone-media folder to start."); return; }
            message.setText("Local folder access works · " + (listing.writable ? "read/write grant" : "read-only grant") +
                "\n" + listing.files.size() + " Opus/M4B files. This is a storage test; playback qualification is still pending.");
            rows.removeAllViews();
            if (listing.deletion != null) {
                String label = "absent".equals(listing.outcome) ? "Verified absent from the phone folder" :
                    "pending".equals(listing.outcome) ? "Present — deletion pending or the test copy returned" :
                    "Changed — a different test copy is present; the old deletion will not be retried";
                text(rows, listing.deletion.path + "\n" + label, 16);
                if ("pending".equals(listing.outcome)) {
                    button(rows, "Retry exact pending deletion", () -> confirm(listing.deletion));
                }
            }
            for (AudioDocuments.Entry entry : listing.files) {
                if (AudioPaths.specimen(entry.path)) {
                    text(rows, entry.path + "\n" + entry.size + " bytes · disposable test copy", 16);
                    button(rows, "Prepare deletion of test copy", () -> prepare(entry.path));
                }
            }
            int shown = 0;
            for (AudioDocuments.Entry entry : listing.files) {
                if (!AudioPaths.specimen(entry.path) && shown++ < 100) text(rows, entry.path + " · " + entry.size + " bytes", 14);
            }
            if (shown > 100) text(rows, "Showing the first 100 ordinary files in this diagnostic.", 14);
        });
    }

    private void prepare(String path) {
        String root = binding;
        CancellationSignal cancellation = scan;
        run("Preparing the exact test file (SHA-256)…", () -> {
            AudioSpikeJournal journal = new AudioSpikeJournal(getFilesDir());
            AudioDelete.Version pending = journal.deletion();
            if ("pending".equals(journal.outcome())) {
                if (pending == null || !pending.path.equals(path)) throw new IOException("Resolve the pending deletion first.");
                return pending;
            }
            return new AudioDocuments(getContentResolver(), root, cancellation).identify(path);
        }, version -> {
            if (version == null) { message.setText("The test copy is already absent. Refresh to verify the folder."); return; }
            message.setText("Test file prepared. No deletion has started.");
            confirm(version);
        });
    }

    private void confirm(AudioDelete.Version version) {
        new AlertDialog.Builder(this).setTitle("Delete test download?")
            .setMessage(version.path + "\n" + version.size + " bytes\n\nRemove this phone's disposable download. " +
                "This cannot be undone here. Server copies must remain intact. The test's deletion record is kept.")
            .setNegativeButton("Cancel", (dialog, which) -> message.setText("Deletion cancelled. No intent was saved and no file was removed."))
            .setPositiveButton("Delete test download", (dialog, which) -> remove(version)).show();
    }

    private void remove(AudioDelete.Version version) {
        run("Revalidating and deleting the selected test download…", () -> {
            AudioSpikeJournal journal = new AudioSpikeJournal(getFilesDir());
            AudioDelete.Version pending = journal.deletion();
            if ("pending".equals(journal.outcome()) && (pending == null || !pending.same(version)))
                throw new IOException("A different deletion is pending. Refresh to reconcile it first.");
            return AudioDelete.delete(version, new AudioDocuments(getContentResolver(), journal.root(), null), journal);
        }, outcome -> {
            message.setText("absent".equals(outcome) ? "Phone copy is absent and the result is saved. Refresh after Syncthing rescan/reconnect/restart." :
                "File changed. Nothing was deleted; the refusal is saved.");
            refresh();
        });
    }

    @Override public void onDestroy() {
        destroyed = true; scan.cancel();
        // Confirmed deletion remains on the serialized native writer. A new
        // Activity reconciles its durable intent instead of replaying commands.
        super.onDestroy();
    }
}
