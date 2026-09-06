import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
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

describe("the sanitizer, adversarially", () => {
  // These are the vectors an audit found. The suite previously covered only
  // HTML-namespace cases — the ones that already passed — which is the shape of
  // a test suite that agrees with its implementation instead of attacking it.
  const render = (source: string): string => {
    const el = document.createElement("div");
    el.append(renderMarkdown(source, document));
    return el.innerHTML;
  };
  const inert = (source: string) => {
    const html = render(source);
    // Rendered as text, so no element exists to carry a URL or a handler.
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<math");
    expect(html).not.toContain("<script");
    return html;
  };

  it("neutralises xlink:href, which never reached the URL check", () => {
    // attr.name is the qualified name, so allowlisting "href" and "src" skipped
    // it entirely — and browsers honour xlink:href on an SVG anchor.
    inert('<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>');
  });

  it("neutralises SMIL, which rewrites href after sanitising", () => {
    inert('<svg><a><animate attributeName="href" values="javascript:alert(1)"/></a></svg>');
  });

  it("neutralises <svg><script>, whose tagName is lowercase", () => {
    inert("<svg><script>alert(1)</script></svg>");
  });

  it("neutralises MathML", () => {
    inert('<math><maction actiontype="statusline" xlink:href="javascript:alert(1)">x</maction></math>');
  });

  it("neutralises srcset, which would leak that a note was opened", () => {
    // The URL survives as escaped text, which fetches nothing. What matters is
    // that no element exists to carry it.
    const html = render('<img srcset="https://evil.example/leak.png 1x">');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("strips srcset from an element markdown could produce", () => {
    const template = document.createElement("template");
    template.innerHTML = '<img src="https://x/a.png" srcset="https://evil/leak.png 1x">';
    sanitize(template.content);
    expect(template.innerHTML).toBe('<img src="https://x/a.png">');
  });

  it("still strips a javascript: link markdown itself produced", () => {
    // Raw HTML is escaped, but this is an ordinary link as far as the parser is
    // concerned, so the second layer has to catch it.
    expect(render("[x](javascript:alert(1))")).toContain("<a>x</a>");
  });

  it("leaves ordinary markdown alone", () => {
    expect(render("# Hello\n\n**bold**")).toContain("<h1>Hello</h1>");
    expect(render("![](https://example.com/a.png)")).toContain(
      'src="https://example.com/a.png"',
    );
    // A code fence still shows its angle brackets rather than eating them.
    expect(render("```\n<div>ok</div>\n```")).toContain("&lt;div&gt;ok&lt;/div&gt;");
  });
});

// The editor is CodeMirror, so its text lives in an EditorState rather than on
// an element. Everything below asks it the same two questions a textarea was
// asked before: what does it hold, and where is the caret.
const editorView = (): EditorView | null => {
  const host = root.querySelector<HTMLElement>("#editor-host");
  return host === null ? null : EditorView.findFromDOM(host);
};
const editorText = (): string => editorView()?.state.doc.toString() ?? "";
const caretAt = (): number => editorView()?.state.selection.main.head ?? -1;
const putCaret = (at: number): void => {
  editorView()?.dispatch({ selection: EditorSelection.cursor(at) });
};

describe("preview and search in the app", () => {
  it("toggles between the editor and rendered markdown", async () => {
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("a.md", "# Heading")] });
    await settle(loop);
    expect(root.querySelector("#editor-host")).not.toBeNull();
    expect(root.querySelector(".preview h1")).toBeNull();

    loop.propose({ kind: "previewToggled" });
    await settle(loop);
    expect(root.querySelector("#editor-host")).toBeNull();
    expect(root.querySelector(".preview h1")?.textContent).toBe("Heading");
  });

  it("restores the editor's text when preview is switched off", async () => {
    // Leaving preview re-creates the host, and the editor has to be reattached
    // and refilled — otherwise toggling preview silently blanks the note.
    const loop = await boot(deps(), root);
    loop.propose({ kind: "hydrated", notes: [note("a.md", "important text")] });
    await settle(loop);
    loop.propose({ kind: "previewToggled" });
    await settle(loop);
    loop.propose({ kind: "previewToggled" });
    await settle(loop);

    expect(editorText()).toBe("important text");
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

  it("finds notes through the palette, which replaced the sidebar search", async () => {
    const loop = await boot(deps(), root);
    loop.propose({
      kind: "hydrated",
      notes: [note("inbox/shopping.md", "milk"), note("ref/a.md", "grammar")],
    });
    await settle(loop);
    expect(root.querySelector(".palette")).toBeNull();

    loop.propose({ kind: "modalOpened", modal: { kind: "open" } });
    loop.propose({ kind: "searched", query: "milk" });
    await settle(loop);

    const results = root.querySelectorAll(".palette .results .path");
    expect([...results].map((n) => n.textContent)).toEqual(["inbox/shopping.md"]);
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
        remaining: 0,
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
      remaining: 0,
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

describe("the caret when a change lands elsewhere in the note", () => {
  it("stays put when a rename rewrites a link far above it", async () => {
    const loop = await boot(deps(), root);
    loop.propose({
      kind: "hydrated",
      notes: [note("a.md", "[[older]] intro\n\nI am typing down here."), note("older.md")],
    });
    loop.propose({ kind: "opened", path: "a.md" });
    await settle(loop);

    const caret = editorText().length - "down here.".length;
    putCaret(caret);

    // The rewrite shortens text above the caret. CodeMirror maps the selection
    // through the change; a whole-document replacement would not.
    loop.propose({ kind: "renamed", from: "older.md", to: "new.md" });
    await settle(loop);

    expect(editorText()).toContain("[[new]] intro");
    const shortenedBy = "older".length - "new".length;
    expect(caretAt()).toBe(caret - shortenedBy);
  });
});
