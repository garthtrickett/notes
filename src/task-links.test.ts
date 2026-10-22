import { describe, expect, it } from "bun:test";
import { advanceTaskLinks, completionToken, dependencyProblem, guardedTasks, linkTask, nativeTaskLinks, taskChoice, taskRefs } from "./task-links.ts";
import { tasksIn, flipTask, rollRepeats, setReminder } from "./tasks.ts";
import { taskWaiting, withTaskLink } from "./task-meta.ts";
import { alarmsWanted, reminderId, reminderSetKey } from "./notify.ts";
import { applyAnswers, parseAnswers } from "./alarms.ts";

const now = new Date(2026, 9, 23, 8, 10).getTime();
const note = (path: string, body: string) => ({ path, body, deleted: false, encoding: "utf8" });
const meta = (line: string, value: Parameters<typeof withTaskLink>[1]) => withTaskLink(line, value) + "\n";
const source = meta("- [ ] Japanese @2026-10-23 08:00! every day", { id: "japanese" });
const follow = meta("- [ ] Today review", { id: "today", after: "japanese", ready: false, alarm: true });
const update = (notes: ReturnType<typeof note>[], edits: ReadonlyMap<string, string>) => notes.map(n => ({ ...n, body: edits.get(n.path) ?? n.body }));
const refs = (body: string) => tasksIn(body, "a.md");

describe("after completing another task", () => {
  it("keeps equally named steps' alarms distinct and applies Done to the correct identity", () => {
    const body = meta("- [ ] Review @2026-10-24 08:00!", { id: "one" }) + meta("- [ ] Review @2026-10-24 08:00!", { id: "two" });
    const all = refs(body), ids = all.map(reminderId);
    expect(ids[0]).not.toBe(ids[1]);
    expect(reminderId({ ...all[0]!, path: "renamed.md", title: "Renamed task" })).toBe(ids[0]!);
    const answer = parseAnswers([{ kind: "done", path: "a.md", title: "Review", at: all[1]!.remindAt, id: ids[1] }]);
    const result = applyAnswers(() => body, answer).get("a.md")!;
    expect(refs(result).map(r => r.done)).toEqual([false, true]);
  });
  it("links by durable identity, preserves prose, and does not schedule or allow a waiting tick", () => {
    const body = "Words\n- [ ] Japanese\n- [ ] Today review\n";
    const tasks = refs(body), ids = ["japanese", "today"];
    const linked = linkTask([note("a.md", body)], tasks[1]!, taskChoice(tasks[0]!), true, () => ids.shift()!);
    expect(linked.ok).toBe(true);
    if (!linked.ok) throw Error(linked.error);
    const result = linked.value.get("a.md")!, task = refs(result)[1]!;
    expect(result.startsWith("Words\n")).toBe(true);
    expect(task.title).toBe("Today review");
    expect(task.link?.after).toBe("japanese");
    expect(alarmsWanted(refs(result), now)).toEqual([]);
    expect(flipTask(result, task)).toBe(result);
  });

  it("records completion before repeat rollover, releases once, and preserves the parent's schedule", () => {
    const before = [note("a.md", source.replace("[ ]", "[x]") + follow)];
    const after = update(before, advanceTaskLinks(before, now));
    const tasks = taskRefs(after);
    expect(tasks[0]?.link?.completed).toBe(`at:${new Date(2026, 9, 23, 8).getTime()}`);
    expect(taskWaiting(tasks[1]!)).toBe(false);
    expect(tasks[1]?.remindAt).toBe(now + 60_000);
    expect(alarmsWanted(tasks, now)).toMatchObject([{ title: "Today review", at: now + 60_000 }]);
    expect(advanceTaskLinks(after, now).size).toBe(0);
    const rolled = rollRepeats(after[0]!.body, "a.md", now);
    expect(refs(rolled)[0]?.remindAt).toBe(new Date(2026, 9, 24, 8).getTime());
    expect(refs(rolled)[0]?.link?.id).toBe("japanese");
    expect(advanceTaskLinks([note("a.md", rolled)], now).size).toBe(0);
  });

  it("reopens a completed follow-up for the next occurrence, but never stacks unfinished copies", () => {
    const first = update([note("a.md", source.replace("[ ]", "[x]") + follow)], advanceTaskLinks([note("a.md", source.replace("[ ]", "[x]") + follow)], now));
    let body = rollRepeats(first[0]!.body, "a.md", now);
    const childTime = refs(body)[1]!.remindAt;
    body = flipTask(body, refs(body)[0]!);
    const second = advanceTaskLinks([note("a.md", body)], now + 86400_000).get("a.md")!;
    expect(refs(second)).toHaveLength(2);
    expect(refs(second)[1]?.remindAt).toBe(childTime);
    let complete = flipTask(second, refs(second)[1]!);
    complete = advanceTaskLinks([note("a.md", complete)], now + 86400_000).get("a.md") ?? complete;
    complete = rollRepeats(complete, "a.md", now + 86400_000);
    complete = flipTask(complete, refs(complete)[0]!);
    const third = advanceTaskLinks([note("a.md", complete)], now + 2 * 86400_000).get("a.md")!;
    expect(refs(third)[1]?.done).toBe(false);
    expect(refs(third)[1]?.remindAt).toBe(now + 2 * 86400_000 + 60_000);
  });

  it("keeps identity through title and note renames and writes separate notes together", () => {
    const notes = [note("new-name.md", source.replace("Japanese", "Flashcards").replace("[ ]", "[x]")), note("review.md", follow)];
    const edits = advanceTaskLinks(notes, now);
    expect([...edits.keys()].sort()).toEqual(["new-name.md", "review.md"]);
    expect(taskRefs(update(notes, edits))[1]?.link?.ready).toBe(true);
  });

  it("refuses missing, duplicated, archived and circular predecessors without alarms", () => {
    for (const notes of [
      [note("a.md", follow)],
      [note("a.md", source + follow), note("copy.md", source)],
      [note(".archive/a.md", source), note("a.md", follow)],
      [note("a.md", meta("- [x] A", { id: "japanese", after: "today", ready: true }) + follow)],
    ]) {
      const all = taskRefs(notes), child = all.find(r => r.link?.after)!;
      expect(dependencyProblem(child, all)).not.toBeNull();
      expect(advanceTaskLinks(notes, now).size).toBe(0);
      expect(alarmsWanted(guardedTasks(all), now)).toEqual([]);
    }
  });

  it("guards stale form selection and self/circular links", () => {
    const notes = [note("a.md", source + follow)], all = taskRefs(notes);
    expect(linkTask(notes, all[0]!, taskChoice(all[0]!), true).ok).toBe(false);
    expect(linkTask(notes, all[0]!, taskChoice(all[1]!), true).ok).toBe(false);
    expect(linkTask(notes, all[1]!, "old", true).ok).toBe(false);
  });

  it("does not release a newly linked follow-up for yesterday's completed occurrence", () => {
    const previous = meta("- [ ] Japanese @2026-10-24 08:00! every day", { id: "japanese", completed: `at:${now}` });
    const notes = [note("a.md", previous + "- [ ] New review\n")], tasks = taskRefs(notes);
    const linked = linkTask(notes, tasks[1]!, taskChoice(tasks[0]!), true, () => "new-review");
    if (!linked.ok) throw Error(linked.error);
    const result = update(notes, linked.value);
    expect(advanceTaskLinks(result, now).size).toBe(0);
    expect(taskWaiting(taskRefs(result)[1]!)).toBe(true);
  });

  it("preserves metadata through reminder changes and rejects malformed links", () => {
    const body = setReminder(source, refs(source)[0]!, now + 3600_000, false);
    expect(refs(body)[0]?.link?.id).toBe("japanese");
    const bad = '- [ ] nope @2026-10-24 08:00! <!-- notes-task {"id":42} -->\n';
    expect(refs(bad)[0]?.invalidLink).toBe(true);
    expect(alarmsWanted(refs(bad), now)).toEqual([]);
  });

  it("can release a quiet task, and registration changes when its dependency changes", () => {
    const notes = [note("a.md", source.replace("[ ]", "[x]") + follow.replace('"alarm":true', '"alarm":false'))];
    const after = update(notes, advanceTaskLinks(notes, now));
    expect(taskRefs(after)[1]?.remindAt).toBeNull();
    expect(taskRefs(after)[1]?.link?.ready).toBe(true);
    expect(reminderSetKey(taskRefs(notes))).not.toBe(reminderSetKey(taskRefs(after)));
    expect(nativeTaskLinks(taskRefs(after))).toEqual(nativeTaskLinks(taskRefs(after).reverse()));
  });

  it("rearms a manually reopened one-off without repeating old completion on reload", () => {
    let notes = [note("a.md", meta("- [x] Flashcards", { id: "japanese" }) + follow)];
    notes = update(notes, advanceTaskLinks(notes, now));
    let body = notes[0]!.body;
    body = flipTask(body, refs(body)[1]!); // review completed
    notes = update([note("a.md", body)], advanceTaskLinks([note("a.md", body)], now));
    body = flipTask(notes[0]!.body, refs(notes[0]!.body)[0]!); // reopen flashcards
    notes = update([note("a.md", body)], advanceTaskLinks([note("a.md", body)], now));
    expect(refs(notes[0]!.body)[0]?.link?.round).toBe(1);
    expect(advanceTaskLinks(notes, now).size).toBe(0);
    body = flipTask(notes[0]!.body, refs(notes[0]!.body)[0]!);
    notes = update([note("a.md", body)], advanceTaskLinks([note("a.md", body)], now + 60_000));
    expect(refs(notes[0]!.body)[1]?.done).toBe(false);
    expect(refs(notes[0]!.body)[1]?.link?.seen).toBe("once:1");
  });

  it("replays closed-app Done → activation → child Done, without reopening on replay", () => {
    const token = completionToken({ ...refs(source)[0]!, done: true });
    const at = now + 60_000;
    const raw = [
      { kind: "done", path: "a.md", title: "Japanese", at: refs(source)[0]!.remindAt },
      { kind: "activate", path: "b.md", title: "Today review", at, taskId: "today", sourceId: "japanese", sourcePath: "a.md", token },
      { kind: "done", path: "b.md", title: "Today review", at },
    ];
    const notes = new Map([["a.md", source], ["b.md", follow]]);
    const answers = parseAnswers(raw);
    expect(answers).toHaveLength(3);
    const edits = applyAnswers(p => notes.get(p), answers);
    expect(tasksIn(edits.get("b.md")!, "b.md")[0]?.done).toBe(true);
    expect(applyAnswers(p => edits.get(p) ?? notes.get(p), answers).size).toBe(0);
    const reconciled = update([...notes].map(([p, b]) => note(p, edits.get(p) ?? b)), advanceTaskLinks([...notes].map(([p, b]) => note(p, edits.get(p) ?? b)), now));
    expect(taskRefs(reconciled)[1]?.done).toBe(true);
    const changedSource = source.replace("08:00!", "08:30!");
    expect(applyAnswers(p => p === "a.md" ? changedSource : follow, answers).size).toBe(0);
  });
});
