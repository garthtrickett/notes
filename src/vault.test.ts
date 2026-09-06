import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { openDb } from "./idb.ts";
import { boot, type Deps, type Loop } from "./loop.ts";
import { createModel, present, visible, type Note } from "./model.ts";
import { captureProposals } from "./actions.ts";

let db: IDBDatabase | undefined;
let root: HTMLElement;
// 2026-09-06T14:32 local
const NOON = new Date("2026-09-06T14:32:00").getTime();
let clock = NOON;

const deps = (): Deps => ({
  db: db as IDBDatabase,
  github: null,
  now: () => clock,
  schedule: (_ms, fire) => void queueMicrotask(fire),
});

const settle = async (loop: Loop) => {
  await loop.flush();
  await new Promise<void>((r) => queueMicrotask(() => r()));
};

const note = (path: string, extra: Partial<Note> = {}): Note => ({
  path,
  body: "",
  baseSha: "sha-0",
  pending: false,
  deleted: false,
  dirty: false,
  ...extra,
});

beforeEach(async () => {
  db?.close();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("notes");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
  db = await openDb();
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app") as HTMLElement;
  clock = NOON;
});

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("folders", () => {
  it("renders nested folders collapsed, then expands on click", async () => {
    const loop = await boot(deps(), root);
    loop.propose({
      kind: "hydrated",
      notes: [note("projects/gafu/runtime.md"), note("inbox/a.md")],
    });
    await settle(loop);

    // Collapsed: the folders show, the notes inside do not.
    expect(root.textContent).toContain("projects");
    expect(root.textContent).not.toContain("runtime.md");

    loop.propose({ kind: "folderToggled", path: "projects" });
    await settle(loop);
    expect(root.textContent).toContain("gafu");
    expect(root.textContent).not.toContain("runtime.md");

    loop.propose({ kind: "folderToggled", path: "projects/gafu" });
    await settle(loop);
    expect(root.textContent).toContain("runtime.md");
  });

  it("toggling a folder leaves note state alone", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("a/b.md", { body: "x" })] });
    loop.propose({ kind: "folderToggled", path: "a" });
    await settle(loop);
    const kept = loop.model.notes.get("a/b.md");
    expect(kept?.body).toBe("x");
    expect(kept?.pending).toBe(false);
  });
});

describe("moving a note", () => {
  it("creates the new path and tombstones the old one", () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [note("inbox/a.md", { body: "keep" })] });
    present(m, { kind: "moved", from: "inbox/a.md", to: "reference/a.md" });

    expect(m.notes.get("reference/a.md")?.body).toBe("keep");
    expect(m.notes.get("reference/a.md")?.pending).toBe(true);
    expect(m.notes.get("reference/a.md")?.baseSha).toBeNull();
    // The old path still needs deleting on GitHub.
    expect(m.notes.get("inbox/a.md")?.deleted).toBe(true);
    expect(m.openPath).toBe("reference/a.md");
    expect(visible(m).map((n) => n.path)).toEqual(["reference/a.md"]);
  });

  it("drops a never-synced note outright instead of tombstoning it", () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [] });
    present(m, { kind: "created", path: "a.md" });
    present(m, { kind: "moved", from: "a.md", to: "b.md" });
    expect(m.notes.has("a.md")).toBe(false);
  });

  it("rejects a move onto an existing note", () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [note("a.md", { body: "A" }), note("b.md", { body: "B" })] });
    present(m, { kind: "moved", from: "a.md", to: "b.md" });
    expect(m.notes.get("b.md")?.body).toBe("B");
    expect(m.notes.get("a.md")?.deleted).toBe(false);
  });

  it("rejects a move to nowhere", () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [note("a.md")] });
    present(m, { kind: "moved", from: "a.md", to: "   " });
    expect(m.notes.get("a.md")?.deleted).toBe(false);
  });
});

describe("capture", () => {
  it("starts today's file when the day has not begun", () => {
    const proposals = captureProposals(new Map(), "first thought", () => NOON);
    expect(proposals).toEqual([
      { kind: "created", path: "dump/2026-09-06.md" },
      {
        kind: "edited",
        path: "dump/2026-09-06.md",
        body: "14:32 first thought\n",
      },
    ]);
  });

  it("appends to a day already going", () => {
    const notes = new Map([
      ["dump/2026-09-06.md", note("dump/2026-09-06.md", { body: "09:05 earlier\n" })],
    ]);
    const proposals = captureProposals(notes, "later", () => NOON);
    expect(proposals).toEqual([
      {
        kind: "edited",
        path: "dump/2026-09-06.md",
        body: "09:05 earlier\n14:32 later\n",
      },
    ]);
  });

  it("writes a 01:30 thought into the night before", () => {
    const at = new Date("2026-09-07T01:30:00").getTime();
    const proposals = captureProposals(new Map(), "late", () => at);
    // The file is the 6th; the stamp is the real wall-clock time.
    expect(proposals[0]).toEqual({ kind: "created", path: "dump/2026-09-06.md" });
    expect(proposals[1]).toMatchObject({ body: "01:30 late\n" });
  });

  it("ignores empty capture", () => {
    expect(captureProposals(new Map(), "   ", () => NOON)).toEqual([]);
  });
});

describe("the dump view", () => {
  it("shows one editor per day, with only today writable", async () => {
    const loop = await boot(deps(), root);
    loop.propose({
      kind: "hydrated",
      notes: [
        note("dump/2026-09-05.md", { body: "10:00 yesterday" }),
        note("dump/2026-09-06.md", { body: "09:05 today" }),
      ],
    });
    loop.propose({ kind: "modeChanged", mode: "dump" });
    await settle(loop);

    const editors = root.querySelectorAll<HTMLTextAreaElement>(".day-body");
    expect(editors.length).toBe(2);
    // Oldest first, so it reads as one document top to bottom.
    expect(editors[0]?.dataset.day).toBe("dump/2026-09-05.md");
    expect(editors[0]?.readOnly).toBe(true);
    expect(editors[1]?.readOnly).toBe(false);
  });

  it("labels the live day Today rather than its date", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("dump/2026-09-06.md")] });
    loop.propose({ kind: "modeChanged", mode: "dump" });
    await settle(loop);

    const heading = root.querySelector(".day h2");
    expect(heading?.textContent?.trim()).toContain("Today");
    expect(heading?.textContent).not.toContain("2026-09-06");
  });

  it("keeps dump files out of the note tree", async () => {
    const loop = await boot(deps(), root);
    loop.propose({
      kind: "hydrated",
      notes: [note("dump/2026-09-06.md"), note("inbox/a.md")],
    });
    await settle(loop);

    expect(root.textContent).toContain("inbox");
    expect(root.textContent).not.toContain("dump");
  });
});

describe("refresh", () => {
  it("clears the sync watermark so nap pulls again", () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [] });
    m.lastSyncedAt = 12345;
    present(m, { kind: "refresh" });
    expect(m.lastSyncedAt).toBeNull();
  });

  it("does not interrupt a sync already running", () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [] });
    m.lastSyncedAt = 12345;
    m.syncing = true;
    present(m, { kind: "refresh" });
    // Otherwise a burst of focus events would stack pulls on top of each other.
    expect(m.lastSyncedAt).toBe(12345);
  });
});
