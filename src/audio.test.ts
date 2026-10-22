import { describe, expect, it } from "bun:test";
import { nativeStorageTest } from "./audio.ts";

describe("audio storage diagnostic on the web", () => {
  it("reports unsupported without selecting storage or inventing a library", async () => {
    const audio = nativeStorageTest();
    expect(audio.supported).toBe(false);
    expect(await audio.open()).toEqual({ ok: false, error: "The audio storage test requires the Android Notes app." });
  });
});
