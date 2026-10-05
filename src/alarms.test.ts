import { describe, expect, it } from "bun:test";
import { applyAnswers, parseAnswers, type AlarmAnswer } from "./alarms.ts";
import { reminderIn } from "./reminders.ts";

const at = (stamp: string): number => new Date(stamp).getTime();

describe("reading what the alarm screen wrote down", () => {
  it("keeps a well-formed done and snooze", () => {
    expect(parseAnswers([
      { kind: "done", path: "a.md", title: "surf", at: 1 },
      { kind: "snooze", path: "a.md", title: "surf", at: 1, snoozeTo: 2 },
    ])).toEqual([
      { kind: "done", path: "a.md", title: "surf", at: 1, snoozeTo: null },
      { kind: "snooze", path: "a.md", title: "surf", at: 1, snoozeTo: 2 },
    ]);
  });

  it("drops anything malformed rather than guessing", () => {
    expect(parseAnswers([
      null,
      "done",
      { kind: "dismiss", path: "a.md", title: "t", at: 1 },
      { kind: "done", title: "t", at: 1 },
      { kind: "done", path: "a.md", at: 1 },
      { kind: "done", path: "a.md", title: "t", at: "1" },
      { kind: "done", path: "a.md", title: "t", at: Number.NaN },
      // A snooze that does not say where to is not an edit anyone can make.
      { kind: "snooze", path: "a.md", title: "t", at: 1 },
      { kind: "snooze", path: "a.md", title: "t", at: 1, snoozeTo: Number.POSITIVE_INFINITY },
    ])).toEqual([]);
  });

  it("reads a bridge answer that is not a list as nothing", () => {
    expect(parseAnswers(undefined)).toEqual([]);
    expect(parseAnswers({ kind: "done" })).toEqual([]);
  });
});

describe("turning an answer into an edit", () => {
  const surf = at("2026-09-24T05:30");
  const body = "# day\n\n- [ ] surf @2026-09-24 05:30!\n- [ ] buy wax @2026-09-24 05:30!\n";
  const notes = (b: string) => (path: string) => (path === "d.md" ? b : undefined);
  const answer = (over: Partial<AlarmAnswer>): AlarmAnswer => ({
    kind: "done", path: "d.md", title: "surf", at: surf, snoozeTo: null, ...over,
  });

  it("ticks the task Done was pressed for, and only that one", () => {
    expect(applyAnswers(notes(body), [answer({})]).get("d.md"))
      .toBe("# day\n\n- [x] surf @2026-09-24 05:30!\n- [ ] buy wax @2026-09-24 05:30!\n");
  });

  it("moves the stamp to where Snooze put it, keeping the alarm", () => {
    const next = applyAnswers(notes(body), [
      answer({ kind: "snooze", snoozeTo: at("2026-09-24T05:40") }),
    ]).get("d.md") as string;
    expect(next).toContain("- [ ] surf @2026-09-24 05:40!\n");
    expect(next).toContain("- [ ] buy wax @2026-09-24 05:30!\n");
  });

  it("applies answers in order, each against the last one's result", () => {
    // Snoozed twice with the app closed, then done. Each answer names the
    // stamp it rang at, which only exists once the one before has run.
    const first = at("2026-09-24T05:40");
    const second = at("2026-09-24T05:50");
    const next = applyAnswers(notes(body), [
      answer({ kind: "snooze", snoozeTo: first }),
      answer({ kind: "snooze", at: first, snoozeTo: second }),
      answer({ kind: "done", at: second }),
    ]).get("d.md") as string;
    expect(next).toContain("- [x] surf @2026-09-24 05:50!\n");
  });

  it("leaves a line alone that was retimed since the alarm was set", () => {
    // Moved to 06:00 on the laptop; the 05:30 alarm rang before this phone
    // heard. The newer edit is the more deliberate one.
    const moved = body.replace("surf @2026-09-24 05:30!", "surf @2026-09-24 06:00!");
    expect(applyAnswers(notes(moved), [answer({})]).size).toBe(0);
  });

  it("leaves a line alone that was retitled or ticked meanwhile", () => {
    const retitled = body.replace("surf @", "surf gangga @");
    expect(applyAnswers(notes(retitled), [answer({})]).size).toBe(0);
    const ticked = body.replace("- [ ] surf", "- [x] surf");
    expect(applyAnswers(notes(ticked), [answer({ kind: "snooze", snoozeTo: surf + 600_000 })]).size).toBe(0);
  });

  it("still answers a task whose ! was removed after the alarm was set", () => {
    // Title and stamp identify the line; the flag going does not make Done
    // mean a different task.
    const unflagged = body.replace("surf @2026-09-24 05:30!", "surf @2026-09-24 05:30");
    expect(applyAnswers(notes(unflagged), [answer({})]).get("d.md"))
      .toContain("- [x] surf @2026-09-24 05:30\n");
  });

  it("ignores an answer for a note that is not here", () => {
    expect(applyAnswers(notes(body), [answer({ path: "gone.md" })]).size).toBe(0);
  });

  it("writes a snoozed stamp that reads back as the same minute", () => {
    // The phone has already scheduled the snoozed alarm for snoozeTo. If the
    // stamp read back as anything else, the next sync would move it.
    const to = at("2026-09-24T05:41");
    const next = applyAnswers(notes(body), [answer({ kind: "snooze", snoozeTo: to })]).get("d.md") as string;
    const line = next.split("\n").find((l) => l.includes("surf")) as string;
    expect(reminderIn(line)).toBe(to);
  });
});

describe("answering a repeating task's alarm", () => {
  const surf = at("2026-10-06T05:30");
  const body = "- [ ] surf @2026-10-06 05:30! every day\n";
  const notes = (path: string) => (path === "d.md" ? body : undefined);

  it("leaves the stamp alone on snooze, so tomorrow stays at 05:30", () => {
    expect(applyAnswers(notes, [
      { kind: "snooze", path: "d.md", title: "surf", at: surf, snoozeTo: at("2026-10-06T05:40") },
    ]).size).toBe(0);
  });

  it("ticks it on Done, by the stamp it was set for even after a snooze", () => {
    // The phone keeps the original stamp on a repeating snooze, so Done on the
    // snoozed ring still finds the 05:30 line.
    expect(applyAnswers(notes, [
      { kind: "snooze", path: "d.md", title: "surf", at: surf, snoozeTo: at("2026-10-06T05:40") },
      { kind: "done", path: "d.md", title: "surf", at: surf, snoozeTo: null },
    ]).get("d.md")).toBe("- [x] surf @2026-10-06 05:30! every day\n");
  });
});
