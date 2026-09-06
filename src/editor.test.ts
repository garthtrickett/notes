import { describe, expect, test } from "bun:test";
import { minimalChange } from "./editor.ts";

// The change is what CodeMirror maps the selection through, so "minimal" is the
// whole point: a change wider than it needs to be drags the caret with it.
const applied = (previous: string, next: string): string => {
  const { from, to, insert } = minimalChange(previous, next);
  return previous.slice(0, from) + insert + previous.slice(to);
};

describe("minimalChange", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["", "hello"],
    ["hello", ""],
    ["hello", "hello world"],
    ["hello world", "hello"],
    ["before  after", "before ![](a.png) after"],
    ["a [[old]] b [[old]] c", "a [[new]] b [[new]] c"],
    ["same", "same"],
    ["line one\nline two", "line one\nline 2"],
  ];

  for (const [previous, next] of cases) {
    test(`turns ${JSON.stringify(previous)} into ${JSON.stringify(next)}`, () => {
      expect(applied(previous, next)).toBe(next);
    });
  }

  test("touches nothing when the strings match", () => {
    expect(minimalChange("same", "same")).toEqual({ from: 4, to: 4, insert: "" });
  });

  test("spans only the middle when both ends are shared", () => {
    // Not `from: 0, to: 11` — a change that wide would move a caret that should
    // have stayed put.
    expect(minimalChange("keep XX keep", "keep YY keep")).toEqual({
      from: 5,
      to: 7,
      insert: "YY",
    });
  });

  test("inserts without deleting when text is added at the caret", () => {
    const change = minimalChange("before  after", "before ![](a.png) after");
    expect(change.from).toBe(change.to);
    expect(change.insert).toBe("![](a.png)");
  });
});
