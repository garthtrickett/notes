import { describe, expect, it } from "bun:test";
import { emptyTaskDraft, taskMarkdown } from "./task-draft.ts";
import { tasksIn } from "./tasks.ts";
import { alarmsWanted } from "./notify.ts";

describe("task form Markdown", () => {
  it("writes an ordinary undated checkbox", () => {
    expect(taskMarkdown({ ...emptyTaskDraft, title: "  Buy milk  " })).toEqual({ ok: true, value: "- [ ] Buy milk\n" });
  });

  it("round-trips a local-time alarm and repeat through the real readers", () => {
    const result = taskMarkdown({ ...emptyTaskDraft, title: "Check messages", description: "Slack and Gmail\nThen close them.",
      date: "2026-10-21", time: "09:30", alarm: true, repeat: "day" });
    expect(result).toEqual({ ok: true, value: "- [ ] Check messages @2026-10-21 09:30! every day\n    Slack and Gmail\n    Then close them.\n" });
    if (!result.ok) throw new Error(result.error);
    const refs = tasksIn(result.value, "reminders.md");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ title: "Check messages", alarm: true, repeat: "day", remindAt: new Date(2026, 9, 21, 9, 30).getTime() });
    expect(alarmsWanted(refs, new Date(2026, 9, 20).getTime())).toMatchObject([
      { title: "Check messages", path: "reminders.md", repeat: true, at: new Date(2026, 9, 21, 9, 30).getTime() },
    ]);
  });

  it("uses 9am for a date without a time and does not request an alarm", () => {
    const result = taskMarkdown({ ...emptyTaskDraft, title: "Call", date: "2026-10-21", time: "" });
    expect(result).toEqual({ ok: true, value: "- [ ] Call @2026-10-21\n" });
    if (result.ok) expect(tasksIn(result.value, "a.md")[0]).toMatchObject({ remindAt: new Date(2026, 9, 21, 9).getTime(), alarm: false });
  });

  for (const patch of [
    { title: " " }, { title: "one\n- [ ] two" }, { title: "call @2026-10-21" },
    { date: "2026-02-30" }, { date: "2026-13-01" }, { date: "tomorrow" },
    { date: "2026-10-21", time: "25:00" }, { date: "2026-10-21", time: "09:70" },
    { alarm: true }, { repeat: "day" }, { date: "2026-10-21", repeat: "invalid" },
  ]) {
    it(`refuses invalid or ambiguous fields ${JSON.stringify(patch)}`, () => {
      expect(taskMarkdown({ ...emptyTaskDraft, title: "Task", ...patch }).ok).toBe(false);
    });
  }
});
