import { describe, expect, it } from "bun:test";
import {
  backlinksTo,
  basenameOf,
  extractLinks,
  resolveLink,
  rewriteLinks,
  searchNotes,
} from "./links.ts";
import type { Note } from "./model.ts";

const note = (path: string, body = ""): Note => ({
  path,
  body,
  baseSha: "s",
  pending: false,
  deleted: false,
  dirty: false,
  encoding: "utf8",
});

const mapOf = (...notes: Note[]) => new Map(notes.map((n) => [n.path, n]));

describe("extractLinks", () => {
  it("finds several links", () => {
    expect(extractLinks("see [[a]] and [[b/c]]")).toEqual(["a", "b/c"]);
  });

  it("collapses duplicates", () => {
    expect(extractLinks("[[a]] then [[a]] again")).toEqual(["a"]);
  });

  it("trims whitespace inside the brackets", () => {
    expect(extractLinks("[[ spaced ]]")).toEqual(["spaced"]);
  });

  it("ignores an unclosed link", () => {
    expect(extractLinks("[[unterminated")).toEqual([]);
  });

  it("does not span a newline", () => {
    expect(extractLinks("[[a\nb]]")).toEqual([]);
  });

  it("finds links inside code fences too — a known limitation, not an accident", () => {
    // Skipping them would need a real parser. Writing a wikilink inside a fence
    // and expecting it inert is rare enough to accept, and it is written down.
    expect(extractLinks("```\n[[a]]\n```")).toEqual(["a"]);
  });
});

describe("resolveLink", () => {
  const notes = mapOf(note("reference/japanese-grammar.md"), note("inbox/a.md"));

  it("matches on basename wherever the note sits", () => {
    expect(resolveLink("japanese-grammar", notes)).toEqual({
      kind: "found",
      path: "reference/japanese-grammar.md",
    });
  });

  it("accepts a full path", () => {
    expect(resolveLink("reference/japanese-grammar.md", notes)).toEqual({
      kind: "found",
      path: "reference/japanese-grammar.md",
    });
  });

  it("reports a link to a note that does not exist", () => {
    expect(resolveLink("nothing", notes)).toEqual({ kind: "missing" });
  });

  it("reports ambiguity rather than guessing", () => {
    const clashing = mapOf(note("one/a.md"), note("two/a.md"));
    expect(resolveLink("a", clashing)).toEqual({
      kind: "ambiguous",
      paths: ["one/a.md", "two/a.md"],
    });
  });

  it("does not resolve to a tombstone", () => {
    const deleted = new Map([["a.md", { ...note("a.md"), deleted: true }]]);
    expect(resolveLink("a", deleted)).toEqual({ kind: "missing" });
  });
});

describe("backlinksTo", () => {
  it("finds every referrer and nothing else", () => {
    const notes = mapOf(
      note("target.md"),
      note("one.md", "links to [[target]]"),
      note("two.md", "also [[target]] here"),
      note("three.md", "unrelated"),
    );
    expect(backlinksTo("target.md", notes)).toEqual(["one.md", "two.md"]);
  });

  it("does not count a note linking to itself", () => {
    const notes = mapOf(note("a.md", "[[a]]"));
    expect(backlinksTo("a.md", notes)).toEqual([]);
  });

  it("matches a referrer that used the full path", () => {
    const notes = mapOf(
      note("ref/a.md"),
      note("b.md", "see [[ref/a.md]]"),
    );
    expect(backlinksTo("ref/a.md", notes)).toEqual(["b.md"]);
  });
});

describe("rewriteLinks", () => {
  it("rewrites the whole link", () => {
    expect(rewriteLinks("see [[old]] here", "old.md", "new.md")).toBe(
      "see [[new]] here",
    );
  });

  it("leaves a longer name that merely starts the same", () => {
    // A prefix replace would turn [[older]] into [[newer]]. It must not.
    expect(rewriteLinks("[[older]] and [[old]]", "old.md", "new.md")).toBe(
      "[[older]] and [[new]]",
    );
  });

  it("rewrites a referrer that used the full path", () => {
    expect(rewriteLinks("[[ref/old.md]]", "ref/old.md", "ref/new.md")).toBe(
      "[[new]]",
    );
  });

  it("leaves a body with no links untouched", () => {
    expect(rewriteLinks("nothing here", "old.md", "new.md")).toBe("nothing here");
  });
});

describe("searchNotes", () => {
  const notes = [note("inbox/shopping.md", "milk and eggs"), note("ref/a.md", "grammar")];

  it("matches the body, case-insensitively", () => {
    expect(searchNotes(notes, "MILK").map((n) => n.path)).toEqual([
      "inbox/shopping.md",
    ]);
  });

  it("matches the path too", () => {
    expect(searchNotes(notes, "ref/").map((n) => n.path)).toEqual(["ref/a.md"]);
  });

  it("returns nothing for an empty query", () => {
    expect(searchNotes(notes, "   ")).toEqual([]);
  });
});

describe("basenameOf", () => {
  it("strips folders and the extension", () => {
    expect(basenameOf("a/b/c.md")).toBe("c");
    expect(basenameOf("c")).toBe("c");
  });
});
