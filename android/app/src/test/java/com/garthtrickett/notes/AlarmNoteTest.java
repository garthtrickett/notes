package com.garthtrickett.notes;

import static org.junit.Assert.*;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36)
public class AlarmNoteTest {
    public static class WithoutWebEngine extends MainActivity { @Override protected void load() {} }
    private Context context;
    private Alarms.Entry entry(int id, String path) {
        return new Alarms.Entry(id, 1_800_000_000_000L, "Read this note in Notes", path, 1_800_000_000_000L, false);
    }
    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("notes.alarm-note", 0).edit().clear().commit();
        context.getSharedPreferences("notes.alarms", 0).edit().clear().commit();
        context.getSystemService(NotificationManager.class).cancelAll();
    }
    @Test public void notificationOffersAnExplicitImmutableActivityActionForThisNote() {
        Alarms.Entry e = entry(1234, "reminders/gmail/test.md");
        Alarms.fire(context, e);
        Notification n = Shadows.shadowOf(context.getSystemService(NotificationManager.class)).getNotification("notes-alarm", e.id);
        assertNotNull(n);
        assertEquals(3, n.actions.length);
        assertEquals("Open note", n.actions[2].title.toString());
        var action = Shadows.shadowOf(n.actions[2].actionIntent);
        assertTrue(action.isActivityIntent());
        assertTrue(n.actions[2].actionIntent.isImmutable());
        Intent target = action.getSavedIntent();
        assertEquals(MainActivity.class.getName(), target.getComponent().getClassName());
        assertEquals(e.path, target.getStringExtra("path"));
        assertEquals(AlarmNote.ACTION, target.getAction());
        assertTrue((target.getFlags() & Intent.FLAG_ACTIVITY_NEW_TASK) != 0);
    }
    @Test public void openStopsOnlyThisAlarmAndDoesNotAnswerOrReleaseATask() {
        Alarms.Entry first = entry(1234, "reminders/beeper/first.md"), second = entry(1235, "other.md");
        Alarms.fire(context, first); Alarms.fire(context, second);
        AlarmNote.accept(context, AlarmNote.intent(context, first));
        var notifications = Shadows.shadowOf(context.getSystemService(NotificationManager.class));
        assertNull(notifications.getNotification("notes-alarm", first.id));
        assertNotNull(notifications.getNotification("notes-alarm", second.id));
        assertEquals(0, Alarms.take(context).length());
        assertEquals(first.path, AlarmNote.pending(context).optString("path"));
        assertFalse(AlarmNote.pending(context).optString("id").isEmpty());
    }
    @Test public void coldActivityAndWarmIntentBothPersistTheActualNote() {
        Intent cold = AlarmNote.intent(context, entry(1234, "first.md"));
        var activity = Robolectric.buildActivity(WithoutWebEngine.class, cold).setup();
        try {
            assertEquals("first.md", AlarmNote.pending(context).optString("path"));
            String id = AlarmNote.pending(context).optString("id");
            AlarmNote.acknowledge(context, id);
            AlarmNote.accept(context, cold); // The consumed creation intent cannot resurrect it.
            assertEquals(0, AlarmNote.pending(context).length());
            activity.newIntent(AlarmNote.intent(context, entry(1235, "next.md")));
            assertEquals("next.md", AlarmNote.pending(context).optString("path"));
        } finally { activity.pause().stop().destroy(); }
    }
    @Test public void oldAcknowledgmentCannotDiscardANewerTap() {
        AlarmNote.accept(context, AlarmNote.intent(context, entry(1234, "first.md")));
        String id = AlarmNote.pending(context).optString("id");
        AlarmNote.accept(context, AlarmNote.intent(context, entry(1235, "second.md")));
        AlarmNote.acknowledge(context, id);
        assertEquals("second.md", AlarmNote.pending(context).optString("path"));
        AlarmNote.acknowledge(context, AlarmNote.pending(context).optString("id"));
        assertEquals(0, AlarmNote.pending(context).length());
    }
    @Test public void refusesExternalOrMalformedPathsAndNormalLaunchDoesNotConsumePending() {
        for (String path : new String[] {"../secret.md", "/first.md", "a//b.md", "https://example.md", "a\\b.md", "a\n.md", "file.png"}) {
            AlarmNote.accept(context, AlarmNote.intent(context, entry(1234, path)));
            assertEquals(path, 0, AlarmNote.pending(context).length());
        }
        AlarmNote.accept(context, AlarmNote.intent(context, entry(1234, "a note/こんにちは.md")));
        AlarmNote.accept(context, new Intent(Intent.ACTION_MAIN));
        assertEquals("a note/こんにちは.md", AlarmNote.pending(context).optString("path"));
    }
    private Button button(View v, String label) {
        if (v instanceof Button && label.contentEquals(((Button) v).getText())) return (Button) v;
        if (v instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) v).getChildCount(); i++) {
            Button found = button(((ViewGroup) v).getChildAt(i), label); if (found != null) return found;
        }
        return null;
    }
    @Test public void fullScreenButtonStartsTheSameNoteWithoutDoneOrSnooze() {
        Alarms.Entry e = entry(1234, "reminders/gmail/test.md");
        var activity = Robolectric.buildActivity(AlarmActivity.class, e.into(new Intent(context, AlarmActivity.class))).setup();
        try {
            Button open = button(activity.get().findViewById(android.R.id.content), "Open note");
            assertNotNull(open); open.performClick();
            Intent launched = Shadows.shadowOf(activity.get()).getNextStartedActivity();
            assertEquals(e.path, launched.getStringExtra("path"));
            assertEquals(AlarmNote.ACTION, launched.getAction());
            assertEquals(0, Alarms.take(context).length());
        } finally { activity.pause().stop().destroy(); }
    }
}
