package com.garthtrickett.notes;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import java.util.UUID;

/** Copies the sender's temporary grants before handing off to the existing
 * single-task Notes activity. It never opens another WebView or user profile. */
public class PhotoShareActivity extends Activity {
    private String id;
    private long receivedAt;
    private boolean handedOff;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        id = state == null ? UUID.randomUUID().toString() : state.getString("photo-share-id");
        receivedAt = state == null ? System.currentTimeMillis() : state.getLong("photo-share-time");
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER);
        content.addView(new ProgressBar(this));
        TextView label = new TextView(this);
        label.setText("Adding photos to Notes…");
        label.setTextSize(18);
        label.setPadding(24, 24, 24, 24);
        content.addView(label);
        setContentView(content);
        Intent source = new Intent(getIntent());
        PhotoInbox inbox = new PhotoInbox(this);
        Handler main = new Handler(Looper.getMainLooper());
        PhotoInbox.worker.execute(() -> {
            String error = null;
            try { inbox.receive(id, receivedAt, source); }
            catch (Exception problem) { error = problem.getMessage() == null
                ? "Could not receive these photos." : problem.getMessage(); }
            final String failure = error;
            main.post(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (failure == null) {
                    handedOff = true;
                    startActivity(new Intent(this, MainActivity.class).setAction(PhotoInbox.READY)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP));
                } else Toast.makeText(this, failure, Toast.LENGTH_LONG).show();
                finish();
            });
        });
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        state.putString("photo-share-id", id);
        state.putLong("photo-share-time", receivedAt);
        super.onSaveInstanceState(state);
    }

    @Override protected void onDestroy() {
        // Back cancels this receive; rotation preserves it through the saved ID.
        if (isFinishing() && !handedOff) {
            PhotoInbox inbox = new PhotoInbox(this);
            PhotoInbox.worker.execute(() -> {
                try { inbox.acknowledge(id); } catch (Exception ignored) { }
            });
        }
        super.onDestroy();
    }
}
