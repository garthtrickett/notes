package com.garthtrickett.notes;

import static org.junit.Assert.*;
import android.app.AlarmManager;
import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36)
public class TaskLinksTest {
    private Context context;
    private final long stamp = 1_800_000_000_000L;
    private JSONObject source() throws Exception {
        return new JSONObject().put("id", "japanese").put("title", "Japanese").put("path", "a.md")
            .put("stamp", stamp).put("repeat", true).put("done", false);
    }
    private JSONObject child() throws Exception {
        return new JSONObject().put("id", "today").put("after", "japanese").put("title", "Today review")
            .put("path", "b.md").put("ready", false).put("alarm", true).put("done", false).put("stamp", 0);
    }
    private Alarms.Entry parent() { return new Alarms.Entry(AlarmLines.id("a.md", "Japanese"), stamp, "Japanese", "a.md", stamp, true); }
    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("notes.alarms", Context.MODE_PRIVATE).edit().clear().commit();
    }
    @Test public void doneWhileAppClosedSchedulesOneAlarmAndQueuesOrderedReplay() throws Exception {
        Alarms.links(context, new JSONArray().put(source()).put(child()));
        Alarms.answer(context, parent(), "done", stamp + 15_000);
        JSONArray held = new JSONArray(context.getSharedPreferences("notes.alarms", 0).getString("alarms", "[]"));
        assertEquals(1, held.length());
        assertEquals("Today review", held.getJSONObject(0).getString("title"));
        assertEquals((stamp / 60_000 + 1) * 60_000, held.getJSONObject(0).getLong("at"));
        assertEquals(1, Shadows.shadowOf(context.getSystemService(AlarmManager.class)).getScheduledAlarms().size());
        Alarms.answer(context, parent(), "done", stamp + 20_000);
        JSONArray answers = Alarms.take(context);
        assertEquals(3, answers.length()); // done, activation, duplicate done — no duplicate activation
        assertEquals("done", answers.getJSONObject(0).getString("kind"));
        assertEquals("activate", answers.getJSONObject(1).getString("kind"));
        assertEquals("at:" + stamp, answers.getJSONObject(1).getString("token"));
        assertEquals(3, Alarms.take(context).length()); // Reading before persistence never consumes.
        JSONArray receipts = new JSONArray();
        for (int i = 0; i < answers.length(); i++) receipts.put(answers.getJSONObject(i).getString("receipt"));
        Alarms.acknowledge(context, receipts);
        assertEquals(0, Alarms.take(context).length());
    }
    @Test public void snoozeDoesNotReleaseAndTaskEditsInvalidateOldPresses() throws Exception {
        JSONArray graph = new JSONArray().put(source()).put(child());
        Alarms.links(context, graph);
        Alarms.answer(context, parent(), "snooze", stamp);
        assertEquals(1, Alarms.take(context).length());
        assertEquals(0, TaskLinks.complete(graph, parent().id, "a.md", "Changed", stamp, stamp).releases.length());
        assertEquals(0, TaskLinks.complete(graph, parent().id, "a.md", "Japanese", stamp + 60_000, stamp).releases.length());
    }
    @Test public void childDoneCanReleaseTheNextStepWithoutWebView() throws Exception {
        JSONObject next = child().put("id", "next").put("after", "today").put("title", "Breakfast").put("path", "c.md");
        Alarms.links(context, new JSONArray().put(source()).put(child()).put(next));
        Alarms.answer(context, parent(), "done", stamp);
        long at = (stamp / 60_000 + 1) * 60_000;
        Alarms.Entry today = new Alarms.Entry(AlarmLines.id("b.md", "Today review"), at, "Today review", "b.md", at, false);
        Alarms.answer(context, today, "done", at + 5_000);
        JSONArray answers = Alarms.take(context);
        assertEquals(4, answers.length());
        assertEquals("Breakfast", answers.getJSONObject(3).getString("title"));
        assertEquals("at:" + stamp, answers.getJSONObject(3).getString("token"));
    }
    @Test public void quietFollowUpQueuesActivationWithoutAlarmAndCyclesStayBlocked() throws Exception {
        JSONArray graph = new JSONArray().put(source()).put(child().put("alarm", false));
        Alarms.links(context, graph);
        Alarms.answer(context, parent(), "done", stamp);
        assertEquals(2, Alarms.take(context).length());
        assertEquals(0, Shadows.shadowOf(context.getSystemService(AlarmManager.class)).getScheduledAlarms().size());
        JSONArray cycle = new JSONArray().put(source().put("after", "today").put("ready", true).put("seen", "once")).put(child());
        assertEquals(0, TaskLinks.complete(cycle, parent().id, "a.md", "Japanese", stamp, stamp).releases.length());
    }
    @Test public void unfinishedFollowupDoesNotStackAndDuplicateIdsAreBlocked() throws Exception {
        JSONArray graph = new JSONArray().put(source()).put(child().put("ready", true));
        assertEquals(0, TaskLinks.complete(graph, parent().id, "a.md", "Japanese", stamp, stamp).releases.length());
        graph = new JSONArray().put(source()).put(child()).put(child().put("path", "copy.md"));
        assertEquals(0, TaskLinks.complete(graph, parent().id, "a.md", "Japanese", stamp, stamp).releases.length());
    }
    @Test public void remoteChangeRemovesCachedLinksUntilForegroundRefresh() throws Exception {
        Alarms.links(context, new JSONArray().put(source()).put(child()));
        java.util.Map<String, java.util.List<Alarms.Entry>> changed = new java.util.LinkedHashMap<>();
        changed.put("b.md", new java.util.ArrayList<>());
        Alarms.replacePaths(context, changed, java.util.Collections.emptySet(), stamp);
        Alarms.answer(context, parent(), "done", stamp);
        assertEquals(1, Alarms.take(context).length());
    }

    @Test public void corruptOptionalGraphDoesNotLoseTheDonePress() throws Exception {
        Alarms.links(context, new JSONArray().put("not a task"));
        Alarms.answer(context, parent(), "done", stamp);
        JSONArray answers = Alarms.take(context);
        assertEquals(1, answers.length());
        assertEquals("done", answers.getJSONObject(0).getString("kind"));
    }

    @Test public void backgroundPollCannotCancelAnUnreconciledActivation() throws Exception {
        Alarms.links(context, new JSONArray().put(source()).put(child()));
        Alarms.answer(context, parent(), "done", stamp);
        java.util.Map<String, java.util.List<Alarms.Entry>> stale = new java.util.LinkedHashMap<>();
        stale.put("b.md", java.util.Collections.emptyList());
        Alarms.replacePaths(context, stale, java.util.Collections.emptySet(), stamp);
        JSONArray held = new JSONArray(context.getSharedPreferences("notes.alarms", 0).getString("alarms", "[]"));
        assertEquals(1, held.length());
        assertEquals("Today review", held.getJSONObject(0).getString("title"));
    }

    @Test public void acknowledgementKeepsNewerPressesAndAdoptsTheFreshSnapshotLast() throws Exception {
        Alarms.links(context, new JSONArray().put(source()).put(child()));
        Alarms.answer(context, parent(), "done", stamp);
        JSONArray first = Alarms.take(context), ids = new JSONArray();
        for (int i = 0; i < first.length(); i++) ids.put(first.getJSONObject(i).getString("receipt"));
        long tomorrow = stamp + 86_400_000L;
        Alarms.links(context, new JSONArray().put(source().put("stamp", tomorrow))
            .put(child().put("ready", true).put("done", true).put("seen", "at:" + stamp)));
        Alarms.answer(context, new Alarms.Entry(5, stamp, "Other task", "other.md", stamp, false), "done", stamp);
        Alarms.acknowledge(context, ids);
        JSONArray last = Alarms.take(context);
        assertEquals(1, last.length());
        Alarms.acknowledge(context, new JSONArray().put(last.getJSONObject(0).getString("receipt")));
        Alarms.answer(context, new Alarms.Entry(parent().id, tomorrow, "Japanese", "a.md", tomorrow, true), "done", tomorrow);
        assertEquals(2, Alarms.take(context).length());
    }
}
