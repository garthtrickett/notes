import { describe, expect, it, afterEach } from "bun:test";
import { audioLibrary, type AudioLibrary, type AudioLibraryBridge, type AudioCommand } from "./audio-library.ts";
import { emptyAudio, presentAudio } from "./audio-model.ts";
import { parseAudioSnapshot, type AudioSnapshot } from "./audio-wire.ts";
import fixture from "./audio-snapshot.fixture.json";
import { createLoop, type Loop } from "./loop.ts";
import { openDb } from "./idb.ts";

const parsed = parseAudioSnapshot(fixture);
if (!parsed.ok) throw new Error("Invalid native fixture");
const snapshot = parsed.value;
const bridge = (overrides: Partial<AudioLibraryBridge> = {}): AudioLibraryBridge => ({
  addListener: async () => ({ remove: async () => {} }), audioSnapshot: async () => snapshot,
  audioRefresh: async () => snapshot, audioChooseFolder: async () => ({ failure: null, snapshot }),
  audioPrepareDelete: async () => ({ failure: null, confirmation: { token: "exact-version", title: "Recording", path: "youtube/ordinary.opus", sizeBytes: 42 } }),
  audioCommand: async () => ({ failure: null, snapshot }), ...overrides,
});
describe("audio library command boundary", () => {
  it("sends native capabilities and scope without granting authority to display paths", async () => {
    let received: unknown;
    const library = audioLibrary(true, bridge({ audioCommand: async args => { received = args; return { failure: null, snapshot }; } }));
    expect((await library.execute({ action: "play", target: { item: "opaque-item", version: "opaque-version" } }, snapshot)).ok).toBe(true);
    expect(received).toEqual({ action: "play", epoch: snapshot.epoch, rootGeneration: snapshot.rootGeneration,
      target: { item: "opaque-item", version: "opaque-version" }, item: "opaque-item", version: "opaque-version" });
    expect(JSON.stringify(received)).not.toContain("content://"); expect(JSON.stringify(received)).not.toContain(".opus");
  });
  it("parses confirmation data and rejects malformed sizes", async () => {
    const result = await audioLibrary(true, bridge()).execute({ action: "prepareDelete", target: snapshot.rows[0]! }, snapshot);
    expect(result.ok && "token" in result.value && result.value.rootGeneration).toBe(snapshot.rootGeneration);
    const bad = audioLibrary(true, bridge({ audioPrepareDelete: async () => ({ failure: null, confirmation: { token: "x", title: "x", path: "x", sizeBytes: -1 } }) }));
    expect((await bad.execute({ action: "prepareDelete", target: snapshot.rows[0]! }, snapshot)).ok).toBe(false);
  });
  it("preserves typed native errors and converts rejected bridge calls", async () => {
    const failure = { kind: "VERSION_CHANGED" as const, message: "Replacement was retained" };
    expect(await audioLibrary(true, bridge({ audioCommand: async () => ({ failure }) })).execute({ action: "confirmDelete", token: "x" }, snapshot)).toEqual({ ok: false, error: failure });
    const failed = await audioLibrary(true, bridge({ audioCommand: async () => { throw new Error("gone"); } })).execute({ action: "pause" }, snapshot);
    expect(!failed.ok && failed.error.kind).toBe("BRIDGE");
  });
  it("drops late confirmations after a root or epoch change", () => {
    const audio = { ...emptyAudio(), snapshot: { ...snapshot, rootGeneration: 2 }, busy: 1 };
    const result = presentAudio(audio, { kind: "audioFinished", error: null, confirmation: {
      token: "old", title: "Old file", path: "youtube/old.opus", sizeBytes: 42, epoch: snapshot.epoch, rootGeneration: 1,
    } });
    expect(result.confirmation).toBe(null); expect(result.busy).toBe(0);
  });
});

let active: Loop | null = null;
let db: IDBDatabase | null = null;
afterEach(() => { active?.dispose(); db?.close(); active = null; db = null; });
const setup = async () => {
  db = await openDb();
  const commands: AudioCommand[] = [];
  let listener: (s: AudioSnapshot) => void = () => {};
  const library: AudioLibrary = {
    supported: true,
    connect: changed => {
      listener = changed; queueMicrotask(() => changed(snapshot));
      return { ready: Promise.resolve({ ok: true, value: snapshot }), disconnect: async () => ({ ok: true, value: undefined }) };
    },
    refresh: async () => ({ ok: true, value: snapshot }),
    execute: async command => {
      commands.push(command);
      if (command.action === "prepareDelete") return { ok: true, value: { token: "delete-one", title: "Synthetic recording", path: "youtube/test.opus", sizeBytes: 42,
        epoch: snapshot.epoch, rootGeneration: snapshot.rootGeneration } };
      return { ok: true, value: snapshot };
    },
  };
  const root = document.createElement("div"); document.body.replaceChildren(root);
  active = createLoop({ db, github: null, now: () => 1700000000000, schedule: () => {}, shrink: async () => new ArrayBuffer(0), audioLibrary: library }, root);
  active.propose({ kind: "hydrated", notes: [] }); await active.flush();
  return { root, loop: active, commands, emit: (s: AudioSnapshot) => listener(s) };
};
describe("production Audio SAM flow", () => {
  it("starts silently, refreshes on entry, and preserves the compact player across modes", async () => {
    const { root, loop, commands } = await setup();
    expect(commands).toEqual([]); expect(root.querySelector(".audio-player")).not.toBe(null);
    loop.propose({ kind: "modeChanged", mode: "audio" }); await loop.flush();
    expect(commands.map(c => c.action)).toEqual(["refresh"]);
    loop.propose({ kind: "audioFilter", filter: "DONE" }); await loop.flush();
    expect(root.textContent).toContain("Synthetic recording"); expect(root.textContent).toContain("Delete download");
    loop.propose({ kind: "modeChanged", mode: "settings" }); await loop.flush();
    expect(root.querySelector(".audio-player")).not.toBe(null); expect(commands.map(c => c.action)).toEqual(["refresh"]);
  });
  it("cancels a prepared deletion without sending confirmation", async () => {
    const { root, loop, commands } = await setup();
    loop.propose({ kind: "modeChanged", mode: "audio" });
    loop.propose({ kind: "audioFilter", filter: "DONE" }); await loop.flush();
    const button = [...root.querySelectorAll<HTMLButtonElement>(".audio-row button")].find(b => b.textContent === "Delete download")!;
    button.click(); await loop.flush(); expect(root.querySelector('[role="dialog"]')).not.toBe(null);
    expect(document.activeElement).toBe(root.querySelector("[data-audio-confirm]"));
    root.querySelector<HTMLButtonElement>("[data-audio-confirm]")!.click(); await loop.flush();
    expect(root.querySelector('[role="dialog"]')).toBe(null);
    expect(commands.map(c => c.action)).toEqual(["refresh", "prepareDelete", "cancelDelete"]);
  });
  it("keeps missing Done history and pending recovery visible without Play", async () => {
    const { root, loop, emit } = await setup();
    loop.propose({ kind: "modeChanged", mode: "audio" }); await loop.flush();
    emit({ ...snapshot, revision: 10, rows: [], player: null, history: snapshot.history.map(item => ({ ...item, availability: "MISSING", deletion: "INTENT" })) });
    await loop.flush(); expect(root.textContent).toContain("Pending deletions"); expect(root.textContent).toContain("Retry deletion");
    loop.propose({ kind: "audioFilter", filter: "DONE" }); await loop.flush();
    expect(root.textContent).toContain("Not downloaded on this phone");
    expect([...root.querySelectorAll(".audio-row button")].some(b => b.textContent === "Play")).toBe(false);
  });
});

describe("Audio library search", () => {
  it("searches title, author and filename while retaining the selected filters", async () => {
    const { root, loop, emit, commands } = await setup();
    loop.propose({ kind: "modeChanged", mode: "audio" }); await loop.flush();
    const row = snapshot.rows[0]!;
    emit({ ...snapshot, revision: 10, history: [], player: null, rows: [
      { ...row, item: "lecture", version: "lecture-v1", durableId: null, listening: null,
        title: "An evening lecture", author: "Ada Example", path: "youtube/first.opus" },
      { ...row, item: "book", version: "book-v1", durableId: null, listening: null,
        title: "Local book", author: null, path: "audiobooks/second.m4b" },
    ] }); await loop.flush();
    const input = root.querySelector<HTMLInputElement>('input[type="search"][aria-label="Search audio"]')!;
    const search = async (query: string) => { input.value = query; input.dispatchEvent(new Event("input", { bubbles: true })); await loop.flush(); };
    const titles = () => [...root.querySelectorAll(".audio-row h2")].map(h => h.textContent);
    await search("  EVENING ada  "); expect(titles()).toEqual(["An evening lecture"]);
    await search("SECOND.M4B"); expect(titles()).toEqual(["Local book"]);
    loop.propose({ kind: "audioFilter", source: "youtube" }); await loop.flush();
    expect(titles()).toEqual([]); expect(root.textContent).toContain("No recordings match your search in this view.");
    [...root.querySelectorAll<HTMLButtonElement>(".audio-search button")].find(b => b.textContent === "Clear")!.click();
    await loop.flush(); expect(titles()).toEqual(["An evening lecture"]);
    expect(input.value).toBe(""); expect(loop.model.audio.source).toBe("youtube");
    expect(commands.map(c => c.action)).toEqual(["refresh"]);
  });
  it("searches missing listening history without hiding pending deletion recovery", async () => {
    const { root, loop, emit } = await setup();
    loop.propose({ kind: "modeChanged", mode: "audio" }); await loop.flush();
    emit({ ...snapshot, revision: 10, rows: [], player: null, history: [
      { ...snapshot.history[0]!, id: "kept", title: "Kept history", author: "A speaker", availability: "MISSING" },
      { ...snapshot.history[0]!, id: "pending", title: "Pending deletion", deletion: "INTENT" },
    ] });
    loop.propose({ kind: "audioFilter", filter: "DONE" }); await loop.flush();
    const input = root.querySelector<HTMLInputElement>('input[aria-label="Search audio"]')!;
    input.value = "speaker"; input.dispatchEvent(new Event("input", { bubbles: true })); await loop.flush();
    expect(root.querySelectorAll(".audio-history").length).toBe(2);
    expect(root.textContent).toContain("Kept history"); expect(root.textContent).toContain("Not downloaded on this phone");
    input.value = "unmatched"; input.dispatchEvent(new Event("input", { bubbles: true })); await loop.flush();
    expect(root.textContent).not.toContain("Kept history");
    expect(root.querySelector(".audio-pending")?.textContent).toContain("Retry deletion");
  });
});
