import { describe, expect, it, test } from "bun:test";
import {
  appendEntry,
  composeDump,
  dayOfPath,
  dumpDayOf,
  dumpEdits,
  dumpPathOf,
  isDumpPath,
  splitDump,
  stamp,
} from "./dump.ts";

// Local time, because the rollover is about when the human felt it was night.
const at = (iso: string): number => new Date(iso).getTime();

describe("the 04:00 rollover", () => {
  it("puts an afternoon thought in today", () => {
    expect(dumpDayOf(at("2026-09-06T14:32:00"))).toBe("2026-09-06");
  });

  it("puts a 01:30 thought in the night before", () => {
    expect(dumpDayOf(at("2026-09-07T01:30:00"))).toBe("2026-09-06");
  });

  it("treats 03:59 as still the previous day", () => {
    expect(dumpDayOf(at("2026-09-07T03:59:00"))).toBe("2026-09-06");
  });

  it("starts the new day at 04:00 exactly", () => {
    expect(dumpDayOf(at("2026-09-07T04:00:00"))).toBe("2026-09-07");
  });

  it("rolls the month over correctly at 01:00", () => {
    expect(dumpDayOf(at("2026-10-01T01:00:00"))).toBe("2026-09-30");
  });

  it("builds the path from the day", () => {
    expect(dumpPathOf(at("2026-09-07T01:30:00"))).toBe("dump/2026-09-06.md");
  });
});

describe("paths", () => {
  it("recognises a dump file", () => {
    expect(isDumpPath("dump/2026-09-06.md")).toBe(true);
    expect(isDumpPath("inbox/a.md")).toBe(false);
    expect(isDumpPath("dump/notes.txt")).toBe(false);
  });

  it("reads the day back out of the name", () => {
    expect(dayOfPath("dump/2026-09-06.md")).toBe("2026-09-06");
  });
});

describe("capture", () => {
  it("stamps wall-clock time, not the shifted hour", () => {
    // The shift picks the file; the label says when it was actually written.
    expect(stamp(at("2026-09-07T01:30:00"))).toBe("01:30");
  });

  it("starts an empty day without a leading blank line", () => {
    expect(appendEntry("", "first thought", at("2026-09-06T09:05:00"))).toBe(
      "09:05 first thought\n",
    );
  });

  it("appends to the end, which is where time already puts it", () => {
    const body = "09:05 first\n";
    expect(appendEntry(body, "second", at("2026-09-06T11:20:00"))).toBe(
      "09:05 first\n11:20 second\n",
    );
  });

  it("does not pile up blank lines on a body that already ends in them", () => {
    expect(appendEntry("09:05 first\n\n\n", "second", at("2026-09-06T11:20:00"))).toBe(
      "09:05 first\n11:20 second\n",
    );
  });

  it("trims the captured text", () => {
    expect(appendEntry("", "  spaced  ", at("2026-09-06T09:05:00"))).toBe(
      "09:05 spaced\n",
    );
  });
});

describe("the dump as one document", () => {
  const day = (date: string, body: string) => ({ path: `dump/${date}.md`, body });

  test("newest day first, each under a heading of its date", () => {
    // Newest first because ascending buries today under every day before it.
    const doc = composeDump([day("2026-09-07", "09:00 up\n"), day("2026-09-06", "22:00 late\n")]);
    expect(doc).toBe("# 2026-09-07\n\n09:00 up\n\n# 2026-09-06\n\n22:00 late\n");
  });

  test("a day with nothing in it is still a heading", () => {
    expect(composeDump([day("2026-09-07", "")])).toBe("# 2026-09-07\n");
  });

  test("splits back into exactly what it was composed from", () => {
    const days = [day("2026-09-07", "09:00 up\n"), day("2026-09-06", ""), day("2026-09-05", "a\nb\n")];
    const back = splitDump(composeDump(days), days);
    expect([...back]).toEqual([
      ["2026-09-07", "09:00 up"],
      ["2026-09-06", ""],
      ["2026-09-05", "a\nb"],
    ]);
  });

  test("composing is stable through a round trip", () => {
    const days = [day("2026-09-07", "09:00 up\n"), day("2026-09-06", "x\n")];
    const once = composeDump(days);
    const twice = composeDump(
      days.map((d) => ({ path: d.path, body: splitDump(once, days).get(dayOfPath(d.path)) ?? "" })),
    );
    expect(twice).toBe(once);
  });
});

describe("dumpEdits", () => {
  const day = (date: string, body: string) => ({ path: `dump/${date}.md`, body });

  test("says nothing when the document still agrees with the files", () => {
    const days = [day("2026-09-07", "09:00 up\n"), day("2026-09-06", "x\n")];
    expect(dumpEdits(composeDump(days), days)).toEqual([]);
  });

  test("does not rewrite a file over its own trailing whitespace", () => {
    // Opening the dump and typing one character must not touch every day that
    // happened to end in a stray blank line.
    const days = [day("2026-09-07", "09:00 up\n\n\n")];
    expect(dumpEdits(composeDump(days), days)).toEqual([]);
  });

  test("reports only the day that changed", () => {
    const days = [day("2026-09-07", "up\n"), day("2026-09-06", "x\n")];
    const edited = composeDump(days).replace("x", "x edited");
    expect(dumpEdits(edited, days)).toEqual([{ path: "dump/2026-09-06.md", body: "x edited\n" }]);
  });

  test("writes back in the shape appendEntry uses", () => {
    const days = [day("2026-09-07", "")];
    expect(dumpEdits("# 2026-09-07\n\nhello", days)).toEqual([
      { path: "dump/2026-09-07.md", body: "hello\n" },
    ]);
  });

  test("text above every heading belongs to the first day", () => {
    // The rule has to be total: a section belonging to no file would be wiped
    // by the next repaint, which rebuilds this document from the notes.
    const days = [day("2026-09-07", "up\n")];
    // It keeps the blank line the heading left behind, which reads as the
    // separator it now is, and survives a further round trip unchanged.
    expect(dumpEdits("stray\n# 2026-09-07\n\nup\n", days)).toEqual([
      { path: "dump/2026-09-07.md", body: "stray\n\nup\n" },
    ]);
  });

  test("a heading for a day that does not exist is just text", () => {
    // Otherwise typing a date would silently write to nothing.
    const days = [day("2026-09-07", "up\n")];
    expect(dumpEdits("# 2026-09-07\n\nup\n# 1999-01-01\n\nold\n", days)).toEqual([
      { path: "dump/2026-09-07.md", body: "up\n# 1999-01-01\n\nold\n" },
    ]);
  });

  test("a blank line typed at the end of a day is not a disagreement", () => {
    // If this reported a change, the repaint that followed would rewrite the
    // document and trim the line away under the caret as it was being typed.
    const days = [day("2026-09-07", "up\n")];
    expect(dumpEdits("# 2026-09-07\n\nup\n\n", days)).toEqual([]);
  });

  test("no days, nothing to say", () => {
    expect(composeDump([])).toBe("");
    expect(dumpEdits("anything at all", [])).toEqual([]);
  });
});
