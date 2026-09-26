import { describe, expect, it } from "bun:test";
import { mergeInsertions } from "./merge.ts";

describe("merging two sets of insertions", () => {
  it("keeps both sides when each appended", () => {
    // The real case, twice over, on 2026-09-25.
    const base = "05:36 69.45kg\n06:02 1.4m tide bit low at gangga\n";
    const ours = base + "09:17 write on my board\n";
    const theirs = base + "10:22 rail tape\n15:18 no sunburn\n";
    expect(mergeInsertions(base, ours, theirs)).toBe(
      "05:36 69.45kg\n06:02 1.4m tide bit low at gangga\n10:22 rail tape\n15:18 no sunburn\n09:17 write on my board\n",
    );
  });

  it("keeps a line inserted in the middle by each side", () => {
    const base = "a\nb\nc";
    expect(mergeInsertions(base, "a\nX\nb\nc", "a\nb\nY\nc")).toBe("a\nX\nb\nY\nc");
  });

  it("counts a line both sides added in the same place once", () => {
    // Two devices ticking the same check-in must not produce two of it.
    const base = "note\n";
    const same = "- [x] Morning check-in\nnote\n";
    expect(mergeInsertions(base, same, same)).toBe(same);
  });

  it("keeps a line one side added twice", () => {
    // Deduping is per-slot against the other side, not a global uniqueness
    // rule: a note that legitimately repeats a line keeps both.
    const base = "x";
    expect(mergeInsertions(base, "dup\ndup\nx", "x")).toBe("dup\ndup\nx");
  });

  it("returns what is there when only one side moved", () => {
    const base = "a\nb";
    expect(mergeInsertions(base, "a\nb\nnew", base)).toBe("a\nb\nnew");
    expect(mergeInsertions(base, base, "a\nb\nnew")).toBe("a\nb\nnew");
  });

  it("refuses a deletion", () => {
    // Merging here would resurrect the line, which is not a merge, it is
    // ignoring somebody.
    expect(mergeInsertions("a\nb\nc", "a\nc", "a\nb\nc\nd")).toBeNull();
  });

  it("refuses an edit", () => {
    // An edited line reads as a delete plus an insert, so the merge would keep
    // both wordings. Better to make a copy and let a person choose.
    expect(mergeInsertions("hello\n", "goodbye\n", "hello\nmore\n")).toBeNull();
  });

  it("refuses a reorder", () => {
    expect(mergeInsertions("a\nb", "b\na", "a\nb\nc")).toBeNull();
  });

  it("is not fooled by a repeated base line", () => {
    // Leftmost-greedy matching is the subsequence test; a naive "is every base
    // line present" check would pass a file that had lost one of a pair.
    expect(mergeInsertions("a\na\nb", "a\nb", "a\na\nb\nc")).toBeNull();
    expect(mergeInsertions("a\na\nb", "a\na\nX\nb", "a\na\nb")).toBe("a\na\nX\nb");
  });

  it("merges into an empty base", () => {
    expect(mergeInsertions("", "\nmine", "\nyours")).toBe("\nyours\nmine");
  });

  it("never loses a line it accepted", () => {
    const base = "1\n2\n3";
    const ours = "1\nA\n2\n3\nB";
    const theirs = "1\n2\nC\n3\nD";
    const merged = mergeInsertions(base, ours, theirs) as string;
    for (const line of [...ours.split("\n"), ...theirs.split("\n")]) {
      expect(merged.split("\n")).toContain(line);
    }
  });
});
