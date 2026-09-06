import { describe, expect, it } from "bun:test";
import { createModel, present, type Model, type Note } from "./model.ts";

const note = (path: string, body = "", dirty = false): Note => ({
  path,
  body,
  dirty,
});

const hydrated = (...notes: Note[]): Model => {
  const m = createModel();
  present(m, { kind: "hydrated", notes });
  return m;
};

describe("present — accepting", () => {
  it("hydrates and opens the first note", () => {
    const m = hydrated(note("a.md", "A"), note("b.md", "B"));
    expect(m.hydrated).toBe(true);
    expect(m.notes.size).toBe(2);
    expect(m.openPath).toBe("a.md");
  });

  it("hydrates empty without opening anything", () => {
    const m = hydrated();
    expect(m.hydrated).toBe(true);
    expect(m.openPath).toBeNull();
  });

  it("creates a note, opens it, and marks it dirty", () => {
    const m = hydrated();
    present(m, { kind: "created", path: "inbox/new.md" });
    expect(m.openPath).toBe("inbox/new.md");
    expect(m.notes.get("inbox/new.md")).toEqual(note("inbox/new.md", "", true));
  });

  it("edits a note and marks it dirty", () => {
    const m = hydrated(note("a.md", "old"));
    present(m, { kind: "edited", path: "a.md", body: "new" });
    expect(m.notes.get("a.md")).toEqual(note("a.md", "new", true));
  });

  it("deletes a note and moves off it", () => {
    const m = hydrated(note("a.md"), note("b.md"));
    present(m, { kind: "deleted", path: "a.md" });
    expect(m.notes.has("a.md")).toBe(false);
    expect(m.openPath).toBe("b.md");
  });

  it("clears openPath when the last note is deleted", () => {
    const m = hydrated(note("a.md"));
    present(m, { kind: "deleted", path: "a.md" });
    expect(m.openPath).toBeNull();
  });
});

describe("present — rejecting", () => {
  it("rejects an edit to an unknown note", () => {
    const m = hydrated(note("a.md", "A"));
    present(m, { kind: "edited", path: "ghost.md", body: "x" });
    expect(m.notes.size).toBe(1);
    expect(m.notes.has("ghost.md")).toBe(false);
  });

  it("rejects creating a note that already exists, without clobbering it", () => {
    const m = hydrated(note("a.md", "precious"));
    present(m, { kind: "created", path: "a.md" });
    expect(m.notes.get("a.md")?.body).toBe("precious");
  });

  it("rejects an unnameable note", () => {
    const m = hydrated();
    present(m, { kind: "created", path: "   " });
    expect(m.notes.size).toBe(0);
  });

  it("rejects opening a note that does not exist", () => {
    const m = hydrated(note("a.md"));
    present(m, { kind: "opened", path: "ghost.md" });
    expect(m.openPath).toBe("a.md");
  });

  it("rejects deleting nothing", () => {
    const m = hydrated(note("a.md"));
    present(m, { kind: "deleted", path: "ghost.md" });
    expect(m.notes.size).toBe(1);
  });

  it("rejects an edit that changes nothing, so a no-op cannot dirty a note", () => {
    const m = hydrated(note("a.md", "same"));
    present(m, { kind: "edited", path: "a.md", body: "same" });
    expect(m.notes.get("a.md")?.dirty).toBe(false);
  });
});

describe("present — persistence bookkeeping", () => {
  it("cleans a note whose body still matches what was written", () => {
    const m = hydrated(note("a.md", "v1"));
    present(m, { kind: "edited", path: "a.md", body: "v2" });
    present(m, { kind: "persisted", written: [{ path: "a.md", body: "v2" }] });
    expect(m.notes.get("a.md")?.dirty).toBe(false);
  });

  it("keeps a note dirty when it changed while the write was in flight", () => {
    const m = hydrated(note("a.md", "v1"));
    present(m, { kind: "edited", path: "a.md", body: "v2" });
    // v2 goes to disk, and v3 is typed before it lands.
    present(m, { kind: "edited", path: "a.md", body: "v3" });
    present(m, { kind: "persisted", written: [{ path: "a.md", body: "v2" }] });

    // Clearing the flag here would strand v3 on this device forever.
    expect(m.notes.get("a.md")?.dirty).toBe(true);
    expect(m.notes.get("a.md")?.body).toBe("v3");
  });

  it("releases the persisting latch on success and on failure", () => {
    const m = hydrated(note("a.md"));
    m.persisting = true;
    present(m, { kind: "persisted", written: [] });
    expect(m.persisting).toBe(false);

    m.persisting = true;
    present(m, { kind: "failed", message: "disk full" });
    expect(m.persisting).toBe(false);
    expect(m.error).toBe("disk full");
  });
});
