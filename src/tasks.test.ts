// The scanner agrees with the renderer by construction: both read lezer
// Task nodes from the same parser. These pin the contract — what counts,
// where the flip lands, and how the vault groups.

import { describe, expect, it, test } from "bun:test";
import { spansFor } from "./decorate.ts";
import { createTaskCache, flipTask, tasksIn, tasksInVault, setReminder, type TaskRef } from "./tasks.ts";
import { dueReminders, reminderId, syncTaskReminders } from "./notify.ts";
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
    remindAt: null, titleFrom: 5, titleTo: 6, ...over,
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
