import { describe, expect, it } from "bun:test";
import { folderCompletions } from "./folder-completion.ts";

const paths = ["surfing/spots/indo/png.md", "surfing/spots/indo/maluku.md", "surfing/gear/boards.md", "reading/books.md"];

describe("folder completion", () => {
  it("shows unique immediate folders, then the next level after each slash", () => {
    expect(folderCompletions(paths, "")).toEqual(["reading/", "surfing/"]);
    expect(folderCompletions(paths, "surfing/")).toEqual(["surfing/gear/", "surfing/spots/"]);
    expect(folderCompletions(paths, "surfing/spots/")).toEqual(["surfing/spots/indo/"]);
    expect(folderCompletions(paths, "surfing/spots/indo/")).toEqual([]);
  });

  it("matches case-insensitively while preserving the real folder spelling", () => {
    expect(folderCompletions(["Surfing/Spots/a.md"], "surfing/sp")).toEqual(["Surfing/Spots/"]);
  });

  it("supports spaces and Unicode without treating file names as folders", () => {
    expect(folderCompletions(["日本語/Tea time/a.md", "reading.md"], "日本語/Te")).toEqual(["日本語/Tea time/"]);
    expect(folderCompletions(["reading.md"], "read")).toEqual([]);
  });

  it("uses the path field's leading/duplicate slash conventions", () => {
    expect(folderCompletions(paths, " /surfing//sp")).toEqual(["surfing/spots/"]);
  });

  it("leaves new folder and note names free to be typed", () => {
    expect(folderCompletions(paths, "surfing/new-trip/idea")).toEqual([]);
    expect(folderCompletions(paths, "surfing/spots/indo/new-spot")).toEqual([]);
  });
});
