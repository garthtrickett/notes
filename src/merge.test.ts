import { describe, expect, it } from "bun:test";
import { mergeLines } from "./merge.ts";

describe("merging two devices' edits", () => {
  it("keeps both sides when each appended", () => {
    // The real case, twice over, on 2026-09-25.
    const base = "05:36 69.45kg\n06:02 1.4m tide bit low at gangga\n";
    const ours = base + "09:17 write on my board\n";
    const theirs = base + "10:22 rail tape\n15:18 no sunburn\n";
    expect(mergeLines(base, ours, theirs)).toBe(
      "05:36 69.45kg\n06:02 1.4m tide bit low at gangga\n10:22 rail tape\n15:18 no sunburn\n09:17 write on my board\n",
    );
  });

  it("keeps a line inserted in the middle by each side", () => {
    const base = "a\nb\nc";
    expect(mergeLines(base, "a\nX\nb\nc", "a\nb\nY\nc")).toBe("a\nX\nb\nY\nc");
  });

  it("counts a line both sides added in the same place once", () => {
    // Two devices ticking the same check-in must not produce two of it.
    const base = "note\n";
    const same = "- [x] Morning check-in\nnote\n";
    expect(mergeLines(base, same, same)).toBe(same);
  });

  it("keeps a line one side added twice", () => {
    // Deduping is per-slot against the other side, not a global uniqueness
    // rule: a note that legitimately repeats a line keeps both.
    const base = "x";
    expect(mergeLines(base, "dup\ndup\nx", "x")).toBe("dup\ndup\nx");
  });

  it("returns what is there when only one side moved", () => {
    const base = "a\nb";
    expect(mergeLines(base, "a\nb\nnew", base)).toBe("a\nb\nnew");
    expect(mergeLines(base, base, "a\nb\nnew")).toBe("a\nb\nnew");
  });

  it("applies a deletion on one side and an append on the other", () => {
    // The insertion-only merge refused this, because keeping the line would
    // have resurrected it. A three-way merge applies the deletion instead.
    expect(mergeLines("a\nb\nc", "a\nc", "a\nb\nc\nd")).toBe("a\nc\nd");
  });

  it("applies an edit on one side and an append right after it on the other", () => {
    // Touching, not overlapping: the order is not in doubt.
    expect(mergeLines("hello\n", "goodbye\n", "hello\nmore\n")).toBe("goodbye\nmore\n");
  });

  it("applies a move on one side alongside an append on the other, losing nothing", () => {
    expect(mergeLines("a\nb", "b\na", "a\nb\nc")).toBe("b\nc\na");
  });

  it("is not fooled by a repeated base line", () => {
    // One of a pair deleted on one side is a deletion of one line, not a
    // licence to drop both or keep both.
    expect(mergeLines("a\na\nb", "a\nb", "a\na\nb\nc")).toBe("a\nb\nc");
    expect(mergeLines("a\na\nb", "a\na\nX\nb", "a\na\nb")).toBe("a\na\nX\nb");
  });

  it("merges the 2026-10-06 dump: a time changed on one line, a line appended below", () => {
    // The real case that made two conflict copies in thirty seconds.
    const base = "06:19 69.2kg\n- [ ] Buy another CGM and use it while I can't surf @2026-10-06 13:00!\n";
    const ours = base.replace("13:00", "12:00");
    const theirs = `${base}09:34 Go into business with harry on workout space and nutrition place\n`;
    expect(mergeLines(base, ours, theirs)).toBe(
      "06:19 69.2kg\n- [ ] Buy another CGM and use it while I can't surf @2026-10-06 12:00!\n09:34 Go into business with harry on workout space and nutrition place\n",
    );
  });

  it("merges a tick on one device with a new task on the other", () => {
    expect(mergeLines("- [ ] x\n- [ ] y\n", "- [x] x\n- [ ] y\n", "- [ ] x\n- [ ] y\n- [ ] z\n"))
      .toBe("- [x] x\n- [ ] y\n- [ ] z\n");
  });

  it("merges ticks of two different tasks, even on neighbouring lines", () => {
    expect(mergeLines("- [ ] x\n- [ ] y\n", "- [x] x\n- [ ] y\n", "- [ ] x\n- [x] y\n"))
      .toBe("- [x] x\n- [x] y\n");
  });

  it("keeps one copy of the same edit made on both sides", () => {
    expect(mergeLines("a\nb\nc", "a\nB\nc", "a\nB\nc\nd")).toBe("a\nB\nc\nd");
  });

  it("refuses the same line changed differently on each side", () => {
    // Which wording is right is a person's call; the copy lets them make it.
    expect(mergeLines("a\nb\nc", "a\nB1\nc", "a\nB2\nc")).toBeNull();
  });

  it("refuses a line edited on one side and deleted on the other", () => {
    expect(mergeLines("a\nb\nc", "a\nB\nc", "a\nc")).toBeNull();
  });

  it("refuses a line added inside a stretch the other side rewrote", () => {
    expect(mergeLines("a\nb\nc\nd", "a\nX\nd", "a\nb\nY\nc\nd")).toBeNull();
  });

  it("still merges a long note with small local edits", () => {
    // Stripping the shared start and end is what keeps this under the size
    // cap: a 3000-line note compared whole would be refused, and a year-long
    // note would get a conflict copy for a one-line tick.
    const lines = Array.from({ length: 3000 }, (_, k) => `line ${k}`);
    const base = lines.join("\n");
    const ours = lines.map((l, k) => (k === 1500 ? "line 1500 edited" : l)).join("\n");
    const theirs = `${base}\nappended`;
    expect(mergeLines(base, ours, theirs)).toBe(`${ours}\nappended`);
  });

  it("gives up on notes too large to compare rather than stalling a push", () => {
    // A line added at each end leaves no common prefix or suffix to strip, so
    // the whole 2500-line note goes to the quadratic comparison — past the cap.
    // Without the cap this would merge; with it the push makes a copy instead.
    const big = Array.from({ length: 2500 }, (_, k) => `line ${k}`).join("\n");
    expect(mergeLines(big, `top\n${big}\nbottom`, `${big}\nthird`)).toBeNull();
  });

  it("merges into an empty base", () => {
    expect(mergeLines("", "\nmine", "\nyours")).toBe("\nyours\nmine");
  });

  it("never loses a line it accepted", () => {
    const base = "1\n2\n3";
    const ours = "1\nA\n2\n3\nB";
    const theirs = "1\n2\nC\n3\nD";
    const merged = mergeLines(base, ours, theirs) as string;
    for (const line of [...ours.split("\n"), ...theirs.split("\n")]) {
      expect(merged.split("\n")).toContain(line);
    }
  });
});
