package com.garthtrickett.notes;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.text.format.DateFormat;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.lang.ref.WeakReference;
import java.util.Date;

// The ringing screen: the time, the task, and two buttons. It makes no sound
// of its own — the notification that raised it does the ringing, so the alarm
// still rings when Android shows a heads-up instead of this screen.
public class AlarmActivity extends Activity {
    private static WeakReference<AlarmActivity> showing = new WeakReference<>(null);

    private Alarms.Entry entry;
    private TextView time;
    private TextView title;
    private TextView path;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(layout());
        showing = new WeakReference<>(this);
        bind(getIntent());
    }

    // A second alarm going off while this one is up replaces it on screen. Its
    // notification is still ringing and still has its own buttons.
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        bind(intent);
    }

    @Override
    protected void onDestroy() {
        if (showing.get() == this) showing.clear();
        super.onDestroy();
    }

    private void bind(Intent intent) {
        Alarms.Entry e = Alarms.Entry.from(intent);
        if (e == null) {
            finish();
            return;
        }
        entry = e;
        time.setText(DateFormat.getTimeFormat(this).format(new Date(e.at)));
        title.setText(e.title.isEmpty() ? "Notes alarm" : e.title);
        path.setText(e.path);
    }

    private void answer(String kind) {
        if (entry != null) Alarms.answer(getApplicationContext(), entry, kind, System.currentTimeMillis());
        finish();
    }

    // Answered from the notification instead: the screen has nothing left to ask.
    static void close(int id) {
        AlarmActivity a = showing.get();
        if (a == null) return;
        a.runOnUiThread(() -> {
            if (a.entry != null && a.entry.id == id) a.finish();
        });
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private TextView text(float sp, int color) {
        TextView v = new TextView(this);
        v.setTextSize(sp);
        v.setTextColor(color);
        v.setGravity(Gravity.CENTER);
        return v;
    }

    private Button button(String label, int background, Runnable onTap) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextSize(24);
        b.setTextColor(Color.WHITE);
        b.setBackgroundColor(background);
        b.setAllCaps(false);
        b.setOnClickListener(v -> onTap.run());
        return b;
    }

    private LinearLayout.LayoutParams half() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(120), 1f);
        params.setMargins(dp(8), 0, dp(8), 0);
        return params;
    }

    private LinearLayout layout() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(Color.rgb(16, 20, 24));
        root.setPadding(dp(24), dp(48), dp(24), dp(48));

        time = text(72, Color.WHITE);
        title = text(30, Color.WHITE);
        title.setPadding(0, dp(24), 0, dp(8));
        path = text(14, Color.rgb(150, 160, 170));
        root.addView(time);
        root.addView(title);
        root.addView(path);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        rowParams.topMargin = dp(64);
        row.addView(button("Snooze 10", Color.rgb(60, 70, 85), () -> answer("snooze")), half());
        row.addView(button("Done", Color.rgb(30, 130, 80), () -> answer("done")), half());
        root.addView(row, rowParams);
        return root;
    }
}
