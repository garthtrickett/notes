import { describe, expect, it } from "bun:test";
import { acceptAudioEvent, acceptAudioHandshake, nativeStorageTest, type AudioStamp } from "./audio.ts";

describe("audio storage diagnostic on the web", () => {
  it("reports unsupported without selecting storage or inventing a library", async () => {
    const audio = nativeStorageTest();
    expect(audio.supported).toBe(false);
    expect(await audio.open()).toEqual({ ok: false, error: "The audio storage test requires the Android Notes app." });
  });
});

describe("native audio snapshot ordering", () => {
  const stamp = (epoch: string, revision: number, rootGeneration = 1): AudioStamp => ({ epoch, revision, rootGeneration });
  it("keeps an intervening subscription update ahead of an older initial snapshot", () => {
    const initial = stamp("process-one", 1), intervening = stamp("process-one", 2);
    expect(acceptAudioHandshake(null, initial, [intervening])).toBe(intervening);
  });
  it("ignores stale and duplicate revisions", () => {
    const current = stamp("process-one", 10);
    expect(acceptAudioEvent(current, stamp("process-one", 9))).toBe(current);
    expect(acceptAudioEvent(current, stamp("process-one", 10))).toBe(current);
  });
  it("only a handshake can establish a restarted native epoch", () => {
    const old = stamp("process-one", 100), restarted = stamp("process-two", 0);
    expect(acceptAudioEvent(old, restarted)).toBe(old);
    expect(acceptAudioHandshake(old, restarted, [])).toBe(restarted);
    expect(acceptAudioEvent(restarted, stamp("process-one", 1000))).toBe(restarted);
  });
  it("does not lose a new-process update when an old callback arrives during connection", () => {
    const old = stamp("process-one", 100), handshake = stamp("process-two", 0);
    const current = stamp("process-two", 1);
    expect(acceptAudioHandshake(old, handshake, [current, stamp("process-one", 101)])).toBe(current);
  });
  it("refuses an older root even if that callback has a larger revision", () => {
    const current = stamp("process-one", 10, 2);
    expect(acceptAudioEvent(current, stamp("process-one", 11, 1))).toBe(current);
    expect(acceptAudioEvent(current, stamp("process-one", 12, 2))).toEqual(stamp("process-one", 12, 2));
  });
  it("keeps the current snapshot when reconnecting to the same native process", () => {
    const current = stamp("process-one", 10, 2);
    expect(acceptAudioHandshake(current, stamp("process-one", 5, 1), [])).toBe(current);
  });
});
