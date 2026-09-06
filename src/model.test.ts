import type { TreeNode } from "./tree.ts";
import { dropTarget } from "./paths.ts";
import { describe, expect, it } from "bun:test";
import { createModel, present, type Model, type Note, noteTree, numberedRows, openable, filedIn, dragLanding, orphanAttachments } from "./model.ts";

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
    // Gone from the tree, but in the bin rather than gone from the vault.
    expect(openable(m).map((n) => n.path)).toEqual(["keep.md"]);
    expect(filedIn(m, ".trash").map((n) => n.path)).toEqual([
      ".trash/examples/deep/two.md",
      ".trash/examples/one.md",
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

describe("present — the bin and the archive", () => {
  it("moves a deleted note into the bin rather than out of the vault", () => {
    const m = hydrated(note("a.md", "precious"), note("b.md"));
    present(m, { kind: "deleted", path: "a.md" });
    expect(openable(m).map((n) => n.path)).toEqual(["b.md"]);
    // Still in the repo, so it is in the bin on every device and not just this
    // one.
    expect(filedIn(m, ".trash").map((n) => n.path)).toEqual([".trash/a.md"]);
    expect(m.notes.get(".trash/a.md")?.body).toBe("precious");
  });

  it("restores a note to where it came from", () => {
    const m = hydrated(note("folder/a.md", "text"));
    present(m, { kind: "deleted", path: "folder/a.md" });
    present(m, { kind: "restored", path: ".trash/folder/a.md" });
    expect(openable(m).map((n) => n.path)).toEqual(["folder/a.md"]);
    expect(m.notes.get("folder/a.md")?.body).toBe("text");
  });

  it("deletes for good from the bin", () => {
    const m = hydrated(note("a.md"));
    present(m, { kind: "deleted", path: "a.md" });
    present(m, { kind: "deleted", path: ".trash/a.md" });
    expect(filedIn(m, ".trash")).toEqual([]);
    // It never reached GitHub under its trash path, so there is nothing to tell
    // GitHub about and the record simply goes.
    expect(m.notes.get(".trash/a.md")).toBeUndefined();
  });

  it("numbers around a name already in the bin", () => {
    const m = hydrated(note("a.md", "first"));
    present(m, { kind: "deleted", path: "a.md" });
    present(m, { kind: "created", path: "a.md" });
    present(m, { kind: "deleted", path: "a.md" });
    expect(filedIn(m, ".trash").map((n) => n.path)).toEqual([
      ".trash/a (2).md",
      ".trash/a.md",
    ]);
  });

  it("archives and unarchives", () => {
    const m = hydrated(note("a.md", "keep"), note("b.md"));
    present(m, { kind: "archived", path: "a.md" });
    expect(openable(m).map((n) => n.path)).toEqual(["b.md"]);
    expect(filedIn(m, ".archive").map((n) => n.path)).toEqual([".archive/a.md"]);
    present(m, { kind: "restored", path: ".archive/a.md" });
    expect(openable(m).map((n) => n.path)).toEqual(["a.md", "b.md"]);
  });

  it("does not follow the note into the bin", () => {
    const m = hydrated(note("a.md"), note("b.md"));
    present(m, { kind: "opened", path: "a.md" });
    present(m, { kind: "deleted", path: "a.md" });
    // Opening the bin because you deleted something would be a strange place to
    // be left standing.
    expect(m.openPath).toBe("b.md");
  });

  it("keeps filed notes out of the palette and the number shortcuts", () => {
    const m = hydrated(note("a.md"), note("b.md"));
    present(m, { kind: "deleted", path: "a.md" });
    expect(numberedRows(m).map(label)).toEqual(["b.md"]);
  });

  it("refuses to archive something already filed", () => {
    const m = hydrated(note("a.md"));
    present(m, { kind: "deleted", path: "a.md" });
    present(m, { kind: "archived", path: ".trash/a.md" });
    expect(filedIn(m, ".archive")).toEqual([]);
  });

  it("refuses to restore something that was never filed", () => {
    const m = hydrated(note("a.md"));
    // present returns the rejection; it is the loop that shows it.
    expect(present(m, { kind: "restored", path: "a.md" })).not.toBeNull();
    expect(openable(m).map((n) => n.path)).toEqual(["a.md"]);
  });
});

describe("present — moving things about", () => {
  it("moves a folder and everything under it", () => {
    const m = hydrated(
      note("apple/one.md"),
      note("apple/deep/two.md"),
      note("zebra/keep.md"),
    );
    present(m, { kind: "folderMoved", from: "apple", to: "zebra/apple" });
    expect(openable(m).map((n) => n.path).sort()).toEqual([
      "zebra/apple/deep/two.md",
      "zebra/apple/one.md",
      "zebra/keep.md",
    ]);
  });

  it("keeps an open folder open where it lands", () => {
    const m = hydrated(note("apple/one.md"), note("zebra/keep.md"));
    present(m, { kind: "folderToggled", path: "apple" });
    present(m, { kind: "folderMoved", from: "apple", to: "zebra/apple" });
    expect(m.expanded.has("zebra/apple")).toBe(true);
    expect(m.expanded.has("apple")).toBe(false);
  });

  it("refuses to move a folder inside itself", () => {
    const m = hydrated(note("apple/one.md"));
    expect(
      present(m, { kind: "folderMoved", from: "apple", to: "apple/inner" }),
    ).not.toBeNull();
    expect(openable(m).map((n) => n.path)).toEqual(["apple/one.md"]);
  });

  it("carries the open note with a folder move", () => {
    const m = hydrated(note("apple/one.md"), note("zebra/keep.md"));
    present(m, { kind: "opened", path: "apple/one.md" });
    present(m, { kind: "folderMoved", from: "apple", to: "zebra/apple" });
    expect(m.openPath).toBe("zebra/apple/one.md");
  });
});

describe("where a dragged row lands", () => {
  it("puts a note inside the folder it was dropped on", () => {
    expect(dropTarget("a.md", "apple")).toBe("apple/a.md");
    expect(dropTarget("apple/a.md", "zebra")).toBe("zebra/a.md");
  });

  it("puts it at the root when dropped on nothing", () => {
    expect(dropTarget("apple/a.md", null)).toBe("a.md");
  });

  it("does nothing when it would not move", () => {
    expect(dropTarget("apple/a.md", "apple")).toBeNull();
    expect(dropTarget("a.md", null)).toBeNull();
  });

  it("refuses to put a folder inside itself or its own child", () => {
    expect(dropTarget("apple", "apple")).toBeNull();
    expect(dropTarget("apple", "apple/deep")).toBeNull();
    // Somewhere else is fine.
    expect(dropTarget("apple", "zebra")).toBe("zebra/apple");
  });
});

describe("present — version history", () => {
  const rev = (sha: string) => ({
    sha,
    when: "2026-09-06T10:00:00Z",
    message: "notes: a.md",
    author: "someone",
  });

  it("opens a panel that has not fetched anything yet", () => {
    const m = hydrated(note("a.md"));
    present(m, { kind: "historyOpened", path: "a.md" });
    expect(m.modal?.kind).toBe("history");
    // null, not [] — "not asked yet" is a different thing from "no history".
    expect(m.history?.revisions).toBeNull();
  });

  it("refuses history for something that is not an openable note", () => {
    const m = hydrated(note("a.md"));
    present(m, { kind: "deleted", path: "a.md" });
    expect(present(m, { kind: "historyOpened", path: ".trash/a.md" })).not.toBeNull();
  });

  it("drops an answer that arrives for a note nobody is looking at", () => {
    const m = hydrated(note("a.md"), note("b.md"));
    present(m, { kind: "historyOpened", path: "a.md" });
    present(m, { kind: "historyLoaded", path: "b.md", revisions: [rev("x")] });
    expect(m.history?.revisions).toBeNull();
  });

  it("shows a failure in the panel rather than as an error banner", () => {
    const m = hydrated(note("a.md"));
    present(m, { kind: "historyOpened", path: "a.md" });
    present(m, { kind: "historyFailed", path: "a.md", reason: "No history while offline." });
    expect(m.history?.error).toBe("No history while offline.");
    expect(m.error).toBeNull();
  });

  it("restores a version as a new edit rather than a rewrite", () => {
    const m = hydrated(note("a.md", "current"));
    present(m, { kind: "historyOpened", path: "a.md" });
    present(m, { kind: "historyLoaded", path: "a.md", revisions: [rev("old")] });
    present(m, { kind: "revisionOpened", sha: "old" });
    present(m, { kind: "revisionLoaded", sha: "old", body: "the old text" });
    present(m, { kind: "revisionRestored" });
    expect(m.notes.get("a.md")?.body).toBe("the old text");
    expect(m.notes.get("a.md")?.dirty).toBe(true);
    // The panel closes; nothing is left holding a stale body.
    expect(m.history).toBeNull();
    expect(m.modal).toBeNull();
  });

  it("ignores a body that arrives for a version no longer selected", () => {
    const m = hydrated(note("a.md"));
    present(m, { kind: "historyOpened", path: "a.md" });
    present(m, { kind: "revisionOpened", sha: "one" });
    present(m, { kind: "revisionOpened", sha: "two" });
    present(m, { kind: "revisionLoaded", sha: "one", body: "stale" });
    expect(m.history?.viewingBody).toBeNull();
  });

  it("forgets the history when the panel closes", () => {
    const m = hydrated(note("a.md"));
    present(m, { kind: "historyOpened", path: "a.md" });
    present(m, { kind: "modalClosed" });
    expect(m.history).toBeNull();
  });

  it("refuses to restore with nothing selected", () => {
    const m = hydrated(note("a.md", "current"));
    present(m, { kind: "historyOpened", path: "a.md" });
    expect(present(m, { kind: "revisionRestored" })).not.toBeNull();
    expect(m.notes.get("a.md")?.body).toBe("current");
  });
});

describe("present — a message about where you were", () => {
  const refused = () => {
    const m = hydrated(note("a.md"), note("b.md"));
    present(m, { kind: "opened", path: "a.md" });
    present(m, { kind: "renamed", from: "a.md", to: "b.md" });
    expect(m.error).toBe("b.md already exists.");
    return m;
  };

  it("clears when a dialog opens", () => {
    const m = refused();
    present(m, { kind: "modalOpened", modal: { kind: "open" } });
    expect(m.error).toBeNull();
  });

  it("clears when a dialog closes", () => {
    const m = refused();
    present(m, { kind: "modalOpened", modal: { kind: "open" } });
    present(m, { kind: "modalClosed" });
    expect(m.error).toBeNull();
  });

  it("clears when another note is opened", () => {
    const m = refused();
    present(m, { kind: "opened", path: "b.md" });
    expect(m.error).toBeNull();
  });

  it("clears when the view changes", () => {
    const m = refused();
    present(m, { kind: "modeChanged", mode: "dump" });
    expect(m.error).toBeNull();
  });
});

describe("present — a link that cannot be followed", () => {
  it("says why when two notes share a name", () => {
    const m = hydrated(note("one/dup.md"), note("two/dup.md"), note("a.md"));
    present(m, { kind: "linkRefused", target: "dup" });
    // A click that silently does nothing is how someone concludes the app is
    // broken.
    expect(m.error).toContain("More than one note is called dup");
  });

  it("says something even when the reason is not ambiguity", () => {
    const m = hydrated(note("a.md"));
    present(m, { kind: "linkRefused", target: "whatever" });
    expect(m.error).not.toBeNull();
  });
});

describe("present — a dialog closing must not eat a fresh refusal", () => {
  it("keeps the message the new-note dialog just produced", () => {
    const m = hydrated(note("target.md"));
    // What the dialog does: propose the create, then close itself.
    present(m, { kind: "created", path: "target.md/child" });
    expect(m.error).toContain("nothing can live inside it");
    present(m, { kind: "modalClosed" });
    // Clearing here made an unusable path just close the dialog with nothing
    // said at all.
    expect(m.error).toContain("nothing can live inside it");
  });
});

describe("present — the folders the app manages", () => {
  it("refuses to create a note inside the bin", () => {
    const m = hydrated(note("a.md"));
    // This used to succeed: the note went straight into the bin, invisible in
    // the tree, with nothing said. You typed a name and nothing happened.
    expect(present(m, { kind: "created", path: ".trash/sneaky" })).not.toBeNull();
    expect(m.error).toContain("a folder this app manages");
    expect(filedIn(m, ".trash")).toEqual([]);
  });

  it("refuses to rename a note into the archive", () => {
    const m = hydrated(note("a.md"));
    expect(
      present(m, { kind: "renamed", from: "a.md", to: ".archive/hidden.md" }),
    ).not.toBeNull();
    expect(openable(m).map((n) => n.path)).toEqual(["a.md"]);
  });

  it("still lets the app file things away itself", () => {
    const m = hydrated(note("a.md"));
    // `moved` is the primitive filing is built from, so it stays unguarded.
    present(m, { kind: "archived", path: "a.md" });
    expect(filedIn(m, ".archive").map((n) => n.path)).toEqual([".archive/a.md"]);
  });
});

describe("present — coming back online", () => {
  it("stops saying offline", () => {
    const m = hydrated(note("a.md"));
    present(m, { kind: "syncFailed", error: { kind: "offline" } });
    expect(m.syncError?.kind).toBe("offline");
    present(m, { kind: "online", online: true });
    // The banner used to go on claiming offline until some later sync happened
    // to succeed.
    expect(m.syncError).toBeNull();
  });

  it("leaves a message that is still true", () => {
    const m = hydrated(note("a.md"));
    present(m, { kind: "syncFailed", error: { kind: "auth" } });
    present(m, { kind: "online", online: true });
    // A rejected token is a rejected token whether or not there is a network.
    expect(m.syncError?.kind).toBe("auth");
  });
});

describe("present — a drag in progress", () => {
  const vault = () =>
    hydrated(note("apple/one.md"), note("loose.md"), note("zebra/two.md"));
  const paths = (m: ReturnType<typeof vault>) =>
    noteTree(m).flatMap(function walk(n): string[] {
      return n.kind === "folder" ? [n.path, ...n.children.flatMap(walk)] : [n.note.path];
    });

  it("shows the tree as it would be, before anything has happened", () => {
    const m = vault();
    present(m, { kind: "dragStarted", from: "loose.md", folder: false });
    present(m, { kind: "draggedOver", over: "apple" });
    // The row has moved under the pointer, so you can see where it lands.
    expect(paths(m)).toEqual(["apple", "apple/loose.md", "apple/one.md", "zebra", "zebra/two.md"]);
    // But nothing has actually moved.
    expect(m.notes.has("loose.md")).toBe(true);
    expect(m.notes.has("apple/loose.md")).toBe(false);
  });

  it("puts it back when the drag leaves everything droppable", () => {
    const m = vault();
    present(m, { kind: "dragStarted", from: "loose.md", folder: false });
    present(m, { kind: "draggedOver", over: "apple" });
    present(m, { kind: "draggedOver", over: undefined });
    expect(paths(m)).toEqual(["apple", "apple/one.md", "zebra", "zebra/two.md", "loose.md"]);
  });

  it("moves a folder's whole subtree in the preview", () => {
    const m = vault();
    present(m, { kind: "dragStarted", from: "apple", folder: true });
    present(m, { kind: "draggedOver", over: "zebra" });
    expect(paths(m)).toEqual([
      "zebra",
      "zebra/apple",
      "zebra/apple/one.md",
      "zebra/two.md",
      "loose.md",
    ]);
  });

  it("previews nothing for a drop that would do nothing", () => {
    const m = vault();
    present(m, { kind: "dragStarted", from: "apple", folder: true });
    present(m, { kind: "draggedOver", over: "apple" });
    expect(dragLanding(m)).toBeNull();
    expect(paths(m)).toEqual(["apple", "apple/one.md", "zebra", "zebra/two.md", "loose.md"]);
  });

  it("forgets the drag when it ends", () => {
    const m = vault();
    present(m, { kind: "dragStarted", from: "loose.md", folder: false });
    present(m, { kind: "draggedOver", over: "apple" });
    present(m, { kind: "dragEnded" });
    expect(m.drag).toBeNull();
    expect(paths(m)).toEqual(["apple", "apple/one.md", "zebra", "zebra/two.md", "loose.md"]);
  });
});

describe("present — attachments nothing points at", () => {
  const image = (path: string) =>
    note(path, "AAAA", false, { encoding: "base64" as const });

  const withImages = () =>
    hydrated(
      note("a.md", "text ![](attachments/used.webp) more"),
      note("b.md", "nothing here"),
      image("attachments/used.webp"),
      image("attachments/spare.webp"),
    );

  it("lists only the ones no note refers to", () => {
    expect(orphanAttachments(withImages()).map((n) => n.path)).toEqual([
      "attachments/spare.webp",
    ]);
  });

  it("counts a note in the bin as still referring to its pictures", () => {
    const m = withImages();
    present(m, { kind: "deleted", path: "a.md" });
    // Restoring that note should not find its image gone.
    expect(orphanAttachments(m).map((n) => n.path)).toEqual(["attachments/spare.webp"]);
  });

  it("stops listing one once a note points at it again", () => {
    const m = withImages();
    present(m, { kind: "edited", path: "b.md", body: "![](attachments/spare.webp)" });
    expect(orphanAttachments(m)).toEqual([]);
  });

  it("does not collect anything on its own", () => {
    const m = withImages();
    orphanAttachments(m);
    // Listing is not removing: an image is unreferenced for the second between
    // cutting a paragraph and pasting it back.
    expect(m.notes.get("attachments/spare.webp")?.deleted).toBe(false);
  });

  it("never lists one that is already in the bin", () => {
    const m = withImages();
    present(m, { kind: "deleted", path: "attachments/spare.webp" });
    expect(orphanAttachments(m)).toEqual([]);
  });
});
