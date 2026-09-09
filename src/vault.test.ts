import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { openDb } from "./idb.ts";
import { boot, type Deps, type Loop } from "./loop.ts";
import { createModel, dumpDays, present, visible, type Note } from "./model.ts";
import { dumpEdits } from "./dump.ts";
import { captureProposals } from "./actions.ts";

let db: IDBDatabase | undefined;
let root: HTMLElement;
// 2026-09-06T14:32 local
const NOON = new Date("2026-09-06T14:32:00").getTime();
let clock = NOON;

const deps = (): Deps => ({
  db: db as IDBDatabase,
  github: null,
  shrink: async () => new ArrayBuffer(0),
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
  encoding: "utf8" as const,
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
  it("puts every day in one editor, newest first, under its own heading", async () => {
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

    expect(root.querySelectorAll(".day-body").length).toBe(0);
    expect(root.querySelectorAll("#editor-host").length).toBe(1);
    // Newest first: the day you are writing in is the one you can see without
    // scrolling past every day before it.
    expect(loop.model.mode).toBe("dump");
    const text = root.querySelector("#editor-host")?.textContent ?? "";
    expect(text.indexOf("2026-09-06")).toBeLessThan(text.indexOf("2026-09-05"));
    expect(text).toContain("09:05 today");
    expect(text).toContain("10:00 yesterday");
  });

  it("writes an edit back into the day it was made in", async () => {
    const loop = await boot(deps(), root);
    loop.propose({
      kind: "hydrated",
      notes: [
        note("dump/2026-09-05.md", { body: "10:00 yesterday\n" }),
        note("dump/2026-09-06.md", { body: "09:05 today\n" }),
      ],
    });
    loop.propose({ kind: "modeChanged", mode: "dump" });
    await settle(loop);

    // What CodeMirror would hand back after typing in the older day.
    const edited = "# 2026-09-06\n\n09:05 today\n\n# 2026-09-05\n\n10:00 yesterday and more\n";
    for (const day of dumpEdits(edited, dumpDays(loop.model))) {
      loop.propose({ kind: "edited", path: day.path, body: day.body });
    }
    await settle(loop);

    expect(loop.model.notes.get("dump/2026-09-05.md")?.body).toBe(
      "10:00 yesterday and more\n",
    );
    // And the day nobody touched is untouched — not rewritten, not dirtied.
    expect(loop.model.notes.get("dump/2026-09-06.md")?.body).toBe("09:05 today\n");
  });

  it("heads each day with its date, which is what makes the split reversible", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("dump/2026-09-06.md")] });
    loop.propose({ kind: "modeChanged", mode: "dump" });
    await settle(loop);

    // The old view said "Today" for the live day. A heading in a document has
    // to name the file it stands for, or an edit cannot be written back.
    expect(root.querySelector("#editor-host")?.textContent).toContain("2026-09-06");
  });

  it("shows a captured line without being asked to re-read the file", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("dump/2026-09-06.md", { body: "09:05 up\n" })] });
    loop.propose({ kind: "modeChanged", mode: "dump" });
    await settle(loop);

    for (const p of captureProposals(loop.model.notes, "a new thought", () => NOON)) {
      loop.propose(p);
    }
    await settle(loop);

    // The document is composed from the notes, so a capture has to reach it
    // through a repaint rather than by anyone re-reading the file.
    expect(root.querySelector("#editor-host")?.textContent).toContain("a new thought");
  });

  it("shows the way out on the folder the digits are counting inside", async () => {
    // Escape is not a thing you can see. Without this the only clue the numbers
    // have moved is that they are somewhere else.
    const loop = await boot(deps(), root);
    loop.propose({
      kind: "hydrated",
      notes: [note("health/hip/a.md"), note("health/b.md"), note("other/c.md")],
    });
    await settle(loop);
    expect(root.querySelector(".num.out")).toBeNull();

    loop.propose({ kind: "jumped", index: 0 }); // health
    await settle(loop);
    const out = root.querySelector(".num.out");
    expect(out?.textContent).toBe("esc");
    // On the folder itself, where its own digit used to be.
    expect(out?.closest("button")?.textContent).toContain("health");
  });

  it("offers search from every mode, because the shortcut needs a keyboard", async () => {
    // The palette was reachable only by pressing O, which on a phone is not
    // reachable at all.
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("a.md")] });
    await settle(loop);
    for (const mode of ["notes", "dump", "archive", "trash"] as const) {
      loop.propose({ kind: "modeChanged", mode });
      await settle(loop);
      expect(root.querySelector(".search-button")).not.toBeNull();
    }
  });

  it("the search button opens the same palette the shortcut does", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("a.md")] });
    await settle(loop);
    root.querySelector<HTMLButtonElement>(".search-button")?.click();
    await settle(loop);
    expect(loop.model.modal?.kind).toBe("open");
  });

  it("keeps the search button out of the row that wraps", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("a.md")] });
    await settle(loop);

    const button = root.querySelector(".search-button");
    // Inside .modes it wraps with them, so on a narrow phone it lands in a
    // different corner than on a wide one.
    expect(button?.closest(".modes")).toBeNull();
    expect(button?.parentElement?.className).toBe("tabs");
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

describe("resumed", () => {
  it("clears the sync watermark so nap pulls again", () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [] });
    m.lastSyncedAt = 12345;
    present(m, { kind: "resumed" });
    expect(m.lastSyncedAt).toBeNull();
  });

  it("does not interrupt a sync already running", () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [] });
    m.lastSyncedAt = 12345;
    m.syncing = true;
    present(m, { kind: "resumed" });
    // Otherwise a burst of focus events would stack pulls on top of each other.
    expect(m.lastSyncedAt).toBe(12345);
  });
});

describe("quick capture from anywhere", () => {
  it("opens over the notes view and captures to today's dump", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("inbox/a.md")] });
    await settle(loop);
    expect(root.querySelector("#modal-input")).toBeNull();

    loop.propose({ kind: "modalOpened", modal: { kind: "capture" } });
    await settle(loop);

    const box = root.querySelector<HTMLInputElement>("#modal-input");
    expect(box).not.toBeNull();
    // Opening it should put the caret in it; otherwise the shortcut saves
    // nothing over clicking.
    expect(document.activeElement).toBe(box as Element);

    box!.value = "a passing thought";
    box!.closest("form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await settle(loop);

    // Same destination as the box on the dump page: one capture path.
    expect(loop.model.notes.get("dump/2026-09-06.md")?.body).toBe(
      "14:32 a passing thought\n",
    );
    expect(loop.model.modal).toBeNull();
    // And you are still where you were.
    expect(loop.model.mode).toBe("notes");
    expect(loop.model.openPath).toBe("inbox/a.md");
  });

  it("closes without capturing when dismissed", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("inbox/a.md")] });
    loop.propose({ kind: "modalOpened", modal: { kind: "capture" } });
    await settle(loop);

    loop.propose({ kind: "modalClosed" });
    await settle(loop);
    expect(root.querySelector("#modal-input")).toBeNull();
    expect(loop.model.notes.has("dump/2026-09-06.md")).toBe(false);
  });

  it("is available from the dump view too", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [] });
    loop.propose({ kind: "modeChanged", mode: "dump" });
    loop.propose({ kind: "modalOpened", modal: { kind: "capture" } });
    await settle(loop);
    expect(root.querySelector("#modal-input")).not.toBeNull();
  });
});

describe("creating something you cannot open", () => {
  it("does not follow you to a dump file", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("inbox/a.md")] });
    await settle(loop);

    loop.propose({ kind: "created", path: "dump/2026-09-06.md" });
    await settle(loop);
    expect(loop.model.openPath).toBe("inbox/a.md");
  });

  it("still follows you to a note", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("inbox/a.md")] });
    loop.propose({ kind: "created", path: "inbox/b.md" });
    await settle(loop);
    expect(loop.model.openPath).toBe("inbox/b.md");
  });
});

describe("the open palette", () => {
  const withNotes = async () => {
    const loop = await boot(deps(), root);
    loop.propose({
      kind: "hydrated",
      notes: [
        note("inbox/alpha.md", { body: "milk" }),
        note("reference/beta.md", { body: "grammar" }),
        note("dump/2026-09-06.md", { body: "09:00 thought" }),
        note("attachments/x.webp", { body: "AAAA", encoding: "base64" }),
      ],
    });
    loop.propose({ kind: "modalOpened", modal: { kind: "open" } });
    await settle(loop);
    return loop;
  };

  const rows = () =>
    [...root.querySelectorAll(".palette .results .path")].map((n) => n.textContent);

  it("lists every note with an empty query, so Enter works without typing", async () => {
    await withNotes();
    // Attachments and dump days are not notes, and the palette opens notes.
    expect(rows()).toEqual(["inbox/alpha.md", "reference/beta.md"]);
  });

  it("filters as you type", async () => {
    const loop = await withNotes();
    loop.propose({ kind: "searched", query: "grammar" });
    await settle(loop);
    expect(rows()).toEqual(["reference/beta.md"]);
  });

  it("opens the selected note and closes", async () => {
    const loop = await withNotes();
    loop.propose({ kind: "paletteMoved", delta: 1 });
    await settle(loop);

    root.querySelectorAll<HTMLButtonElement>(".palette .results .row")[1]!.click();
    await settle(loop);
    expect(loop.model.openPath).toBe("reference/beta.md");
    expect(loop.model.modal).toBeNull();
  });

  it("forgets the query when dismissed, so it opens fresh", async () => {
    const loop = await withNotes();
    loop.propose({ kind: "searched", query: "grammar" });
    loop.propose({ kind: "paletteMoved", delta: 1 });
    loop.propose({ kind: "modalClosed" });
    await settle(loop);
    expect(loop.model.query).toBe("");
    expect(loop.model.paletteIndex).toBe(0);
  });

  it("says so when nothing matches", async () => {
    const loop = await withNotes();
    loop.propose({ kind: "searched", query: "zzzz" });
    await settle(loop);
    expect(root.querySelector(".palette .empty")?.textContent).toContain("No note");
  });
});

describe("creating from the dump", () => {
  it("takes you to the new note", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [] });
    loop.propose({ kind: "modeChanged", mode: "dump" });
    loop.propose({ kind: "modalOpened", modal: { kind: "newNote" } });
    await settle(loop);

    loop.propose({ kind: "created", path: "inbox/fresh.md" });
    loop.propose({ kind: "modalClosed" });
    await settle(loop);

    // Otherwise you create a note and stay looking at the dump.
    expect(loop.model.mode).toBe("notes");
    expect(loop.model.openPath).toBe("inbox/fresh.md");
  });

  it("quick capture still leaves you where you were", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [] });
    loop.propose({ kind: "modeChanged", mode: "dump" });
    await settle(loop);
    // The dump file it creates is not openable, so nothing moves.
    for (const p of captureProposals(loop.model.notes, "a thought", () => NOON)) {
      loop.propose(p);
    }
    await settle(loop);
    expect(loop.model.mode).toBe("dump");
  });
});

describe("check-ins across a reload", () => {
  const mem = (): Pick<Storage, "getItem" | "setItem"> & { raw(): string | null } => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
      setItem: (k: string, v: string) => void m.set(k, v),
      raw: () => m.get("notes.checkins.2026-09-06") ?? null,
    };
  };

  it("writes localStorage on toggle and reads it back on boot", async () => {
    const storage = mem();
    const first = await boot({ ...deps(), storage }, root);
    await settle(first);
    first.propose({ kind: "checkinToggled", id: "morning" });
    expect(storage.raw()).toBe('["morning"]');

    const second = await boot({ ...deps(), storage }, root);
    await settle(second);
    expect(second.model.checkinsDone.has("morning")).toBe(true);
  });

  it("does not persist when no storage is injected", async () => {
    const loop = await boot(deps(), root);
    await settle(loop);
    loop.propose({ kind: "checkinToggled", id: "morning" });
    expect(loop.model.checkinsDone.has("morning")).toBe(true);
  });
});

describe("check-ins on screen", () => {
  it("renders three slots in the dump view and ticks one off", async () => {
    const loop = await boot(deps(), root);
    await settle(loop);
    loop.propose({ kind: "modeChanged", mode: "dump" });
    await settle(loop);
    const items = [...root.querySelectorAll(".checkins li")];
    expect(items.length).toBe(3);
    expect(items[0]?.textContent).toContain("Morning check-in");
    expect(items[0]?.textContent).toContain("09:00");

    (items[0]?.querySelector("button") as HTMLButtonElement).click();
    await settle(loop);
    expect(root.querySelector(".checkins li.done")).not.toBeNull();
  });
});
