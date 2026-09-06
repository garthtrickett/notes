import type { TreeNode } from "./tree.ts";
import { describe, expect, it } from "bun:test";
import { createModel, present, type Model, type Note, noteTree, numberedRows } from "./model.ts";

const note = (
  path: string,
  body = "",
  dirty = false,
  extra: Partial<Note> = {},
): Note => ({
  path,
  body,
  baseSha: "sha-0",
  pending: false,
  deleted: false,
  dirty,
  encoding: "utf8" as const,
  ...extra,
});

const recordOf = ({ path, body, baseSha, pending, deleted, encoding }: Note) => ({
  path,
  body,
  baseSha,
  pending,
  deleted,
  encoding,
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

  it("creates a note, opens it, and marks it dirty and pending", () => {
    const m = hydrated();
    present(m, { kind: "created", path: "inbox/new.md" });
    expect(m.openPath).toBe("inbox/new.md");
    expect(m.notes.get("inbox/new.md")).toEqual(
      note("inbox/new.md", "", true, { baseSha: null, pending: true }),
    );
  });

  it("edits a note and marks it dirty and pending", () => {
    const m = hydrated(note("a.md", "old"));
    present(m, { kind: "edited", path: "a.md", body: "new" });
    expect(m.notes.get("a.md")).toEqual(
      note("a.md", "new", true, { pending: true }),
    );
  });

  it("tombstones a synced note rather than dropping it, and moves off it", () => {
    const m = hydrated(note("a.md"), note("b.md"));
    present(m, { kind: "deleted", path: "a.md" });

    // The record survives so the remote delete can still be sent.
    const tombstone = m.notes.get("a.md");
    expect(tombstone?.deleted).toBe(true);
    expect(tombstone?.pending).toBe(true);
    expect(tombstone?.body).toBe("");
    expect(m.openPath).toBe("b.md");
  });

  it("drops a never-synced note outright, with nothing to tell GitHub", () => {
    const m = hydrated(note("a.md", "", false, { baseSha: null }));
    present(m, { kind: "deleted", path: "a.md" });
    expect(m.notes.has("a.md")).toBe(false);
  });

  it("clears openPath when the last visible note is deleted", () => {
    const m = hydrated(note("a.md"));
    present(m, { kind: "deleted", path: "a.md" });
    expect(m.openPath).toBeNull();
  });

  it("shows the note it opens, even from the dump", () => {
    const m = hydrated(note("a.md"), note("b.md"));
    present(m, { kind: "modeChanged", mode: "dump" });
    present(m, { kind: "opened", path: "b.md" });
    // Setting openPath alone left the dump on screen, so the open palette
    // looked like it did nothing at all.
    expect(m.openPath).toBe("b.md");
    expect(m.mode).toBe("notes");
  });

  it("stays in the dump when the open is refused", () => {
    const m = hydrated(note("a.md"));
    present(m, { kind: "modeChanged", mode: "dump" });
    present(m, { kind: "opened", path: "ghost.md" });
    expect(m.mode).toBe("dump");
  });

  it("never opens a tombstone", () => {
    const m = hydrated(note("a.md"), note("b.md"));
    present(m, { kind: "deleted", path: "a.md" });
    present(m, { kind: "opened", path: "a.md" });
    expect(m.openPath).toBe("b.md");
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
    present(m, { kind: "persisted", written: [recordOf(note("a.md", "v2"))] });
    expect(m.notes.get("a.md")?.dirty).toBe(false);
  });

  it("keeps a note dirty when it changed while the write was in flight", () => {
    const m = hydrated(note("a.md", "v1"));
    present(m, { kind: "edited", path: "a.md", body: "v2" });
    // v2 goes to disk, and v3 is typed before it lands.
    present(m, { kind: "edited", path: "a.md", body: "v3" });
    present(m, { kind: "persisted", written: [recordOf(note("a.md", "v2"))] });

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
    present(m, { kind: "failed", error: { kind: "writeFailed", cause: "disk full" } });
    expect(m.persisting).toBe(false);
    expect(m.error).toContain("Could not save to this device");
  });
});

describe("present — folders and number shortcuts", () => {
  it("deletes every note under a folder", () => {
    const m = hydrated(
      note("examples/one.md"),
      note("examples/deep/two.md"),
      note("keep.md"),
    );
    present(m, { kind: "folderDeleted", path: "examples" });
    expect([...m.notes.keys()].filter((p) => !m.notes.get(p)?.deleted)).toEqual([
      "keep.md",
    ]);
  });

  it("does not delete a folder whose name is a prefix of another", () => {
    const m = hydrated(note("ex/one.md"), note("examples/two.md"));
    present(m, { kind: "folderDeleted", path: "ex" });
    expect(m.notes.get("examples/two.md")?.deleted).toBeFalsy();
  });

  it("moves off a note it just deleted with its folder", () => {
    const m = hydrated(note("examples/one.md"), note("keep.md"));
    present(m, { kind: "opened", path: "examples/one.md" });
    present(m, { kind: "folderDeleted", path: "examples" });
    expect(m.openPath).toBe("keep.md");
  });

  it("rejects deleting a folder that is not there", () => {
    const m = hydrated(note("a.md"));
    present(m, { kind: "folderDeleted", path: "ghost" });
    expect(m.notes.size).toBe(1);
  });

  it("numbers the top level in the order the tree shows it", () => {
    // Folders first, then notes, both alphabetical — the tree's rule, not a
    // second copy of it.
    const m = hydrated(note("zebra/in.md"), note("apple/in.md"), note("a-note.md"));
    expect(noteTree(m).map((n) => (n.kind === "folder" ? n.path : n.note.path))).toEqual([
      "apple",
      "zebra",
      "a-note.md",
    ]);
  });

  it("opens the note a digit points at, from anywhere", () => {
    const m = hydrated(note("apple/in.md"), note("a-note.md"));
    present(m, { kind: "modeChanged", mode: "dump" });
    present(m, { kind: "jumped", index: 1 });
    expect(m.openPath).toBe("a-note.md");
    expect(m.mode).toBe("notes");
  });

  it("expands the folder a digit points at, and shows the tree", () => {
    const m = hydrated(note("apple/in.md"));
    present(m, { kind: "modeChanged", mode: "dump" });
    present(m, { kind: "jumped", index: 0 });
    expect(m.expanded.has("apple")).toBe(true);
    expect(m.mode).toBe("notes");
    // Expand, not toggle. Once the numbers are scoped inside the folder, a
    // second press of the same digit means its first child.
    present(m, { kind: "jumped", index: 0 });
    expect(m.expanded.has("apple")).toBe(true);
    expect(m.openPath).toBe("apple/in.md");
  });

  it("does nothing for a digit with no row under it", () => {
    const m = hydrated(note("a.md"));
    present(m, { kind: "modeChanged", mode: "dump" });
    present(m, { kind: "jumped", index: 7 });
    // Not an error: an empty slot is empty, not wrong.
    expect(m.mode).toBe("dump");
    expect(m.error).toBeNull();
  });
});

describe("present — confirming a delete", () => {
  it("deletes the note the dialog was asking about", () => {
    const m = hydrated(note("a.md"), note("b.md"));
    present(m, {
      kind: "modalOpened",
      modal: { kind: "confirmDelete", path: "a.md", folder: false },
    });
    // Nothing has happened yet: the dialog holds the question.
    expect(m.notes.get("a.md")?.deleted).toBeFalsy();
    present(m, { kind: "modalConfirmed" });
    // A note GitHub has seen leaves a tombstone rather than vanishing, so the
    // remote delete still has something to carry.
    expect(m.notes.get("a.md")?.deleted).toBe(true);
    expect(m.modal).toBeNull();
  });

  it("deletes the folder the dialog was asking about", () => {
    const m = hydrated(note("examples/one.md"), note("keep.md"));
    present(m, {
      kind: "modalOpened",
      modal: { kind: "confirmDelete", path: "examples", folder: true },
    });
    present(m, { kind: "modalConfirmed" });
    expect(m.notes.get("examples/one.md")?.deleted).toBe(true);
    expect(m.notes.get("keep.md")?.deleted).toBe(false);
  });

  it("keeps the note when the dialog is dismissed", () => {
    const m = hydrated(note("a.md"));
    present(m, {
      kind: "modalOpened",
      modal: { kind: "confirmDelete", path: "a.md", folder: false },
    });
    present(m, { kind: "modalClosed" });
    expect(m.notes.get("a.md")?.deleted).toBe(false);
    expect(m.modal).toBeNull();
  });

  it("refuses to confirm when no question was asked", () => {
    const m = hydrated(note("a.md"));
    present(m, { kind: "modalOpened", modal: { kind: "open" } });
    present(m, { kind: "modalConfirmed" });
    expect(m.notes.get("a.md")?.deleted).toBe(false);
  });
});

const label = (n: TreeNode): string => (n.kind === "folder" ? n.path : n.note.path);

describe("present — numbers that follow you into a folder", () => {
  const nested = () =>
    hydrated(
      note("apple/one.md"),
      note("apple/two.md"),
      note("apple/deeper/three.md"),
      note("zebra/four.md"),
      note("loose.md"),
    );

  it("numbers the top level until a folder is chosen", () => {
    const m = nested();
    expect(numberedRows(m).map(label)).toEqual(["apple", "zebra", "loose.md"]);
  });

  it("expands a folder and counts inside it", () => {
    const m = nested();
    present(m, { kind: "jumped", index: 0 });
    expect(m.expanded.has("apple")).toBe(true);
    expect(m.numberScope).toBe("apple");
    // Folders before notes, same rule as everywhere else.
    expect(numberedRows(m).map(label)).toEqual([
      "apple/deeper",
      "apple/one.md",
      "apple/two.md",
    ]);
  });

  it("reaches a nested note with two digits", () => {
    const m = nested();
    present(m, { kind: "jumped", index: 0 }); // apple
    present(m, { kind: "jumped", index: 1 }); // one.md
    expect(m.openPath).toBe("apple/one.md");
    // Opening leaves the folder, so the digits go back to the top level.
    expect(m.numberScope).toBeNull();
  });

  it("goes deeper still", () => {
    const m = nested();
    present(m, { kind: "jumped", index: 0 }); // apple
    present(m, { kind: "jumped", index: 0 }); // apple/deeper
    expect(m.numberScope).toBe("apple/deeper");
    present(m, { kind: "jumped", index: 0 }); // three.md
    expect(m.openPath).toBe("apple/deeper/three.md");
  });

  it("does not toggle a folder shut on a second press", () => {
    const m = nested();
    present(m, { kind: "jumped", index: 0 });
    present(m, { kind: "unscoped" });
    present(m, { kind: "jumped", index: 0 });
    // Still open: with a scope, a repeated digit has to mean "its first child".
    expect(m.expanded.has("apple")).toBe(true);
  });

  it("returns to the top level when unscoped", () => {
    const m = nested();
    present(m, { kind: "jumped", index: 0 });
    present(m, { kind: "unscoped" });
    expect(numberedRows(m).map(label)).toEqual(["apple", "zebra", "loose.md"]);
  });

  it("falls back to the top level when the scoped folder disappears", () => {
    const m = nested();
    present(m, { kind: "jumped", index: 0 });
    present(m, { kind: "folderDeleted", path: "apple" });
    // Not stranded pointing at nothing.
    expect(numberedRows(m).map(label)).toEqual(["zebra", "loose.md"]);
  });

  it("drops the scope when the view changes", () => {
    const m = nested();
    present(m, { kind: "jumped", index: 0 });
    present(m, { kind: "modeChanged", mode: "dump" });
    expect(m.numberScope).toBeNull();
  });
});
