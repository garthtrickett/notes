import { describe, expect, it } from "bun:test";
import { describeProblem, normalizePath, pathProblem, isTrashPath, isArchivePath, isFiledPath, filedPath, unfiledPath, uniquePath, TRASH } from "./paths.ts";
import { createModel, present } from "./model.ts";

describe("normalizePath", () => {
  it("defaults the extension", () => {
    expect(normalizePath("inbox/idea")).toBe("inbox/idea.md");
  });

  it("leaves an existing extension alone", () => {
    expect(normalizePath("attachments/a.webp")).toBe("attachments/a.webp");
  });

  it("tidies slashes", () => {
    expect(normalizePath("  /inbox//idea/ ")).toBe("inbox/idea.md");
  });

  it("is empty for nothing", () => {
    expect(normalizePath("   ")).toBe("");
  });

  it("only looks at the last segment for the extension", () => {
    expect(normalizePath("v1.2/idea")).toBe("v1.2/idea.md");
  });
});

describe("pathProblem", () => {
  const existing = ["inbox/a.md", "reference/b.md", "notes.md"];

  it("accepts a fresh path", () => {
    expect(pathProblem("inbox/new.md", existing)).toBeNull();
  });

  it("refuses an empty name", () => {
    expect(pathProblem("", existing)).toEqual({ kind: "empty" });
  });

  it("refuses a duplicate", () => {
    expect(pathProblem("inbox/a.md", existing)).toEqual({ kind: "exists" });
  });

  it("refuses a name that is already a folder — the trap this exists for", () => {
    // git cannot hold a file `inbox` and a directory `inbox/` at once.
    expect(pathProblem("inbox", existing)).toEqual({
      kind: "isFolder",
      folder: "inbox",
    });
  });

  it("refuses putting something inside an existing note", () => {
    expect(pathProblem("notes.md/child.md", existing)).toEqual({
      kind: "underFile",
      file: "notes.md",
    });
  });

  it("refuses traversal", () => {
    expect(pathProblem("../escape.md", existing)).toEqual({ kind: "unsafe" });
    expect(pathProblem("a/./b.md", existing)).toEqual({ kind: "unsafe" });
  });

  it("allows a deeper folder that does not clash", () => {
    expect(pathProblem("inbox/deep/c.md", existing)).toBeNull();
  });
});

describe("describeProblem", () => {
  it("explains the folder clash in terms of what to do instead", () => {
    const message = describeProblem(
      { kind: "isFolder", folder: "inbox" },
      "inbox",
    );
    expect(message).toContain("folder");
    expect(message).toContain("inbox/a-name.md");
  });

  it("names the note that is in the way", () => {
    expect(
      describeProblem({ kind: "underFile", file: "notes.md" }, "notes.md/x.md"),
    ).toContain("notes.md");
  });
});

describe("in the app", () => {
  const model = () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [] });
    return m;
  };

  it("appends .md so a bare name cannot become a folder clash later", () => {
    const m = model();
    present(m, { kind: "created", path: "inbox/idea" });
    expect(m.notes.has("inbox/idea.md")).toBe(true);
    expect(m.openPath).toBe("inbox/idea.md");
  });

  it("refuses a note named after an existing folder, and says why", () => {
    // This is the case that actually happened: a note called `inbox` alongside
    // `inbox/…`, which git cannot represent, producing a conflict copy.
    const m = model();
    present(m, { kind: "created", path: "inbox/a.md" });
    present(m, { kind: "created", path: "inbox" });

    expect(m.notes.has("inbox")).toBe(false);
    expect(m.notes.has("inbox.md")).toBe(true); // normalized, so no clash at all
  });

  it("refuses a folder name that would collide once normalization is off", () => {
    const m = model();
    present(m, { kind: "created", path: "inbox/a.md" });
    present(m, { kind: "created", path: "inbox/b" });
    // inbox/b.md is fine; the clash test is about `inbox` itself.
    expect(m.notes.has("inbox/b.md")).toBe(true);

    present(m, { kind: "created", path: "inbox.md" });
    present(m, { kind: "created", path: "inbox.md/child.md" });
    expect(m.notes.has("inbox.md/child.md")).toBe(false);
    expect(m.error).toContain("nothing can live inside it");
  });

  it("explains a duplicate instead of failing silently", () => {
    const m = model();
    present(m, { kind: "created", path: "a.md" });
    present(m, { kind: "created", path: "a.md" });
    expect(m.error).toContain("already exists");
  });

  it("clears the message once a good path is used", () => {
    const m = model();
    present(m, { kind: "created", path: "a.md" });
    present(m, { kind: "created", path: "a.md" });
    expect(m.error).not.toBeNull();
    present(m, { kind: "created", path: "b.md" });
    expect(m.error).toBeNull();
  });

  it("normalization dissolves the folder clash rather than refusing it", () => {
    const m = model();
    present(m, { kind: "created", path: "ref/keep.md" });
    present(m, { kind: "created", path: "target.md" });
    present(m, { kind: "renamed", from: "target.md", to: "ref" });

    // `ref` becomes `ref.md`, which sits happily beside the `ref/` folder. The
    // original trap needed an extensionless file, and there is no longer a way
    // to make one.
    expect(m.notes.has("ref.md")).toBe(true);
    expect(m.notes.has("ref")).toBe(false);
    expect(m.error).toBeNull();
  });

  it("refuses a rename onto a real folder without touching any links", () => {
    const m = model();
    // A folder can still be named like a file if a note was made inside it.
    present(m, { kind: "created", path: "ref.md/inside.md" });
    present(m, { kind: "created", path: "target.md" });
    present(m, { kind: "edited", path: "ref.md/inside.md", body: "[[target]]" });
    present(m, { kind: "renamed", from: "target.md", to: "ref.md" });

    // Nothing half-applied: checked before a single link was rewritten.
    expect(m.notes.get("ref.md/inside.md")?.body).toBe("[[target]]");
    expect(m.notes.get("target.md")?.deleted).toBe(false);
    expect(m.error).toContain("folder");
  });

  it("normalizes a rename target too", () => {
    const m = model();
    present(m, { kind: "created", path: "a.md" });
    present(m, { kind: "renamed", from: "a.md", to: "reference/renamed" });
    expect(m.notes.has("reference/renamed.md")).toBe(true);
  });
});

describe("the trash and the archive", () => {
  it("recognises what is filed and what is not", () => {
    expect(isTrashPath(".trash/a.md")).toBe(true);
    expect(isArchivePath(".archive/deep/a.md")).toBe(true);
    expect(isFiledPath("a.md")).toBe(false);
    // A note whose name merely starts the same way is not in the bin.
    expect(isTrashPath(".trashcan/a.md")).toBe(false);
  });

  it("keeps the whole path, so restoring is the prefix removed", () => {
    expect(filedPath(TRASH, "folder/a.md")).toBe(".trash/folder/a.md");
    expect(unfiledPath(".trash/folder/a.md")).toBe("folder/a.md");
    expect(unfiledPath(".archive/a.md")).toBe("a.md");
    // Idempotent on something that was never filed.
    expect(unfiledPath("a.md")).toBe("a.md");
  });

  it("numbers around a name that is taken", () => {
    const taken = new Set([".trash/a.md", ".trash/a (2).md"]);
    expect(uniquePath(".trash/a.md", (c) => taken.has(c))).toBe(".trash/a (3).md");
    expect(uniquePath(".trash/b.md", (c) => taken.has(c))).toBe(".trash/b.md");
  });

  it("numbers a name with a dot in its folder but not its file", () => {
    expect(uniquePath(".trash/notes/readme", () => true).startsWith(".trash/notes/readme (")).toBe(true);
  });
});
