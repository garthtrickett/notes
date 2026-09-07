import { describe, expect, test } from "bun:test";
import { historyMethod, pathFromUrl, titleFor, urlFor } from "./url.ts";

describe("urlFor", () => {
  test("names the open note", () => {
    expect(urlFor({ mode: "notes", openPath: "health/markers.md" })).toBe(
      "/health/markers.md",
    );
  });

  test("is the root when nothing is open", () => {
    expect(urlFor({ mode: "notes", openPath: null })).toBe("/");
  });

  test("is the root in every mode that has no note open", () => {
    // The dump, archive and trash views replace the editor entirely, so a URL
    // naming a note there would restore a screen you were not looking at.
    for (const mode of ["dump", "archive", "trash", "settings"]) {
      expect(urlFor({ mode, openPath: "health/markers.md" })).toBe("/");
    }
  });

  test("escapes within a segment and not across one", () => {
    const url = urlFor({ mode: "notes", openPath: "a folder/c# & co.md" });
    expect(url).toBe("/a%20folder/c%23%20%26%20co.md");
    // The slash is structure. Escaping it would make one flat name of a path.
    expect(url.split("/").length).toBe(3);
  });
});

describe("titleFor", () => {
  test("is the note's name, so a tab is identifiable at thumbnail size", () => {
    expect(titleFor({ mode: "notes", openPath: "health/markers.md" })).toBe(
      "markers — notes",
    );
  });

  test("falls back to the app when no note is open", () => {
    expect(titleFor({ mode: "dump", openPath: "health/markers.md" })).toBe("notes");
    expect(titleFor({ mode: "notes", openPath: null })).toBe("notes");
  });
});

describe("pathFromUrl", () => {
  test("round-trips whatever urlFor produced", () => {
    for (const path of ["health/markers.md", "a folder/c# & co.md", "top.md"]) {
      expect(pathFromUrl(urlFor({ mode: "notes", openPath: path }))).toBe(path);
    }
  });

  test("the root names no note", () => {
    expect(pathFromUrl("/")).toBeNull();
    expect(pathFromUrl("")).toBeNull();
  });

  test("a broken escape is nobody's note", () => {
    // decodeURIComponent throws on this. Letting it escape would take the whole
    // boot down over a mistyped address.
    expect(pathFromUrl("/%E0%A4%A")).toBeNull();
  });
});

describe("historyMethod", () => {
  const settled = { booted: true, fromPop: false };

  test("pushes when you open a note, so Back returns to the last one", () => {
    expect(historyMethod("/a.md", settled)).toBe("pushState");
  });

  test("replaces while booting", () => {
    expect(historyMethod("/a.md", { booted: false, fromPop: false })).toBe(
      "replaceState",
    );
  });

  test("replaces when Back is what got us here", () => {
    // Pushing would put an entry in front of the one just left, and Back would
    // never get out of the app.
    expect(historyMethod("/a.md", { booted: true, fromPop: true })).toBe(
      "replaceState",
    );
  });

  test("replaces on the way to the root", () => {
    // The dump, archive and trash have no URL of their own, so an entry for
    // them is one the app cannot honour when you come back to it.
    expect(historyMethod("/", settled)).toBe("replaceState");
  });
});
