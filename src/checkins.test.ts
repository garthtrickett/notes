import { describe, expect, it } from "bun:test";
import { loadDone, saveDone, SLOTS, stateOf, type CheckinSlot } from "./checkins.ts";

const slot = (id: string): CheckinSlot => {
  const found = SLOTS.find((s) => s.id === id);
  if (!found) throw new Error(`no slot ${id}`);
  return found;
};

// 2026-09-06 is a Sunday; the dump day matches the calendar day here.
const at = (h: number, m = 0): number =>
  new Date(`2026-09-06T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`).getTime();

const mem = (): Pick<Storage, "getItem" | "setItem"> => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, v),
  };
};

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

describe("check-in storage", () => {
  it("round-trips the done set for the day", () => {
    const storage = mem();
    expect(loadDone(storage, at(10, 0))).toEqual(new Set());
    saveDone(storage, at(10, 0), new Set(["morning"]));
    expect(loadDone(storage, at(15, 0))).toEqual(new Set(["morning"]));
  });

  it("starts fresh on a new dump day", () => {
    const storage = mem();
    saveDone(storage, at(10, 0), new Set(["morning", "midday"]));
    const next = at(10, 0) + 24 * 60 * 60 * 1000;
    expect(loadDone(storage, next)).toEqual(new Set());
  });

  it("treats a corrupt value as nothing done", () => {
    const storage = mem();
    storage.setItem("notes.checkins.2026-09-06", "{broken");
    expect(loadDone(storage, at(10, 0))).toEqual(new Set());
    storage.setItem("notes.checkins.2026-09-06", '"just a string"');
    expect(loadDone(storage, at(10, 0))).toEqual(new Set());
  });
});
