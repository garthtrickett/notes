import { describe, expect, it } from "bun:test";
import {
  alarmWanted,
  CHOICES,
  describe as describeAt,
  nextOccurrence,
  reminderIn,
  repeatIn,
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

describe("asking for an alarm as well", () => {
  it("reads a trailing bang as wanting one", () => {
    expect(alarmWanted("surf @2026-09-24 05:30!")).toBe(true);
    expect(alarmWanted("surf @2026-09-24!")).toBe(true);
    expect(alarmWanted("surf @2026-09-24 05:30")).toBe(false);
    expect(alarmWanted("surf")).toBe(false);
  });

  it("still reads the time, bang or no bang", () => {
    // The bang must not break the parse it is attached to.
    expect(reminderIn("surf @2026-09-24 05:30!")).toBe(at("2026-09-24T05:30:00"));
    expect(reminderIn("surf @2026-09-24!")).toBe(at("2026-09-24T09:00:00"));
  });

  it("strips the whole stamp from the title, bang included", () => {
    expect(titleWithout("surf @2026-09-24 05:30!")).toBe("surf");
  });

  it("round-trips through the text", () => {
    const when = at("2026-09-24T05:30:00");
    const line = withReminder("surf", when, true);
    expect(line).toBe("surf @2026-09-24 05:30!");
    expect(alarmWanted(line)).toBe(true);
    expect(reminderIn(line)).toBe(when);
  });

  it("keeps the short form for nine o'clock with an alarm", () => {
    expect(withReminder("surf", at("2026-09-24T09:00:00"), true)).toBe("surf @2026-09-24!");
  });

  it("drops the alarm when the reminder is cleared", () => {
    // An alarm on no reminder is nothing.
    const line = withReminder("surf", at("2026-09-24T05:30:00"), true);
    expect(withReminder(line, null)).toBe("surf");
  });

  it("does not mistake a bang in ordinary text for one", () => {
    expect(alarmWanted("surf! @2026-09-24 05:30")).toBe(false);
  });
});

describe("reading a repeat", () => {
  it("reads each form after the stamp", () => {
    expect(repeatIn("surf @2026-10-06 05:30! every day")).toBe("day");
    expect(repeatIn("standup @2026-10-06 09:30 every weekday")).toBe("weekday");
    expect(repeatIn("bins @2026-10-06 every week")).toBe("week");
    expect(repeatIn("rent @2026-10-01 every month")).toBe("month");
    expect(repeatIn("passport @2026-10-01 every year")).toBe("year");
    expect(repeatIn("water plants @2026-10-06 every 3 days")).toBe("3 days");
    expect(repeatIn("gym @2026-10-06 07:00 every mon,wed,fri")).toBe("mon,wed,fri");
    expect(repeatIn("tennis @2026-10-06 every Tuesday")).toBe("tuesday");
  });

  it("is null for a one-off", () => {
    expect(repeatIn("surf @2026-10-06 05:30!")).toBeNull();
  });

  it("only counts directly after the stamp", () => {
    // "every day" elsewhere in the sentence is just words.
    expect(repeatIn("stretch every day @2026-10-06")).toBeNull();
  });

  it("leaves a repeat it cannot read as text, keeping the reminder", () => {
    const line = "surf @2026-10-06 05:30! every fortnight";
    expect(repeatIn(line)).toBeNull();
    expect(reminderIn(line)).toBe(at("2026-10-06T05:30"));
    expect(alarmWanted(line)).toBe(true);
    expect(titleWithout(line)).toBe("surf every fortnight");
  });

  it("takes the repeat out of the title with the stamp", () => {
    expect(titleWithout("surf @2026-10-06 05:30! every day")).toBe("surf");
  });

  it("does not stop the alarm flag or time being read", () => {
    const line = "surf @2026-10-06 05:30! every day";
    expect(reminderIn(line)).toBe(at("2026-10-06T05:30"));
    expect(alarmWanted(line)).toBe(true);
  });

  it("is kept when the time is moved, and goes when it is cleared", () => {
    const line = "surf @2026-10-06 05:30! every day";
    expect(withReminder(line, at("2026-10-07T05:30"), true)).toBe("surf @2026-10-07 05:30! every day");
    expect(withReminder(line, null)).toBe("surf");
  });
});

describe("the next time a repeating task is due", () => {
  const stamp = at("2026-10-06T05:30");
  const before = at("2026-10-06T05:00");

  it("is the next day, same time, for every day", () => {
    expect(nextOccurrence(stamp, "day", before)).toBe(at("2026-10-07T05:30"));
  });

  it("is a full step on even when ticked early", () => {
    // Ticked at 05:00 for a 05:30 task: this one is done, the next is tomorrow.
    expect(nextOccurrence(stamp, "day", before)).toBe(at("2026-10-07T05:30"));
  });

  it("skips what was missed rather than piling it up", () => {
    // Left for a week and ticked on the 13th at noon: next is the 14th.
    expect(nextOccurrence(stamp, "day", at("2026-10-13T12:00"))).toBe(at("2026-10-14T05:30"));
    // Ticked on the 13th before 05:30: today's is still to come.
    expect(nextOccurrence(stamp, "day", at("2026-10-13T05:00"))).toBe(at("2026-10-13T05:30"));
  });

  it("counts weeks, months, years and numbered steps", () => {
    expect(nextOccurrence(stamp, "week", before)).toBe(at("2026-10-13T05:30"));
    expect(nextOccurrence(stamp, "month", before)).toBe(at("2026-11-06T05:30"));
    expect(nextOccurrence(stamp, "year", before)).toBe(at("2027-10-06T05:30"));
    expect(nextOccurrence(stamp, "3 days", before)).toBe(at("2026-10-09T05:30"));
    expect(nextOccurrence(stamp, "2 weeks", before)).toBe(at("2026-10-20T05:30"));
    expect(nextOccurrence(stamp, "2 months", before)).toBe(at("2026-12-06T05:30"));
  });

  it("lands a month from the 31st on the last day of a short month", () => {
    expect(nextOccurrence(at("2026-01-31T09:00"), "month", at("2026-01-31T10:00")))
      .toBe(at("2026-02-28T09:00"));
  });

  it("skips the weekend for weekday", () => {
    // 2026-10-09 is a Friday.
    expect(nextOccurrence(at("2026-10-09T09:30"), "weekday", at("2026-10-09T10:00")))
      .toBe(at("2026-10-12T09:30"));
  });

  it("goes to the next named day, in full or short", () => {
    // 2026-10-05 is a Monday.
    const monday = at("2026-10-05T07:00");
    const after = at("2026-10-05T08:00");
    expect(nextOccurrence(monday, "mon,wed,fri", after)).toBe(at("2026-10-07T07:00"));
    expect(nextOccurrence(at("2026-10-09T07:00"), "mon,wed,fri", at("2026-10-09T08:00")))
      .toBe(at("2026-10-12T07:00"));
    expect(nextOccurrence(monday, "tuesday", after)).toBe(at("2026-10-06T07:00"));
    expect(nextOccurrence(monday, "monday", after)).toBe(at("2026-10-12T07:00"));
  });

  it("keeps the wall-clock time across a daylight saving change", () => {
    // Whatever zone the tests run in, the hour must not drift.
    const next = new Date(nextOccurrence(at("2026-03-07T05:30"), "day", at("2026-03-07T06:00")) as number);
    expect([next.getHours(), next.getMinutes()]).toEqual([5, 30]);
    const later = new Date(nextOccurrence(at("2026-10-24T05:30"), "week", at("2026-10-24T06:00")) as number);
    expect([later.getHours(), later.getMinutes()]).toEqual([5, 30]);
  });

  it("refuses a rule it cannot step", () => {
    expect(nextOccurrence(stamp, "0 days", before)).toBeNull();
    expect(nextOccurrence(stamp, "fortnight", before)).toBeNull();
  });
});
