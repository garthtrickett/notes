import { describe, expect, test } from "bun:test";
import { spansFor, wikilinkAt, type Span } from "./decorate";

const noImages = () => null;
const anyImage = (src: string) => `data:image/png;base64,${src}`;

const classesAt = (spans: Span[], text: string, needle: string): string[] => {
  const at = text.indexOf(needle);
  return spans
    .filter((s) => s.kind !== "line" && s.from <= at && s.to >= at + needle.length)
    .map((s) => (s.kind === "mark" ? s.class : "image"));
};

describe("spansFor", () => {
  test("gives each heading level its own line class", () => {
    for (const level of [1, 2, 3, 4, 5, 6]) {
      const doc = `${"#".repeat(level)} Title`;
      const spans = spansFor(doc, noImages);
      expect(spans).toContainEqual({ kind: "line", from: 0, class: `cm-md-h${level}` });
    }
  });

  test("dims the hashes without removing them", () => {
    const doc = "## Heading";
    const spans = spansFor(doc, noImages);
    // The marks must still cover the "##" — nothing is replaced, so the text
    // never reflows as the caret enters and leaves the line.
    expect(spans).toContainEqual({ kind: "mark", from: 0, to: 2, class: "cm-md-mark" });
  });

  test("styles bold and italic and their asterisks separately", () => {
    const doc = "a **bold** and *italic* here";
    const spans = spansFor(doc, noImages);
    expect(classesAt(spans, doc, "**bold**")).toContain("cm-md-strong");
    expect(classesAt(spans, doc, "*italic*")).toContain("cm-md-em");
    const marks = spans.filter((s) => s.kind === "mark" && s.class === "cm-md-mark");
    // One mark node per run of asterisks: `**` open, `**` close, `*` open, `*` close.
    expect(marks.length).toBe(4);
  });

  test("styles inline code and its backticks", () => {
    const doc = "call `run()` now";
    const spans = spansFor(doc, noImages);
    expect(classesAt(spans, doc, "`run()`")).toContain("cm-md-code");
    expect(spans.some((s) => s.kind === "mark" && s.class === "cm-md-mark")).toBe(true);
  });

  test("does not style markup inside a fenced block as prose", () => {
    const doc = "```\n**not bold**\n```";
    const spans = spansFor(doc, noImages);
    expect(spans.some((s) => s.kind === "mark" && s.class === "cm-md-strong")).toBe(false);
    expect(spans.some((s) => s.kind === "mark" && s.class === "cm-md-fence")).toBe(true);
  });

  test("styles a link's text and its url", () => {
    const doc = "see [docs](https://example.com) ok";
    const spans = spansFor(doc, noImages);
    expect(classesAt(spans, doc, "https://example.com")).toContain("cm-md-url");
    expect(classesAt(spans, doc, "[docs](https://example.com)")).toContain("cm-md-link");
  });

  test("replaces a resolvable image with one span over the whole markdown", () => {
    const doc = "before ![a cat](vault/img/cat.png) after";
    const spans = spansFor(doc, anyImage);
    const image = spans.find((s) => s.kind === "image");
    expect(image).toEqual({
      kind: "image",
      from: doc.indexOf("!["),
      to: doc.indexOf(") after") + 1,
      src: "data:image/png;base64,vault/img/cat.png",
      alt: "a cat",
      video: false,
    });
  });

  test("leaves an unresolvable image as visible markdown", () => {
    const doc = "![gone](vault/img/missing.png)";
    const spans = spansFor(doc, noImages);
    expect(spans.some((s) => s.kind === "image")).toBe(false);
  });

  test("marks wikilinks the parser knows nothing about", () => {
    const doc = "see [[Some Note]] and [[Other]]";
    const spans = spansFor(doc, noImages);
    const links = spans.filter((s) => s.kind === "mark" && s.class === "cm-md-wikilink");
    expect(links).toEqual([
      { kind: "mark", from: 4, to: 17, class: "cm-md-wikilink" },
      { kind: "mark", from: 22, to: 31, class: "cm-md-wikilink" },
    ]);
  });

  test("returns spans sorted, with line decorations before marks at the same offset", () => {
    const doc = "# Title\n\ntext **b** and `c`\n\n## Two";
    const spans = spansFor(doc, noImages);
    for (let i = 1; i < spans.length; i++) {
      const prev = spans[i - 1]!;
      const here = spans[i]!;
      expect(here.from).toBeGreaterThanOrEqual(prev.from);
      if (here.from === prev.from && here.kind === "line") expect(prev.kind).toBe("line");
    }
  });

  test("adds no duplicate line decoration for one heading", () => {
    const doc = "### Repeated";
    const lines = spansFor(doc, noImages).filter((s) => s.kind === "line");
    expect(lines.length).toBe(1);
  });

  test("is empty for plain prose", () => {
    expect(spansFor("just some words here", noImages)).toEqual([]);
  });

  test("honours a range so a viewport can be decorated alone", () => {
    const doc = "# One\n\n# Two";
    const second = doc.indexOf("# Two");
    const spans = spansFor(doc, noImages, { from: second, to: doc.length });
    expect(spans.some((s) => s.kind === "line" && s.from === 0)).toBe(false);
    expect(spans).toContainEqual({ kind: "line", from: second, class: "cm-md-h1" });
  });
});

describe("wikilinkAt", () => {
  const doc = "see [[Some Note]] here";

  test("finds the target from anywhere inside the brackets", () => {
    for (let pos = 4; pos <= 17; pos++) {
      expect(wikilinkAt(doc, pos)).toEqual({ from: 4, to: 17, target: "Some Note" });
    }
  });

  test("is null outside", () => {
    expect(wikilinkAt(doc, 2)).toBe(null);
    expect(wikilinkAt(doc, 20)).toBe(null);
  });

  test("trims the target so [[ Note ]] resolves like [[Note]]", () => {
    expect(wikilinkAt("[[ Note ]]", 3)?.target).toBe("Note");
  });
});

describe("spans inside a replaced image", () => {
  test("emits nothing under the picture", () => {
    const doc = "![a cat](img/cat.png)";
    const spans = spansFor(doc, anyImage);
    expect(spans.length).toBe(1);
    expect(spans[0]!.kind).toBe("image");
  });

  test("but dims the markup of one that could not be resolved", () => {
    const doc = "![gone](img/missing.png)";
    const spans = spansFor(doc, noImages);
    expect(spans.some((s) => s.kind === "mark" && s.class === "cm-md-mark")).toBe(true);
    expect(spans.some((s) => s.kind === "mark" && s.class === "cm-md-url")).toBe(true);
  });
});

// Phase 7. Every construct below appears in examples/ and was styled as nothing
// before this. The node names were read off the real parser, not the spec.
describe("tables", () => {
  const doc = "| A | B |\n|---|---|\n| 1 | 2 |";

  test("every line is monospaced, so the columns line up", () => {
    const lines = spansFor(doc, noImages).filter(
      (s) => s.kind === "line" && s.class === "cm-md-table",
    );
    expect(lines.map((s) => s.from)).toEqual([0, 10, 20]);
  });

  test("the pipes and the delimiter row are dimmed", () => {
    const spans = spansFor(doc, noImages);
    const marks = spans.filter((s) => s.kind === "mark" && s.class === "cm-md-mark");
    // Six single pipes plus the whole `|---|---|` row.
    expect(marks.some((s) => s.kind === "mark" && s.from === 10 && s.to === 19)).toBe(true);
    expect(marks.length).toBe(7);
  });

  test("header cells are bold and body cells are not", () => {
    const spans = spansFor(doc, noImages);
    const th = spans.filter((s) => s.kind === "mark" && s.class === "cm-md-th");
    expect(th.map((s) => (s.kind === "mark" ? [s.from, s.to] : null))).toEqual([
      [2, 3],
      [6, 7],
    ]);
  });
});

describe("tasks", () => {
  const doc = "- [x] done thing\n- [ ] todo thing";

  test("the brackets dim and the mark inside does not", () => {
    const spans = spansFor(doc, noImages);
    expect(spans).toContainEqual({ kind: "mark", from: 2, to: 3, class: "cm-md-mark" });
    expect(spans).toContainEqual({ kind: "mark", from: 3, to: 4, class: "cm-md-task-done" });
    expect(spans).toContainEqual({ kind: "mark", from: 4, to: 5, class: "cm-md-mark" });
  });

  test("an open box is styled differently from a done one", () => {
    const spans = spansFor(doc, noImages);
    expect(spans).toContainEqual({ kind: "mark", from: 20, to: 21, class: "cm-md-task-open" });
  });

  test("a completed item's text is struck, and its box is not", () => {
    const spans = spansFor(doc, noImages);
    const struck = spans.filter((s) => s.kind === "mark" && s.class === "cm-md-struck");
    expect(struck).toEqual([{ kind: "mark", from: 6, to: 16, class: "cm-md-struck" }]);
  });
});

describe("quotes", () => {
  test("every line of the quote carries the border", () => {
    const doc = "> one\n> two";
    const lines = spansFor(doc, noImages).filter(
      (s) => s.kind === "line" && s.class === "cm-md-quote",
    );
    expect(lines.map((s) => s.from)).toEqual([0, 6]);
  });

  test("a nested quote indents further", () => {
    const doc = "> outer\n>\n> > inner";
    const spans = spansFor(doc, noImages);
    expect(spans.some((s) => s.kind === "line" && s.class === "cm-md-quote2")).toBe(true);
  });
});

describe("the remaining constructs", () => {
  test("a setext heading sizes the text line, not the underline", () => {
    const doc = "Also a heading\n==============";
    const lines = spansFor(doc, noImages).filter((s) => s.kind === "line");
    expect(lines).toEqual([{ kind: "line", from: 0, class: "cm-md-h1" }]);
    // The `====` is markup and is dimmed, not sized.
    expect(spansFor(doc, noImages)).toContainEqual({
      kind: "mark",
      from: 15,
      to: 29,
      class: "cm-md-mark",
    });
  });

  test("a horizontal rule keeps its dashes", () => {
    const doc = "before\n\n---\n\nafter";
    expect(spansFor(doc, noImages)).toContainEqual({
      kind: "line",
      from: 8,
      class: "cm-md-rule",
    });
  });

  test("an indented code block is monospaced including its indent", () => {
    const doc = "text:\n\n    $ git status";
    const spans = spansFor(doc, noImages);
    expect(spans.some((s) => s.kind === "mark" && s.class === "cm-md-fence")).toBe(true);
  });

  test("a fence's info string is dimmed", () => {
    const doc = "```ts\nconst a = 1\n```";
    const spans = spansFor(doc, noImages);
    expect(spans).toContainEqual({ kind: "mark", from: 3, to: 5, class: "cm-md-mark" });
  });

  test("an escape dims the backslash and leaves the character alone", () => {
    const doc = "\\*not italic\\*";
    const spans = spansFor(doc, noImages);
    const marks = spans.filter((s) => s.kind === "mark" && s.class === "cm-md-mark");
    expect(marks).toEqual([
      { kind: "mark", from: 0, to: 1, class: "cm-md-mark" },
      { kind: "mark", from: 12, to: 13, class: "cm-md-mark" },
    ]);
  });

  test("a link title and a reference definition are dimmed as metadata", () => {
    const doc = 'A [ref][ex].\n\n[ex]: https://example.com "T"';
    const spans = spansFor(doc, noImages);
    expect(spans.some((s) => s.kind === "mark" && s.class === "cm-md-ref")).toBe(true);
    expect(spans.some((s) => s.kind === "mark" && s.class === "cm-md-mark")).toBe(true);
  });

  test("an autolink is coloured as a link", () => {
    const spans = spansFor("<https://example.com>", noImages);
    expect(spans).toContainEqual({ kind: "mark", from: 0, to: 21, class: "cm-md-link" });
  });
});

describe("what a wikilink points at", () => {
  const doc = "see [[here]] and [[gone]] and [[both]]";
  const state = (target: string) =>
    target === "gone" ? "missing" : target === "both" ? "ambiguous" : "found";

  test("colours the three states differently", () => {
    const spans = spansFor(doc, noImages, { from: 0, to: doc.length }, state);
    const classes = spans
      .filter((s) => s.kind === "mark" && s.class.includes("cm-md-wikilink"))
      .map((s) => (s.kind === "mark" ? s.class : ""));
    // The preview has always distinguished these. The editor showed all three
    // alike, so an ambiguous link looked exactly like a working one.
    expect(classes).toEqual([
      "cm-md-wikilink",
      "cm-md-wikilink cm-md-wikilink-missing",
      "cm-md-wikilink cm-md-wikilink-ambiguous",
    ]);
  });

  test("treats everything as found when nothing is asked", () => {
    const spans = spansFor(doc, noImages);
    const classes = spans
      .filter((s) => s.kind === "mark" && s.class.includes("cm-md-wikilink"))
      .map((s) => (s.kind === "mark" ? s.class : ""));
    expect(new Set(classes)).toEqual(new Set(["cm-md-wikilink"]));
  });
})

describe("a clip is not a picture", () => {
  test("the span says so, because the URL no longer can", () => {
    // The URL used to start `data:video/`; it is a blob: URL now, so the widget
    // cannot tell what to draw from the URL and is told instead.
    const clip = spansFor("![](a.mp4)", anyImage).find((s) => s.kind === "image");
    const still = spansFor("![](a.webp)", anyImage).find((s) => s.kind === "image");
    expect(clip?.kind === "image" && clip.video).toBe(true);
    expect(still?.kind === "image" && still.video).toBe(false);
  });
});
