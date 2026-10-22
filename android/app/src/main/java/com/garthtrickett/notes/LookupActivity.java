package com.garthtrickett.notes;

import android.app.Activity;
import android.os.Bundle;
import android.text.Editable;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.util.UUID;

/** A separate, private dialog task: Save/Cancel returns to the launcher, never
 * opens the vault or disturbs a draft or audio in the existing Notes task. */
public class LookupActivity extends Activity {
    private String id;
    private EditText question;
    private Button save;
    private boolean saving;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        id = state == null ? UUID.randomUUID().toString() : state.getString("capture-id");
        setTitle(R.string.lookup_title);
        int pad = Math.round(20 * getResources().getDisplayMetrics().density);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(pad, pad / 2, pad, pad);
        TextView title = new TextView(this);
        title.setText(R.string.lookup_title);
        title.setTextSize(22);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        title.setPadding(0, 0, 0, pad / 2);
        content.addView(title);
        TextView prompt = new TextView(this);
        prompt.setText(R.string.lookup_prompt);
        prompt.setTextSize(16);
        content.addView(prompt);
        question = new EditText(this);
        question.setId(R.id.lookup_question);
        question.setHint(R.string.lookup_hint);
        question.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        question.setMinLines(2);
        question.setMaxLines(5);
        question.setGravity(Gravity.TOP);
        question.setFilters(new InputFilter[] { new InputFilter.LengthFilter(LookupInbox.MAX_TEXT) });
        content.addView(question, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView error = new TextView(this);
        error.setId(R.id.lookup_error);
        error.setTextColor(0xFFFFB4AB);
        content.addView(error);
        LinearLayout buttons = new LinearLayout(this);
        buttons.setGravity(Gravity.END);
        Button cancel = new Button(this);
        cancel.setId(R.id.lookup_cancel);
        cancel.setText(android.R.string.cancel);
        // Closing a popup is not dismissing the app's tasks: task removal can
        // call Media3's onTaskRemoved and stop a paused player/notification.
        // This separate activity is already excluded from Recents.
        cancel.setOnClickListener(v -> { if (!saving) finish(); });
        buttons.addView(cancel);
        save = new Button(this);
        save.setId(R.id.lookup_save);
        save.setText(R.string.lookup_save);
        save.setEnabled(false);
        buttons.addView(save);
        content.addView(buttons);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(content);
        setContentView(scroll);
        question.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            public void onTextChanged(CharSequence s, int start, int before, int count) { save.setEnabled(!saving && !s.toString().trim().isEmpty()); }
            public void afterTextChanged(Editable s) {}
        });
        // Explicit restoration also covers rotation while the native save is
        // finishing: the same ID makes a repeated Save harmless.
        if (state != null) question.setText(state.getString("question", ""));
        save.setOnClickListener(v -> {
            if (saving || question.getText().toString().trim().isEmpty()) return;
            saving = true;
            question.setEnabled(false); save.setEnabled(false); cancel.setEnabled(false);
            error.setText("");
            String text = question.getText().toString();
            long at = System.currentTimeMillis();
            LookupInbox.worker.execute(() -> {
                try {
                    new LookupInbox(getApplicationContext()).save(id, text, at);
                    runOnUiThread(() -> {
                        if (isDestroyed() || isFinishing()) return;
                        Toast.makeText(this, R.string.lookup_saved, Toast.LENGTH_SHORT).show();
                        finish();
                    });
                } catch (Exception failed) {
                    runOnUiThread(() -> {
                        if (isDestroyed()) return;
                        saving = false; question.setEnabled(true); cancel.setEnabled(true);
                        save.setEnabled(!question.getText().toString().trim().isEmpty());
                        error.setText(R.string.lookup_failed);
                    });
                }
            });
        });
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE | WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        question.requestFocus();
        if (state != null && state.getBoolean("saving")) save.performClick();
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        state.putString("capture-id", id);
        state.putString("question", question.getText().toString());
        state.putBoolean("saving", saving);
        super.onSaveInstanceState(state);
    }
}
