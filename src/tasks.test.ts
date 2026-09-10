// The scanner agrees with the renderer by construction: both read lezer
// Task nodes from the same parser. These pin the contract — what counts,
// where the flip lands, and how the vault groups.

import { describe, expect, test } from "bun:test";
import { spansFor } from "./decorate.ts";
import {
  createTaskCache,
  flipTask,
  tasksIn,
  tasksInVault,
} from "./tasks.ts";
import type { Note } from "./model.ts";

const note = (body: string): Note => ({
  path: "",
  body,
  baseSha: null,
  pending: false,
  deleted: false,
  dirty: false,
  encoding: "utf8",
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
});

describe("createTaskCache", () => {
  test("reparses only when the body changes", () => {
    const cache = createTaskCache();
    const first = cache.forNote("a.md", "- [ ] one\n");
    expect(cache.forNote("a.md", "- [ ] one\n")).toBe(first);
    expect(cache.forNote("a.md", "- [ ] one\n- [ ] two\n").length).toBe(2);
  });
});
