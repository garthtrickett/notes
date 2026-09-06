import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { openDb } from "./idb.ts";
import { boot, type Deps, type Loop } from "./loop.ts";
import { createModel, present, visible, type Note } from "./model.ts";
import { renderMarkdown, sanitize, wikilinksToMarkdown } from "./render-markdown.ts";

const note = (path: string, body = "", extra: Partial<Note> = {}): Note => ({
  path,
  body,
  baseSha: "sha-0",
  pending: false,
  deleted: false,
  dirty: false,
  ...extra,
});

let db: IDBDatabase | undefined;
let root: HTMLElement;

const deps = (): Deps => ({
  db: db as IDBDatabase,
  github: null,
  now: () => 1_700_000_000_000,
  schedule: (_ms, fire) => void queueMicrotask(fire),
});

const settle = async (loop: Loop) => {
  await loop.flush();
  await new Promise<void>((r) => queueMicrotask(() => r()));
};

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
});

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("rename — the gate", () => {
  it("rewrites every inbound link, and syncs all of them", () => {
    const m = createModel();
    present(m, {
      kind: "hydrated",
      notes: [
        note("reference/grammar.md", "the note itself"),
        note("a.md", "see [[grammar]]"),
        note("b.md", "also [[grammar]] and [[grammar]] twice"),
        note("c.md", "mentions [[reference/grammar.md]] by path"),
        note("d.md", "nothing relevant"),
      ],
    });

    present(m, {
      kind: "renamed",
      from: "reference/grammar.md",
      to: "reference/japanese-grammar.md",
    });

    expect(m.notes.get("a.md")?.body).toBe("see [[japanese-grammar]]");
    expect(m.notes.get("b.md")?.body).toBe(
      "also [[japanese-grammar]] and [[japanese-grammar]] twice",
    );
    expect(m.notes.get("c.md")?.body).toBe("mentions [[japanese-grammar]] by path");
    expect(m.notes.get("d.md")?.body).toBe("nothing relevant");

    // Every rewritten note has to reach GitHub, or the links only move on this
    // device.
    for (const path of ["a.md", "b.md", "c.md"]) {
      expect(m.notes.get(path)?.pending).toBe(true);
      expect(m.notes.get(path)?.dirty).toBe(true);
    }
    expect(m.notes.get("d.md")?.pending).toBe(false);

    // And the note itself moved.
    expect(m.notes.get("reference/japanese-grammar.md")?.body).toBe(
      "the note itself",
    );
    expect(m.notes.get("reference/grammar.md")?.deleted).toBe(true);
    expect(m.openPath).toBe("reference/japanese-grammar.md");
  });

  it("leaves a similarly-named link alone", () => {
    const m = createModel();
    present(m, {
      kind: "hydrated",
      notes: [note("old.md"), note("a.md", "[[older]] and [[old]]")],
    });
    present(m, { kind: "renamed", from: "old.md", to: "new.md" });
    expect(m.notes.get("a.md")?.body).toBe("[[older]] and [[new]]");
  });

  it("rejects a rename onto an existing note without touching any links", () => {
    const m = createModel();
    present(m, {
      kind: "hydrated",
      notes: [note("a.md"), note("b.md"), note("c.md", "[[a]]")],
    });
    present(m, { kind: "renamed", from: "a.md", to: "b.md" });
    // Nothing half-applied: the links are untouched and the note is still there.
    expect(m.notes.get("c.md")?.body).toBe("[[a]]");
    expect(m.notes.get("c.md")?.pending).toBe(false);
    expect(m.notes.get("a.md")?.deleted).toBe(false);
  });

  it("moving between folders rewrites nothing, because links match on basename", () => {
    const m = createModel();
    present(m, {
      kind: "hydrated",
      notes: [note("inbox/a.md"), note("b.md", "[[a]]")],
    });
    present(m, { kind: "renamed", from: "inbox/a.md", to: "reference/a.md" });
    expect(m.notes.get("b.md")?.body).toBe("[[a]]");
    expect(m.notes.get("b.md")?.pending).toBe(false);
    expect(visible(m).map((n) => n.path).sort()).toEqual(["b.md", "reference/a.md"]);
  });
});

describe("markdown", () => {
  it("turns a wikilink into an ordinary link before parsing", () => {
    expect(wikilinksToMarkdown("see [[ref/a]] now")).toBe(
      "see [a](#note:ref%2Fa) now",
    );
  });

  it("renders headings, lists and code", () => {
    const fragment = renderMarkdown("# Title\n\n- one\n- two\n\n`code`", document);
    const el = document.createElement("div");
    el.append(fragment);
    expect(el.querySelector("h1")?.textContent).toBe("Title");
    expect(el.querySelectorAll("li").length).toBe(2);
    expect(el.querySelector("code")?.textContent).toBe("code");
  });
});

describe("the sanitizer", () => {
  const clean = (html: string): string => {
    const template = document.createElement("template");
    template.innerHTML = html;
    sanitize(template.content);
    return template.innerHTML;
  };

  it("drops a script tag", () => {
    expect(clean("<p>ok</p><script>alert(1)</script>")).toBe("<p>ok</p>");
  });

  it("drops an iframe and an object", () => {
    expect(clean("<iframe src='x'></iframe><object></object>")).toBe("");
  });

  it("strips an inline handler but keeps the element", () => {
    expect(clean('<img src="https://x/y.png" onerror="alert(1)">')).toBe(
      '<img src="https://x/y.png">',
    );
  });

  it("strips a javascript: href", () => {
    expect(clean('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
  });

  it("keeps ordinary links and anchors", () => {
    expect(clean('<a href="https://example.com">x</a>')).toBe(
      '<a href="https://example.com">x</a>',
    );
    expect(clean('<a href="#note:a">x</a>')).toBe('<a href="#note:a">x</a>');
  });
});

describe("preview and search in the app", () => {
  it("toggles between the editor and rendered markdown", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("a.md", "# Heading")] });
    await settle(loop);
    expect(root.querySelector("#editor")).not.toBeNull();
    expect(root.querySelector(".preview h1")).toBeNull();

    loop.propose({ kind: "previewToggled" });
    await settle(loop);
    expect(root.querySelector("#editor")).toBeNull();
    expect(root.querySelector(".preview h1")?.textContent).toBe("Heading");
  });

  it("restores the editor's text when preview is switched off", async () => {
    // The editor is uncontrolled, so a recreated textarea has to be refilled —
    // otherwise toggling preview silently blanks the note on screen.
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("a.md", "important text")] });
    await settle(loop);
    loop.propose({ kind: "previewToggled" });
    await settle(loop);
    loop.propose({ kind: "previewToggled" });
    await settle(loop);

    const editor = root.querySelector<HTMLTextAreaElement>("#editor");
    expect(editor?.value).toBe("important text");
  });

  it("shows backlinks for the open note", async () => {
    const loop = await boot(deps(), root);
    loop.propose({
      kind: "hydrated",
      notes: [note("target.md"), note("from-here.md", "[[target]]")],
    });
    loop.propose({ kind: "opened", path: "target.md" });
    await settle(loop);

    expect(root.querySelector(".backlinks")?.textContent).toContain("from-here.md");
  });

  it("replaces the tree with matches while searching", async () => {
    const loop = await boot(deps(), root);
    loop.propose({
      kind: "hydrated",
      notes: [note("inbox/shopping.md", "milk"), note("ref/a.md", "grammar")],
    });
    await settle(loop);
    expect(root.querySelector("nav ul.results")).toBeNull();

    loop.propose({ kind: "searched", query: "milk" });
    await settle(loop);
    const results = root.querySelectorAll("nav ul.results .path");
    expect([...results].map((n) => n.textContent)).toEqual(["inbox/shopping.md"]);
  });
});
