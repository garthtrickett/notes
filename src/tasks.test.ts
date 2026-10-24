// The scanner agrees with the renderer by construction: both read lezer
// Task nodes from the same parser. These pin the contract — what counts,
// where the flip lands, and how the vault groups.

import { describe, expect, it, test } from "bun:test";
import { spansFor } from "./decorate.ts";
import { createTaskCache, flipTask, rollRepeats, tasksIn, tasksInVault, setReminder, type TaskRef } from "./tasks.ts";
import { alarmsLive, alarmsWanted, alarmWarning, knownShas, armableReminders, reminderSetKey, dueReminders, notifiedReminders, reminderId, syncAlarms, syncTaskReminders, syncWebReminders } from "./notify.ts";
import { SLOTS } from "./checkins.ts";
import type { Note } from "./model.ts";

const note = (body: string, extra: Partial<Note> = {}): Note => ({
  path: "",
  body,
  baseSha: null,
  pending: false,
  deleted: false,
  dirty: false,
  encoding: "utf8",
  ...extra,
});

describe("tasksIn", () => {
  test("finds open and done boxes with titles", () => {
    const refs = tasksIn("- [ ] milk\n- [x] bread\n", "a.md");
    expect(refs.length).toBe(2);
    expect(refs[0]).toMatchObject({
      path: "a.md",
      done: false,
      title: "milk",
    });
    expect(refs[1]).toMatchObject({ done: true, title: "bread" });
  });

  test("reads every marker flavor the renderer styles", () => {
    const refs = tasksIn("- [ ] open\n- [x] shut\n- [X] loud\n", "a.md");
    expect(refs.map((r) => r.done)).toEqual([false, true, true]);
  });

  test("takes star, plus and numbered markers too", () => {
    const refs = tasksIn("* [ ] s\n+ [ ] p\n1. [ ] n\n", "a.md");
    expect(refs.map((r) => r.title)).toEqual(["s", "p", "n"]);
  });

  test("keeps nested boxes separate", () => {
    const refs = tasksIn("- [ ] outer\n  - [ ] inner\n", "a.md");
    expect(refs.map((r) => r.title)).toEqual(["outer", "inner"]);
  });

  test("shows only the first line of a long item", () => {
    const refs = tasksIn("- [ ] first\n  continued\n", "a.md");
    expect(refs[0]?.title).toBe("first");
  });

  test("ignores code blocks, inline boxes and unicode boxes", () => {
    const refs = tasksIn("```\n- [ ] code\n```\n\ntalk about [ ] brackets\n\n- ☐ fancy\n", "a.md");
    expect(refs).toEqual([]);
  });

  test("an empty note has no tasks", () => {
    expect(tasksIn("", "a.md")).toEqual([]);
  });

  test("every task paints and every painted box is a task", () => {
    const body =
      "- [ ] open\n- [x] shut\n\n```\n- [ ] code\n```\n\n- ☐ fancy\n- [ ] two\n";
    const refs = tasksIn(body, "a.md");
    const spans = spansFor(body, () => null);
    const painted = spans.filter(
      (s) =>
        s.kind === "mark" &&
        (s.class === "cm-md-task-open" || s.class === "cm-md-task-done"),
    );
    // One painted mark per box, each sitting on a ref's flip character.
    expect(painted.length).toBe(refs.length);
    for (const ref of refs) {
      expect(
        painted.some((s) => s.kind === "mark" && s.from <= ref.marker && ref.marker < s.to),
      ).toBe(true);
    }
  });
});

describe("flipTask", () => {
  test("flips one character and nothing else", () => {
    const body = "- [ ] milk\n- [x] bread\n";
    const ref = tasksIn(body, "a.md")[0];
    if (ref === undefined) throw new Error("no task");
    expect(flipTask(body, ref)).toBe("- [x] milk\n- [x] bread\n");
  });

  test("any done flavor reopens to a space", () => {
    const body = "- [X] loud\n";
    const ref = tasksIn(body, "a.md")[0];
    if (ref === undefined) throw new Error("no task");
    expect(flipTask(body, ref)).toBe("- [ ] loud\n");
  });

  test("a stale ref after an unpainted edit refuses instead of corrupting", () => {
    const body = "- [ ] milk\n";
    const ref = tasksIn(body, "a.md")[0];
    if (ref === undefined) throw new Error("no task");
    // The box moved under the ref: flipping blind would eat the "k".
    expect(flipTask("-[ ] milk\n", ref)).toBe("-[ ] milk\n");
  });
});

describe("tasksInVault", () => {
  test("groups by note, sorted, skipping notes without boxes", () => {
    const notes = new Map<string, Note>([
      ["b.md", note("- [x] done\n")],
      ["a.md", note("- [ ] one\n- [ ] two\n")],
      ["dump/2026-09-06.md", note("- [ ] milk\n")],
      ["empty.md", note("plain text\n")],
    ]);
    const groups = tasksInVault(notes, createTaskCache());
    expect(groups.map((g) => g.path)).toEqual([
      "a.md",
      "dump/2026-09-06.md",
      "b.md",
    ]);
    expect(groups[0]?.refs.map((r) => r.title)).toEqual(["one", "two"]);
    // Dump days are ordinary files: the flip lands in the stored body.
    const milk = groups[1]?.refs[0];
    if (milk === undefined) throw new Error("no task");
    expect(flipTask("- [ ] milk\n", milk)).toBe("- [x] milk\n");
  });

  test("done-only notes sink below notes with open work", () => {
    const notes = new Map<string, Note>([
      ["dev/old.md", note("- [x] ancient\n")],
      ["a.md", note("- [ ] live\n")],
    ]);
    const groups = tasksInVault(notes, createTaskCache());
    expect(groups.map((g) => g.path)).toEqual(["a.md", "dev/old.md"]);
  });

  test("trash, archive and tombstones are not triage", () => {
    const notes = new Map<string, Note>([
      [".trash/gone.md", note("- [ ] buried\n")],
      [".archive/old.md", note("- [ ] filed\n")],
      ["gone.md", note("- [ ] doomed\n", { deleted: true })],
      ["a.md", note("- [ ] live\n")],
    ]);
    const groups = tasksInVault(notes, createTaskCache());
    expect(groups.map((g) => g.path)).toEqual(["a.md"]);
  });
});

describe("createTaskCache", () => {
  test("reparses only when the body changes", () => {
    const cache = createTaskCache();
    const first = cache.forNote("a.md", "- [ ] one\n");
    expect(cache.forNote("a.md", "- [ ] one\n")).toBe(first);
    expect(cache.forNote("a.md", "- [ ] one\n- [ ] two\n").length).toBe(2);
  });
});

describe("reminders on a task line", () => {
  const at = (s: string): number => new Date(s).getTime();

  it("is read off the line with the rest of the task", () => {
    const [ref] = tasksIn("- [ ] call the bank @2026-09-11 14:30\n", "a.md");
    expect(ref?.title).toBe("call the bank");
    expect(ref?.remindAt).toBe(at("2026-09-11T14:30:00"));
    expect(ref?.done).toBe(false);
  });

  it("is null on an ordinary task", () => {
    const [ref] = tasksIn("- [ ] call the bank\n", "a.md");
    expect(ref?.remindAt).toBeNull();
  });

  it("writes one onto the right line and leaves the others alone", () => {
    const body = "- [ ] one\n- [ ] two\n- [ ] three\n";
    const refs = tasksIn(body, "a.md");
    const next = setReminder(body, refs[1] as TaskRef, at("2026-09-11T09:00:00"));
    expect(next).toBe("- [ ] one\n- [ ] two @2026-09-11\n- [ ] three\n");
  });

  it("moves a reminder rather than adding a second", () => {
    const body = "- [ ] two @2026-09-11\n";
    const refs = tasksIn(body, "a.md");
    const next = setReminder(body, refs[0] as TaskRef, at("2026-09-12T18:00:00"));
    expect(next).toBe("- [ ] two @2026-09-12 18:00\n");
  });

  it("clears one with null", () => {
    const body = "- [ ] two @2026-09-11\n";
    const refs = tasksIn(body, "a.md");
    expect(setReminder(body, refs[0] as TaskRef, null)).toBe("- [ ] two\n");
  });

  it("refuses a ref that no longer describes the line", () => {
    // Same bargain as flipTask: offsets die on the next keystroke, and writing
    // through a stale one would overwrite whatever is at them now.
    const body = "- [ ] two @2026-09-11\n";
    const refs = tasksIn(body, "a.md");
    const moved = "- [ ] something else entirely\n";
    expect(setReminder(moved, refs[0] as TaskRef, at("2026-09-12T09:00:00"))).toBe(moved);
  });

  it("survives a round trip through the scanner", () => {
    const body = "- [ ] two\n";
    const refs = tasksIn(body, "a.md");
    const next = setReminder(body, refs[0] as TaskRef, at("2026-09-11T14:30:00"));
    const [again] = tasksIn(next, "a.md");
    expect(again?.title).toBe("two");
    expect(again?.remindAt).toBe(at("2026-09-11T14:30:00"));
  });
});

describe("which reminders the OS should hold", () => {
  const now = new Date("2026-09-10T12:00:00").getTime();
  const ref = (over: Partial<TaskRef>): TaskRef => ({
    path: "a.md", from: 0, marker: 3, done: false, title: "t",
    remindAt: null, alarm: false, repeat: null, titleFrom: 5, titleTo: 6, ...over,
  });

  it("keeps open tasks with a future time", () => {
    const refs = [ref({ remindAt: now + 60_000 })];
    expect(dueReminders(refs, now).length).toBe(1);
  });

  it("drops a task that is already done", () => {
    // Otherwise ticking something off leaves its alarm standing.
    expect(dueReminders([ref({ done: true, remindAt: now + 60_000 })], now).length).toBe(0);
  });

  it("drops a time that has already passed", () => {
    // Capacitor delivers a past `at` immediately, so scheduling one means an
    // alarm for yesterday every single time the app opens.
    expect(dueReminders([ref({ remindAt: now - 60_000 })], now).length).toBe(0);
  });

  it("drops a task with no time at all", () => {
    expect(dueReminders([ref({})], now).length).toBe(0);
  });
});

describe("reminder ids", () => {
  it("are stable for the same task", () => {
    const a = reminderId({ path: "a.md", title: "call the bank" });
    expect(reminderId({ path: "a.md", title: "call the bank" })).toBe(a);
  });

  it("clears the check-ins' range even when the hash lands inside it", () => {
    // Check-ins own ids 1..3, and cancelling one of those would silently stop
    // a daily nudge. Only about one task in two million hashes below the
    // floor, so sampling proves nothing — this is a witness found by brute
    // force whose raw hash is 181, which is exactly the case the floor exists
    // for.
    const id = reminderId({ path: "a.md", title: "t1404735" });
    expect(id).toBeGreaterThan(SLOTS.length);
    expect(id).toBeGreaterThanOrEqual(1000);
  });

  it("differ by file and by text", () => {
    expect(reminderId({ path: "a.md", title: "x" })).not.toBe(
      reminderId({ path: "b.md", title: "x" }),
    );
    expect(reminderId({ path: "a.md", title: "x" })).not.toBe(
      reminderId({ path: "a.md", title: "y" }),
    );
  });
});

describe("delivering the set to the OS", () => {
  it("reports that it delivered nothing where it cannot", async () => {
    // The caller caches the set it last handed over. Off a native shell there
    // is nothing to hand it to, and saying otherwise would cache a set the OS
    // never received — which is also what an early call, before the permission
    // answer lands, would do.
    expect(await syncTaskReminders([], Date.now())).toBe(false);
  });
});

describe("arming a timer in the page", () => {
  const now = new Date("2026-09-10T12:00:00").getTime();
  const ref = (over: Partial<TaskRef>): TaskRef => ({
    path: "a.md", from: 0, marker: 3, done: false, title: "t",
    remindAt: null, alarm: false, repeat: null, titleFrom: 5, titleTo: 6, ...over,
  });

  it("arms one inside setTimeout's range", () => {
    expect(armableReminders([ref({ remindAt: now + 86_400_000 })], now).length).toBe(1);
  });

  it("leaves a far-off one unarmed rather than firing it now", () => {
    // setTimeout takes a signed 32-bit delay — about 24.8 days — and a larger
    // one does not fire late, it fires immediately. A reminder for next year
    // would go off the moment the tab opened.
    const year = now + 365 * 86_400_000;
    expect(dueReminders([ref({ remindAt: year })], now).length).toBe(1);
    expect(armableReminders([ref({ remindAt: year })], now).length).toBe(0);
  });

  it("declines while the permission answer is still outstanding", () => {
    // Permission is asked for on the gesture that sets a reminder, so the
    // calls before the answer lands must say undelivered. Recording the set on
    // one of those leaves every reminder unarmed for the rest of the session.
    const slot = globalThis as { Notification?: unknown };
    const original = slot.Notification;
    slot.Notification = Object.assign(function stub() {}, { permission: "default" });
    try {
      expect(syncWebReminders([ref({ remindAt: now + 1000 })], now)).toBe(false);
    } finally {
      slot.Notification = original;
    }
  });

  it("declines to record a delivery it cannot make", () => {
    // No Notification in this environment, which is the same answer as
    // permission not granted yet: say undelivered so the caller asks again.
    expect(syncWebReminders([ref({ remindAt: now + 1000 })], now)).toBe(false);
  });
});

describe("which alarms the phone is given", () => {
  const now = new Date("2026-09-23T12:00:00").getTime();
  const hour = 60 * 60 * 1000;
  const ref = (over: Partial<TaskRef>): TaskRef => ({
    path: "a.md", from: 0, marker: 3, done: false, title: "t",
    remindAt: null, alarm: true, repeat: null, titleFrom: 5, titleTo: 6, ...over,
  });

  it("takes a flagged reminder in the next 24 hours", () => {
    expect(alarmsWanted([ref({ remindAt: now + 17 * hour })], now).length).toBe(1);
  });

  it("takes one days away, which the clock version could not", () => {
    // ACTION_SET_ALARM had no date extra, so the old rule refused anything past
    // 24 hours. setAlarmClock takes an instant, and the limit went with it.
    expect(alarmsWanted([ref({ remindAt: now + 25 * hour })], now).length).toBe(1);
    expect(alarmsWanted([ref({ remindAt: now + 30 * 24 * hour })], now).length).toBe(1);
  });

  it("refuses one whose time has passed", () => {
    expect(alarmsWanted([ref({ remindAt: now - hour })], now).length).toBe(0);
    expect(alarmsWanted([ref({ remindAt: now })], now).length).toBe(0);
  });

  it("refuses a reminder that did not ask for an alarm", () => {
    expect(alarmsWanted([ref({ alarm: false, remindAt: now + hour })], now).length).toBe(0);
  });

  it("refuses a task already ticked off", () => {
    expect(alarmsWanted([ref({ done: true, remindAt: now + hour })], now).length).toBe(0);
  });

  it("refuses a flag with no time", () => {
    expect(alarmsWanted([ref({ remindAt: null })], now).length).toBe(0);
  });

  it("hands over what the alarm screen and its answer need", () => {
    // The title and stamp are how the answer finds the line again; the id is
    // what makes setting it twice replace rather than duplicate.
    const r = ref({ path: "dump/2026-09-24.md", title: "surf", remindAt: now + hour });
    expect(alarmsWanted([r], now)).toEqual([
      { id: reminderId(r), at: now + hour, title: "surf", path: "dump/2026-09-24.md", repeat: false },
    ]);
  });

  it("schedules nothing where there is no phone, and says so cleanly", async () => {
    expect(await syncAlarms([ref({ remindAt: now + hour })], now))
      .toEqual({ scheduled: 0, error: null });
  });
});

describe("leaving alarms to the alarm", () => {
  const now = new Date("2026-09-23T12:00:00").getTime();
  const ref = (over: Partial<TaskRef>): TaskRef => ({
    path: "a.md", from: 0, marker: 3, done: false, title: "t",
    remindAt: now + 60_000, alarm: false, repeat: null, titleFrom: 5, titleTo: 6, ...over,
  });

  it("does not also send a plain notification for a flagged task", () => {
    // The alarm posts its own ringing notification at that minute; a second,
    // plain one is a double buzz without the Done and Snooze buttons.
    expect(notifiedReminders([ref({ alarm: true })], now).length).toBe(0);
  });

  it("still notifies an unflagged one", () => {
    expect(notifiedReminders([ref({})], now).length).toBe(1);
  });

  it("is still a due reminder, which is what the web arms", () => {
    expect(dueReminders([ref({ alarm: true })], now).length).toBe(1);
  });
});

describe("saying what stops an alarm ringing properly", () => {
  const all = { exact: true, fullScreen: true, notifications: true };

  it("says nothing when every setting is on", () => {
    expect(alarmWarning(all)).toBeNull();
  });

  it("names each setting that is off", () => {
    expect(alarmWarning({ ...all, notifications: false })).toContain("Notifications");
    expect(alarmWarning({ ...all, exact: false })).toContain("Alarms & reminders");
    expect(alarmWarning({ ...all, fullScreen: false })).toContain("full-screen");
  });

  it("names the worst first, since only one fits", () => {
    // Without notifications nothing rings at all, which makes the other two
    // moot until it is fixed.
    expect(alarmWarning({ exact: false, fullScreen: false, notifications: false }))
      .toContain("cannot ring");
    expect(alarmWarning({ ...all, exact: false, fullScreen: false }))
      .toContain("ring late");
  });
});

describe("noticing that the reminder set changed", () => {
  const ref = (over: Partial<TaskRef>): TaskRef => ({
    path: "a.md", from: 0, marker: 3, done: false, title: "surf",
    remindAt: 1_000_000, alarm: false, repeat: null, titleFrom: 5, titleTo: 6, ...over,
  });

  it("changes when a ! is added to a reminder that already exists", () => {
    // The bug: typing sets the time first and the ! last. The set was recorded
    // as soon as the time parsed, and adding the ! gave the same key, so it
    // was skipped. Alarms only appeared after reopening the app.
    expect(reminderSetKey([ref({ alarm: true })]))
      .not.toBe(reminderSetKey([ref({ alarm: false })]));
  });

  it("changes when a ! is taken off again", () => {
    expect(reminderSetKey([ref({ alarm: false })]))
      .not.toBe(reminderSetKey([ref({ alarm: true })]));
  });

  it("still changes when the time moves", () => {
    expect(reminderSetKey([ref({ remindAt: 2_000_000 })]))
      .not.toBe(reminderSetKey([ref({ remindAt: 1_000_000 })]));
  });

  it("does not change for things that schedule nothing", () => {
    // Ticked and unreminded tasks are out of the set entirely, so toggling
    // their alarm flag must not trigger a resync.
    const base = reminderSetKey([ref({})]);
    expect(reminderSetKey([ref({}), ref({ path: "b.md", done: true, alarm: true })])).toBe(base);
    expect(reminderSetKey([ref({}), ref({ path: "c.md", remindAt: null, alarm: true })])).toBe(base);
  });

  it("does not depend on the order the vault happens to list them in", () => {
    const a = ref({ path: "a.md" });
    const b = ref({ path: "b.md" });
    expect(reminderSetKey([a, b])).toBe(reminderSetKey([b, a]));
  });
});

describe("a repeating task, once ticked", () => {
  const now = new Date("2026-10-06T06:00").getTime();
  const tomorrow = new Date("2026-10-07T00:00").getTime();
  it("stays checked today through repeated passes and a cold parse", () => {
    const body = "- [x] surf @2026-10-06 05:30! every day\n";
    const saved = rollRepeats(body, "d.md", now);
    expect(tasksIn(saved, "d.md")[0]).toMatchObject({ done: true, title: "surf", remindAt: now - 30*60_000,
      nextRepeatAt: new Date("2026-10-07T05:30").getTime(), repeat: "day", alarm: true });
    expect(rollRepeats(saved, "d.md", now + 12*3600_000)).toBe(saved);
    expect(rollRepeats(saved, "d.md", tomorrow - 1)).toBe(saved);
  });
  it("reopens at midnight of the next scheduled day and keeps its alarm time", () => {
    const saved = rollRepeats("- [x] surf @2026-10-06 05:30! every day\n", "d.md", now);
    expect(rollRepeats(saved, "d.md", tomorrow)).toBe("- [ ] surf @2026-10-07 05:30! every day\n");
  });
  it("overdue completion counts for today even before today's usual alarm time", () => {
    const saved = rollRepeats("- [x] check messages @2026-10-01 16:30! every day\n", "d.md", now);
    expect(tasksIn(saved,"d.md")[0]?.nextRepeatAt).toBe(new Date("2026-10-07T16:30").getTime());
  });
  it("keeps a weekly task checked until next week's scheduled day", () => {
    const saved = rollRepeats("- [x] bins @2026-10-06 every week\n", "d.md", now);
    expect(rollRepeats(saved, "d.md", tomorrow)).toBe(saved);
    expect(rollRepeats(saved, "d.md", new Date("2026-10-13T00:00").getTime())).toBe("- [ ] bins @2026-10-13 every week\n");
  });
  it("keeps one reserved overdue occurrence so a queued native answer still matches", () => {
    const saved = rollRepeats("- [x] surf @2026-10-06 05:30! every day\n", "d.md", now);
    expect(rollRepeats(saved, "d.md", new Date("2026-10-11T20:00").getTime())).toBe("- [ ] surf @2026-10-07 05:30! every day\n");
  });
  it("clears the completion on an explicit undo, allowing a new tick", () => {
    const saved = rollRepeats("- [x] surf @2026-10-06 05:30! every day\n", "d.md", now);
    const undone = flipTask(saved,tasksIn(saved,"d.md")[0]!);
    expect(rollRepeats(undone,"d.md",now)).toBe("- [ ] surf @2026-10-06 05:30! every day\n");
  });
  it("preserves neighbouring prose, indentation, other tasks and invalid rules", () => {
    const body = "# day\n  - [x] surf @2026-10-06 05:30! every day\n- [ ] read\n- [x] bins @2026-10-06 every week\n- [x] invalid @2026-10-06 every 0 days\nmore\n";
    const saved = rollRepeats(body,"d.md",now), refs=tasksIn(saved,"d.md");
    expect(refs.map(r=>r.done)).toEqual([true,false,true,true]);
    expect(refs.map(r=>r.title)).toEqual(["surf","read","bins","invalid"]);
    expect(saved.startsWith("# day\n  - [x]")).toBe(true);expect(saved.endsWith("more\n")).toBe(true);
    const reopened=rollRepeats(saved,"d.md",tomorrow);
    expect(tasksIn(reopened,"d.md").map(r=>r.done)).toEqual([false,false,true,true]);
  });
  it("leaves open tasks and completed one-offs alone", () => {
    for(const body of ["- [ ] surf @2026-10-06 05:30! every day\n","- [x] surf @2026-10-06 05:30!\n"])
      expect(rollRepeats(body,"d.md",now)).toBe(body);
  });
});

describe("what the phone needs to keep a repeating snooze", () => {
  const ref = (over: Partial<TaskRef>): TaskRef => ({
    path: "a.md", from: 0, marker: 3, done: false, title: "t",
    remindAt: 1_000, alarm: true, repeat: null, titleFrom: 5, titleTo: 6, ...over,
  });

  it("lists every open flagged task's stamp, past ones too", () => {
    // The stamp a snooze rang for is always past; it is exactly the one needed.
    const r = ref({ remindAt: 1_000 });
    expect(alarmsLive([r])).toEqual([{ id: reminderId(r), stamp: 1_000 }]);
  });

  it("leaves out ticked, unflagged and untimed ones", () => {
    expect(alarmsLive([ref({ done: true }), ref({ alarm: false }), ref({ remindAt: null })])).toEqual([]);
  });

  it("marks a repeating task's alarm as repeating", () => {
    const now = 0;
    expect(alarmsWanted([ref({ repeat: "day" })], now)[0]?.repeat).toBe(true);
    expect(alarmsWanted([ref({})], now)[0]?.repeat).toBe(false);
  });

  it("notices a repeat being added", () => {
    expect(reminderSetKey([ref({ repeat: "day" })])).not.toBe(reminderSetKey([ref({})]));
  });
});

describe("what the background job may treat as already read", () => {
  const rec = (path: string, over: Partial<{ baseSha: string | null; deleted: boolean; encoding: "utf8" | "base64" }> = {}) =>
    ({ path, baseSha: "s-" + path, deleted: false, encoding: "utf8" as const, ...over });

  it("maps each synced text note to the blob it was synced with", () => {
    // If this came back empty the job's first run would fetch all ~400 notes.
    expect(knownShas([rec("a.md"), rec("dump/2026-10-05.md")]))
      .toEqual({ "a.md": "s-a.md", "dump/2026-10-05.md": "s-dump/2026-10-05.md" });
  });

  it("leaves out what the job should still read or never read", () => {
    expect(knownShas([
      rec("never-pushed.md", { baseSha: null }),
      rec("gone.md", { deleted: true }),
      rec("attachments/a.webp", { encoding: "base64" }),
      rec("notes.txt"),
    ])).toEqual({});
  });
});
