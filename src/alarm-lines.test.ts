// The phone has a second reader of alarm lines: a background job that checks
// the vault while the app is closed (AlarmLines.java). It cannot run this
// code, so it carries its own copy of the rule, and this fixture is what keeps
// the two from drifting. Both sides read the same file — this test pins what
// the app decides, and AlarmLinesTest.java asserts the phone decides the same,
// down to the id, which is what lets the app's next sync replace the job's
// alarms instead of doubling them.
//
// Times are compared as local wall-clock strings, so the test means the same
// thing in any time zone the suite runs in.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { tasksIn } from "./tasks.ts";
import { alarmsWanted } from "./notify.ts";

interface Case {
  readonly name: string;
  readonly path: string;
  readonly body: string;
  readonly expected: { id: number; at: string; title: string; repeat: boolean }[];
}

const fixture = JSON.parse(
  readFileSync(new URL("./alarm-lines.fixture.json", import.meta.url), "utf8"),
) as { now: string; cases: Case[] };

const two = (n: number): string => String(n).padStart(2, "0");
const wall = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
};

describe("the alarm lines the background job must read the same way", () => {
  const now = new Date(fixture.now).getTime();
  for (const c of fixture.cases) {
    it(c.name, () => {
      const found = alarmsWanted(tasksIn(c.body, c.path), now)
        .map((a) => ({ id: a.id, at: wall(a.at), title: a.title, repeat: a.repeat }));
      expect(found).toEqual(c.expected);
    });
  }

  it("covers the cases that matter", () => {
    // A fixture that quietly lost its hard cases would still pass.
    expect(fixture.cases.length).toBeGreaterThanOrEqual(13);
    expect(fixture.cases.some((c) => c.body.includes("```"))).toBe(true);
    expect(fixture.cases.some((c) => /[^\u0000-\u007f]/.test(c.body))).toBe(true);
  });
});
