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
