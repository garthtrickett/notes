import { describe, expect, it } from "bun:test";
import {
  CHOICES,
  describe as describeAt,
  reminderIn,
  stampOf,
  titleWithout,
  withReminder,
} from "./reminders.ts";

const at = (s: string): number => new Date(s).getTime();

describe("reading a reminder off a task line", () => {
  it("finds a date and time", () => {
    expect(reminderIn("call the bank @2026-09-11 14:30")).toBe(at("2026-09-11T14:30:00"));
  });

  it("treats a bare date as the morning", () => {
    // Midnight would fire while you are asleep, which is the same as not
    // firing at all.
    expect(reminderIn("call the bank @2026-09-11")).toBe(at("2026-09-11T09:00:00"));
  });

  it("finds one written at the front", () => {
    expect(reminderIn("@2026-09-11 call the bank")).toBe(at("2026-09-11T09:00:00"));
  });

  it("ignores an @ that is not a date", () => {
    expect(reminderIn("email simon@example.com")).toBeNull();
    expect(reminderIn("ask @simon about it")).toBeNull();
    expect(reminderIn("no reminder here")).toBeNull();
  });

  it("ignores a date glued to other text", () => {
    // Anchored at both ends, or a file named @2026-09-11.md becomes an alarm.
    expect(reminderIn("see @2026-09-11.md")).toBeNull();
    expect(reminderIn("x@2026-09-11")).toBeNull();
  });

  it("refuses a date that does not exist", () => {
    // Date rolls 02-31 over into March rather than failing, so the only way to
    // catch it is to ask what it built.
    expect(reminderIn("@2026-02-31")).toBeNull();
    expect(reminderIn("@2026-13-01")).toBeNull();
  });
});

describe("the title without its machinery", () => {
  it("takes the stamp out and tidies the gap", () => {
    expect(titleWithout("call the bank @2026-09-11 14:30")).toBe("call the bank");
    expect(titleWithout("@2026-09-11 call the bank")).toBe("call the bank");
    expect(titleWithout("call @2026-09-11 the bank")).toBe("call the bank");
  });

  it("leaves a line with no reminder exactly as it was", () => {
    expect(titleWithout("email simon@example.com")).toBe("email simon@example.com");
  });
});

describe("writing a reminder back", () => {
  it("round-trips through the text", () => {
    const when = at("2026-09-11T14:30:00");
    const line = withReminder("call the bank", when);
    expect(line).toBe("call the bank @2026-09-11 14:30");
    expect(reminderIn(line)).toBe(when);
    expect(titleWithout(line)).toBe("call the bank");
  });

  it("keeps the short form for a nine o'clock reminder", () => {
    const line = withReminder("call the bank", at("2026-09-11T09:00:00"));
    expect(line).toBe("call the bank @2026-09-11");
    expect(reminderIn(line)).toBe(at("2026-09-11T09:00:00"));
  });

  it("replaces rather than accumulates", () => {
    const first = withReminder("call the bank", at("2026-09-11T09:00:00"));
    const second = withReminder(first, at("2026-09-12T18:00:00"));
    expect(second).toBe("call the bank @2026-09-12 18:00");
    expect(second.match(/@/g)?.length).toBe(1);
  });

  it("clears with null", () => {
    const line = withReminder("call the bank", at("2026-09-11T09:00:00"));
    expect(withReminder(line, null)).toBe("call the bank");
    expect(reminderIn(withReminder(line, null))).toBeNull();
  });

  it("round-trips every stamp it can write", () => {
    for (const s of ["2026-01-01T00:00:00", "2026-09-11T09:00:00", "2026-12-31T23:59:00"]) {
      expect(reminderIn(withReminder("x", at(s)))).toBe(at(s));
    }
  });
});

describe("the quick choices", () => {
  const noon = at("2026-09-10T12:00:00");

  it("this evening is six, today", () => {
    const choice = CHOICES.find((c) => c.id === "later");
    expect(choice?.at(noon)).toBe(at("2026-09-10T18:00:00"));
  });

  it("tomorrow is nine, the next day", () => {
    const choice = CHOICES.find((c) => c.id === "tomorrow");
    expect(choice?.at(noon)).toBe(at("2026-09-11T09:00:00"));
  });

  it("all of them land in the future", () => {
    for (const c of CHOICES) expect(c.at(noon)).toBeGreaterThan(noon);
  });
});

describe("how a due time reads", () => {
  const noon = at("2026-09-10T12:00:00");
  it("says the time for today and names the day beyond it", () => {
    expect(describeAt(at("2026-09-10T18:00:00"), noon)).toBe("18:00");
    expect(describeAt(at("2026-09-11T09:00:00"), noon)).toBe("tomorrow 09:00");
    expect(describeAt(at("2026-09-13T09:00:00"), noon)).toBe("Sun 09:00");
    expect(describeAt(at("2026-10-01T09:00:00"), noon)).toBe("2026-10-01");
  });

  it("calls out one that has been missed", () => {
    expect(describeAt(at("2026-09-09T09:00:00"), noon)).toBe("overdue 09:00");
  });
});
