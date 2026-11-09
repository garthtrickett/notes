import { expect, test } from "bun:test";
import { createModel, present, type Note } from "./model.ts";
import { emptyLocation, type ViewLocation } from "./view-location.ts";

const note = (path: string): Note => ({ path, body: "A note", baseSha: "sha", pending: false, deleted: false, dirty: false, encoding: "utf8" });
const target = "z-last-viewed.md";
const first = note("aaa-unrelated.md");
const view: ViewLocation = { mode: "notes", openPath: target, preview: true };

test("restores the chosen note and preview instead of the first cached note", () => {
  const m = createModel();
  present(m, { kind: "viewRestored", location: view });
  present(m, { kind: "hydrated", notes: [first, note(target)] });
  expect(m.openPath).toBe(target);
  expect(m.preview).toBe(true);
  expect(m.pendingView).toBeNull();
});

test("preserves each root view through hydration, sync and resume", () => {
  for (const mode of ["notes", "dump", "tasks", "archive", "trash", "settings"] as const) {
    const m = createModel();
    present(m, { kind: "viewRestored", location: { ...emptyLocation, mode } });
    present(m, { kind: "hydrated", notes: [first] });
    present(m, { kind: "pulled", notes: [note(target)], gone: [], remaining: 0 });
    present(m, { kind: "resumed" });
    expect(m.mode).toBe(mode);
    expect(m.openPath).toBeNull();
  }
});

test("a requested note can arrive in a later sync batch without selecting another one", () => {
  const m = createModel();
  present(m, { kind: "viewRestored", location: view });
  present(m, { kind: "hydrated", notes: [first] });
  expect(m.openPath).toBeNull();
  expect(m.pendingView).toEqual(view);
  present(m, { kind: "pulled", notes: [note("middle.md")], gone: [], remaining: 1 });
  expect(m.openPath).toBeNull();
  present(m, { kind: "pulled", notes: [note(target)], gone: [], remaining: 0 });
  expect(m.openPath).toBe(target);
  expect(m.pendingView).toBeNull();
});

test("a late startup target cannot take over after the user chooses another screen or note", () => {
  for (const choice of ["dump", "note", "new-note"] as const) {
    const m = createModel();
    present(m, { kind: "viewRestored", location: view });
    present(m, { kind: "hydrated", notes: [first] });
    if (choice === "dump") present(m, { kind: "modeChanged", mode: "dump" });
    else if (choice === "note") present(m, { kind: "opened", path: first.path });
    else present(m, { kind: "created", path: "new.md" });
    present(m, { kind: "pulled", notes: [note(target)], gone: [], remaining: 0 });
    expect(m.pendingView).toBeNull();
    expect(m.mode).toBe(choice === "dump" ? "dump" : "notes");
    expect(m.openPath).toBe(choice === "dump" ? null : choice === "note" ? first.path : "new.md");
  }
});

test("a removed or unavailable saved note leaves the editor empty, never on another note", () => {
  const m = createModel();
  present(m, { kind: "viewRestored", location: view });
  present(m, { kind: "hydrated", notes: [first] });
  present(m, { kind: "pulled", notes: [], gone: [], remaining: 0 });
  expect(m.pendingView).toBeNull();
  expect(m.openPath).toBeNull();
  present(m, { kind: "pulled", notes: [note(target)], gone: [], remaining: 0 });
  expect(m.openPath).toBeNull();
  present(m, { kind: "opened", path: target });
  present(m, { kind: "pulled", notes: [], gone: [target], remaining: 0 });
  expect(m.openPath).toBeNull();
});

test("a notification opening another note supersedes a pending startup target", () => {
  const m = createModel();
  present(m, { kind: "viewRestored", location: view });
  present(m, { kind: "openRequested", path: first.path });
  present(m, { kind: "hydrated", notes: [first] });
  expect(m.openPath).toBe(first.path);
  expect(m.pendingView).toBeNull();
  present(m, { kind: "pulled", notes: [note(target)], gone: [], remaining: 0 });
  expect(m.openPath).toBe(first.path);
});

test("an unsupported Audio view restores safely without selecting an arbitrary note", () => {
  const m = createModel();
  present(m, { kind: "viewRestored", location: { ...emptyLocation, mode: "audio" } });
  present(m, { kind: "hydrated", notes: [first] });
  expect(m.mode).toBe("notes");
  expect(m.openPath).toBeNull();
});
