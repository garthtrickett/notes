import { describe, expect, it } from "bun:test";
import { appendEntry, dayOfPath, dumpDayOf, dumpPathOf, isDumpPath, stamp } from "./dump.ts";

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
