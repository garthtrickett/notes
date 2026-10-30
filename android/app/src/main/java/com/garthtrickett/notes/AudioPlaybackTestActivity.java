package com.garthtrickett.notes;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.Spinner;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

// PLAN-AUDIO step 2 qualification controls. The production Audio/SAM UI stays
// behind the storage and playback gates. This Activity never owns a player.
public class AudioPlaybackTestActivity extends Activity {
    private AudioRuntime runtime;
    private Spinner recordings;
    private SeekBar seek;
    private TextView state, receipt, history;
    private Button restore;
    private final List<Button> commands = new ArrayList<>();
    private List<AudioCatalog.Row> rows = Collections.emptyList();
    private String choicesKey = "";
    private boolean dragging;
    private final AudioRuntime.Listener listener = this::show;

    @Override public void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        runtime = AudioRuntime.get(this);
        LinearLayout page = new LinearLayout(this); page.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (16 * getResources().getDisplayMetrics().density); page.setPadding(pad, pad, pad, pad);
        ScrollView scroll = new ScrollView(this); scroll.addView(page); setContentView(scroll);
        text(page, "Audio playback test", 24);
        text(page, "Choose an Opus, MP3 or M4B recording from the selected phone folder. Playback belongs to Notes' native service and can continue when you leave this screen. Bookmarks and marks stay on this phone.", 16);
        state = text(page, "Loading saved audio state…", 16);
        recordings = new Spinner(this); page.addView(recordings);
        button(page, "Refresh local recordings", runtime::refresh, false);
        button(page, "Play / resume selected recording", () -> {
            AudioCatalog.Row row = selected();
            if (row != null) runtime.play(runtime.target(row), this::reply);
        }, true);
        button(page, "Pause", runtime::pause, false);
        button(page, "Back 15 seconds", () -> {
            AudioPlaybackService.Position player = runtime.snapshot().player;
            if (player != null) runtime.seek(player.elapsedMs - 15000);
        }, true);
        button(page, "Forward 30 seconds", () -> {
            AudioPlaybackService.Position player = runtime.snapshot().player;
            if (player != null) runtime.seek(player.elapsedMs + 30000);
        }, true);
        seek = new SeekBar(this); seek.setMax(10000); seek.setContentDescription("Playback position"); page.addView(seek);
        seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            public void onStartTrackingTouch(SeekBar bar) { dragging = true; }
            public void onProgressChanged(SeekBar bar, int progress, boolean user) {}
            public void onStopTrackingTouch(SeekBar bar) {
                dragging = false;
                AudioPlaybackService.Position player = runtime.snapshot().player;
                if (player != null && player.durationMs > 0) runtime.seek(Math.round(player.durationMs * (bar.getProgress() / 10000.0)));
            }
        });
        button(page, "Mark selected recording Done", () -> mark(AudioListening.Mark.DONE), true);
        button(page, "Mark selected recording Unplayed", () -> mark(AudioListening.Mark.UNPLAYED), true);
        receipt = text(page, "Nothing plays until you tap Play.", 16);
        restore = button(page, "Restore prior checkpoint", () -> new AlertDialog.Builder(this)
            .setTitle("Restore an older audio checkpoint?")
            .setMessage("The most recent bookmark or marks may be lost. Notes keeps the damaged state before restoring the last readable checkpoint.")
            .setNegativeButton("Cancel", null).setPositiveButton("Restore", (dialog, which) -> runtime.restore(this::reply)).show(), false);
        restore.setVisibility(View.GONE);
        history = text(page, "", 14);
        button(page, "Back to Notes", this::finish, false);
    }

    private TextView text(LinearLayout page, String value, int size) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setPadding(0, 8, 0, 8); page.addView(view); return view;
    }
    private Button button(LinearLayout page, String label, Runnable action, boolean command) {
        Button button = new Button(this); button.setText(label); button.setOnClickListener(view -> action.run()); page.addView(button);
        if (command) commands.add(button); return button;
    }
    private AudioCatalog.Row selected() {
        int index = recordings.getSelectedItemPosition();
        return index >= 0 && index < rows.size() ? rows.get(index) : null;
    }
    private void mark(AudioListening.Mark mark) {
        AudioCatalog.Row row = selected(); if (row != null) runtime.mark(runtime.target(row), mark, this::reply);
    }
    private void reply(String operation, boolean durable, AudioProblem error) {
        if (isDestroyed()) return;
        receipt.setText(error == null && durable ? "Listening state saved." :
            error == null ? "Operation finished." : error.kind + ": " + error.getMessage());
    }
    private static String time(long ms) { long seconds = Math.max(0, ms / 1000); return String.format(Locale.ROOT, "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60); }
    private void show(AudioRuntime.Snapshot snapshot) {
        if (isDestroyed()) return;
        String selectedId = selected() == null ? null : selected().id;
        StringBuilder key = new StringBuilder();
        for (AudioCatalog.Row row : snapshot.catalog.rows) key.append(row.id).append(':').append(row.version).append('\n');
        rows = snapshot.catalog.rows;
        if (!key.toString().equals(choicesKey)) {
            choicesKey = key.toString();
            List<String> labels = new ArrayList<>(); int selected = 0;
            for (int i = 0; i < rows.size(); i++) {
                AudioCatalog.Row row = rows.get(i); labels.add(row.title + " · " + row.document.path);
                if (row.id.equals(selectedId)) selected = i;
            }
            ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, labels);
            adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
            recordings.setAdapter(adapter); if (!rows.isEmpty()) recordings.setSelection(selected);
        }
        boolean busy = snapshot.operation != null;
        for (Button command : commands) command.setEnabled(!busy && !rows.isEmpty());
        String summary = snapshot.operation == null ? rows.size() + " local recordings · native player test" : snapshot.operation;
        if (snapshot.failure != null) summary += "\n" + snapshot.failure.kind + ": " + snapshot.failure.getMessage();
        if (snapshot.warning != null) summary += "\n" + snapshot.warning;
        AudioPlaybackService.Position player = snapshot.player;
        if (player != null) {
            AudioLedger.Item item = snapshot.ledger.items.get(player.item);
            summary += "\n" + (item == null ? "Recording" : item.title) + "\n" + (player.playing ? "Playing " : "Paused ") +
                time(player.elapsedMs) + " · remaining " + (player.durationMs > 0 ? time(player.durationMs - player.elapsedMs) : "unknown");
        }
        state.setText(summary);
        seek.setEnabled(!busy && player != null && player.durationMs > 0);
        if (!dragging) seek.setProgress(player == null || player.durationMs <= 0 ? 0 : (int) Math.min(10000, player.elapsedMs * 10000.0 / player.durationMs));
        restore.setVisibility(snapshot.recoveryRequired ? View.VISIBLE : View.GONE);
        StringBuilder saved = new StringBuilder("Saved listening history\n");
        for (AudioLedger.Item item : snapshot.ledger.items.values()) saved.append(item.title).append(" · ").append(item.listening.mark)
            .append(" · ").append(time(item.listening.positionMs)).append('\n');
        history.setText(saved);
    }
    @Override public void onStart() { super.onStart(); runtime.subscribe(listener); runtime.refresh(); }
    @Override public void onStop() { runtime.unsubscribe(listener); super.onStop(); }
}
