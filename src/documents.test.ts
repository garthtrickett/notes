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
  encoding: "utf8" as const,
  ...extra,
});

let db: IDBDatabase | undefined;
let root: HTMLElement;

const deps = (): Deps => ({
  db: db as IDBDatabase,
  github: null,
  shrink: async () => new ArrayBuffer(0),
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

describe("the editor when the model changes underneath it", () => {
  // note() is defined at the top of this file.
  const focusEditor = (): HTMLTextAreaElement => {
    const editor = root.querySelector<HTMLTextAreaElement>("#editor");
    if (!editor) throw new Error("no editor");
    editor.focus();
    return editor;
  };

  it("shows a pasted image reference straight away", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("a.md", "look: ")] });
    await settle(loop);
    const editor = focusEditor();
    editor.setSelectionRange(6, 6);

    loop.propose({
      kind: "attached",
      path: "attachments/x.webp",
      base64: "AAAA",
      into: "a.md",
      body: "look: ![](attachments/x.webp)",
    });
    await settle(loop);

    // Previously this only appeared after toggling preview and back, because the
    // textarea is uncontrolled and nothing had replaced the element.
    expect(editor.value).toBe("look: ![](attachments/x.webp)");
  });

  it("puts the caret after the text that was inserted", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("a.md", "ab")] });
    await settle(loop);
    const editor = focusEditor();
    editor.setSelectionRange(1, 1);

    loop.propose({ kind: "edited", path: "a.md", body: "a-INSERTED-b" });
    await settle(loop);

    expect(editor.value).toBe("a-INSERTED-b");
    expect(editor.selectionStart).toBe(1 + "-INSERTED-".length);
  });

  it("leaves the caret alone when the change is after it", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("a.md", "abc")] });
    await settle(loop);
    const editor = focusEditor();
    editor.setSelectionRange(1, 1);

    loop.propose({ kind: "edited", path: "a.md", body: "abcTAIL" });
    await settle(loop);

    expect(editor.selectionStart).toBe(1);
  });

  it("shows a remote change to the open note without a reload", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("a.md", "mine")] });
    await settle(loop);
    const editor = focusEditor();

    loop.propose({
      kind: "pulled",
      notes: [{ ...note("a.md", "theirs"), baseSha: "sha-9" }],
      gone: [],
    });
    await settle(loop);

    expect(editor.value).toBe("theirs");
  });

  it("shows links rewritten by a rename of another note", async () => {
    const loop = await boot(deps(), root);
    loop.propose({
      kind: "hydrated",
      notes: [note("a.md", "see [[old]]"), note("old.md", "")],
    });
    loop.propose({ kind: "opened", path: "a.md" });
    await settle(loop);
    const editor = focusEditor();

    loop.propose({ kind: "renamed", from: "old.md", to: "new.md" });
    await settle(loop);

    expect(editor.value).toBe("see [[new]]");
  });

  it("does not disturb the caret while typing", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("a.md", "")] });
    await settle(loop);
    const editor = focusEditor();

    // Typing means the DOM already holds the text; the model catches up. Nothing
    // should be written back over a live field.
    editor.value = "hello";
    editor.setSelectionRange(5, 5);
    loop.propose({ kind: "edited", path: "a.md", body: "hello" });
    await settle(loop);

    expect(editor.value).toBe("hello");
    expect(editor.selectionStart).toBe(5);
  });
});

describe("the preview does not thrash the DOM", () => {
  // Scoped to the preview, not the whole app: a pull that adds a note is
  // *supposed* to add a row to the tree. The claim here is only that the
  // rendered note is left alone.
  const churn = async (loop: Loop, act: () => void) => {
    const watched = root.querySelector(".preview");
    if (!watched) throw new Error("not in preview");
    let removed = 0;
    let added = 0;
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        removed += r.removedNodes.length;
        added += r.addedNodes.length;
      }
    });
    observer.observe(watched, { childList: true, subtree: true });
    act();
    await settle(loop);
    observer.disconnect();
    return { removed, added };
  };

  const inPreview = async () => {
    const loop = await boot(deps(), root);
    loop.propose({
      kind: "hydrated",
      notes: [note("a.md", "# Title\n\nSome text with [[b]].\n"), note("b.md", "")],
    });
    loop.propose({ kind: "previewToggled" });
    await settle(loop);
    return loop;
  };

  it("touches nothing when a proposal changes nothing it renders", async () => {
    const loop = await inPreview();
    // A sync fires several proposals. Rebuilding the preview on each is the
    // flash: images are re-decoded every time.
    const churned = await churn(loop, () => loop.propose({ kind: "resumed" }));
    expect(churned).toEqual({ removed: 0, added: 0 });
  });

  it("touches nothing when an unrelated note arrives from a pull", async () => {
    const loop = await inPreview();
    const churned = await churn(loop, () =>
      loop.propose({
        kind: "pulled",
        notes: [{ ...note("elsewhere.md", "theirs"), baseSha: "s2" }],
        gone: [],
      }),
    );
    expect(churned).toEqual({ removed: 0, added: 0 });
  });

  it("does rebuild when the note itself changes", async () => {
    const loop = await inPreview();
    const churned = await churn(loop, () =>
      loop.propose({ kind: "edited", path: "a.md", body: "# Different\n" }),
    );
    expect(churned.added).toBeGreaterThan(0);
  });

  it("rebuilds when a link's target appears, since it should stop looking broken", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("a.md", "see [[ghost]]")] });
    loop.propose({ kind: "previewToggled" });
    await settle(loop);
    expect(root.querySelector("a.unresolved")).not.toBeNull();

    // The body did not change, but what it means did.
    loop.propose({
      kind: "pulled",
      notes: [{ ...note("ghost.md", ""), baseSha: "s2" }],
      gone: [],
    });
    await settle(loop);
    expect(root.querySelector("a.unresolved")).toBeNull();
  });

  it("follows a link through the delegated handler", async () => {
    const loop = await inPreview();
    const link = root.querySelector<HTMLAnchorElement>("a[data-note]");
    expect(link).not.toBeNull();
    link!.click();
    await settle(loop);
    expect(loop.model.openPath).toBe("b.md");
  });

  it("offers to create a note that does not exist yet", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("a.md", "see [[ghost]]")] });
    loop.propose({ kind: "previewToggled" });
    await settle(loop);

    root.querySelector<HTMLAnchorElement>("a[data-note]")!.click();
    await settle(loop);
    expect(loop.model.notes.has("ghost.md")).toBe(true);
  });
});
