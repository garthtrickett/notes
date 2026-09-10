import { describe, expect, it } from "bun:test";
import { checkinLine, doneIn, SLOTS, stateOf, toggleCheckin, type CheckinSlot } from "./checkins.ts";

const slot = (id: string): CheckinSlot => {
  const found = SLOTS.find((s) => s.id === id);
  if (!found) throw new Error(`no slot ${id}`);
  return found;
};

// 2026-09-06 is a Sunday; the dump day matches the calendar day here.
const at = (h: number, m = 0): number =>
  new Date(`2026-09-06T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`).getTime();

describe("check-in state", () => {
  it("is upcoming before its time", () => {
    expect(stateOf(slot("morning"), at(8, 59), new Set())).toBe("upcoming");
  });

  it("is due once its time has passed", () => {
    expect(stateOf(slot("morning"), at(9, 0), new Set())).toBe("due");
    expect(stateOf(slot("midday"), at(12, 59), new Set())).toBe("upcoming");
    expect(stateOf(slot("midday"), at(13, 0), new Set())).toBe("due");
  });

  it("is done once ticked, whatever the clock says", () => {
    expect(stateOf(slot("morning"), at(23, 59), new Set(["morning"]))).toBe("done");
    expect(stateOf(slot("evening"), at(8, 0), new Set(["evening"]))).toBe("done");
  });
});

describe("reading done-ness out of a day's body", () => {
  it("finds nothing in a day nobody has ticked", () => {
    expect(doneIn("")).toEqual(new Set());
    expect(doneIn("09:12 something\n")).toEqual(new Set());
  });

  it("reads a ticked line and ignores an unticked one", () => {
    const body = "- [x] Morning check-in\n- [ ] Evening check-in\n";
    expect(doneIn(body)).toEqual(new Set(["morning"]));
  });

  it("ignores tasks that are not check-ins", () => {
    // The Tasks tab and the dump share these files. A todo written into the
    // day must not light up a check-in.
    expect(doneIn("- [x] buy milk\n")).toEqual(new Set());
  });

  it("accepts either case of the marker, as the markdown grammar does", () => {
    expect(doneIn("- [X] Midday check-in\n")).toEqual(new Set(["midday"]));
  });
});

describe("ticking a check-in in a day's body", () => {
  it("writes the line on the first tick, so an untouched day stays untouched", () => {
    // Nothing is seeded up front: two devices opening the dump on the same
    // morning must not both create the same file.
    expect(toggleCheckin("", slot("morning"))).toBe("- [x] Morning check-in\n");
  });

  it("flips a line that is already there", () => {
    const on = toggleCheckin("", slot("morning"));
    expect(doneIn(toggleCheckin(on, slot("morning")))).toEqual(new Set());
  });

  it("keeps the day's entries and puts the check-ins above them", () => {
    const body = "09:12 wrote the thing\n10:40 and another\n";
    const next = toggleCheckin(body, slot("midday"));
    expect(next).toBe("- [x] Midday check-in\n\n09:12 wrote the thing\n10:40 and another\n");
  });

  it("holds the lines in slot order however they were ticked", () => {
    let body = toggleCheckin("", slot("evening"));
    body = toggleCheckin(body, slot("morning"));
    expect(body.split("\n").slice(0, 2)).toEqual([
      "- [x] Morning check-in",
      "- [x] Evening check-in",
    ]);
  });

  it("leaves other tasks in the day alone", () => {
    const body = "- [ ] buy milk\n";
    const next = toggleCheckin(body, slot("morning"));
    expect(next).toBe("- [x] Morning check-in\n\n- [ ] buy milk\n");
    expect(doneIn(next)).toEqual(new Set(["morning"]));
  });

  it("round-trips through the line it writes", () => {
    for (const s of SLOTS) {
      expect(doneIn(checkinLine(s, true))).toEqual(new Set([s.id]));
      expect(doneIn(checkinLine(s, false))).toEqual(new Set());
    }
  });
});
