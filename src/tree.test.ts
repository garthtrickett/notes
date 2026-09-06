import { describe, expect, it } from "bun:test";
import { buildTree, type TreeNode } from "./tree.ts";
import type { Note } from "./model.ts";

const note = (path: string): Note => ({
  path,
  body: "",
  baseSha: "s",
  pending: false,
  deleted: false,
  dirty: false,
  encoding: "utf8",
});

const shape = (nodes: readonly TreeNode[]): unknown =>
  nodes.map((n) =>
    n.kind === "folder" ? { [n.name]: shape(n.children) } : n.name,
  );

describe("buildTree", () => {
  it("nests to arbitrary depth", () => {
    const tree = buildTree([note("projects/gafu/runtime/notes.md")]);
    expect(shape(tree)).toEqual([
      { projects: [{ gafu: [{ runtime: ["notes.md"] }] }] },
    ]);
  });

  it("puts folders before notes, each alphabetical", () => {
    const tree = buildTree([
      note("zeta.md"),
      note("alpha.md"),
      note("zoo/a.md"),
      note("apples/a.md"),
    ]);
    expect(shape(tree)).toEqual([
      { apples: ["a.md"] },
      { zoo: ["a.md"] },
      "alpha.md",
      "zeta.md",
    ]);
  });

  it("handles a note at the root", () => {
    expect(shape(buildTree([note("README.md")]))).toEqual(["README.md"]);
  });

  it("merges siblings into one folder rather than repeating it", () => {
    const tree = buildTree([note("inbox/a.md"), note("inbox/b.md")]);
    expect(shape(tree)).toEqual([{ inbox: ["a.md", "b.md"] }]);
  });

  it("gives folders their full path, not just their name", () => {
    const tree = buildTree([note("a/b/c.md")]);
    const a = tree[0];
    if (a?.kind !== "folder") throw new Error("expected a folder");
    const b = a.children[0];
    if (b?.kind !== "folder") throw new Error("expected a folder");
    expect(a.path).toBe("a");
    expect(b.path).toBe("a/b");
  });

  it("is empty for no notes", () => {
    expect(buildTree([])).toEqual([]);
  });
});
