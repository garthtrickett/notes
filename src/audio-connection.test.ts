import { describe, expect, it } from "bun:test";
import { audioSnapshots, nativeAudioSnapshots, type AudioBridge, type AudioFailure, type AudioSnapshot } from "./audio.ts";
import { parseAudioSnapshot } from "./audio-wire.ts";
import nativeFixture from "./audio-snapshot.fixture.json";

const snapshot = (revision = 1, epoch = "native-one", rootGeneration = 1): AudioSnapshot => ({
  protocol: 1, epoch, revision, rootGeneration, rootSelected: true, operation: null, warning: null,
  recoveryRequired: false, failure: null, rows: [], history: [], player: null,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const fake = () => {
  const listeners = new Set<(raw: unknown) => void>();
  let removals = 0, reads = 0;
  const bridge: AudioBridge = {
    addListener: async (_event, listener) => {
      listeners.add(listener);
      return { remove: async () => { removals++; listeners.delete(listener); } };
    },
    audioSnapshot: async () => { reads++; return snapshot(); },
    audioRefresh: async () => snapshot(2),
  };
  return { bridge, emit: (raw: unknown) => { for (const listener of listeners) listener(raw); },
    removals: () => removals, reads: () => reads, listeners: () => listeners.size };
};

describe("actual audio connection ordering and lifetime", () => {
  it("subscribes before the handshake and keeps the intervening update", async () => {
    const f = fake(), seen: AudioSnapshot[] = [];
    const bridge = { ...f.bridge, audioSnapshot: async () => { f.emit(snapshot(5)); return snapshot(4); } };
    const connection = audioSnapshots(true, bridge).connect(value => seen.push(value), () => {});
    expect(await connection.ready).toEqual({ ok: true, value: snapshot(5) });
    expect(seen.map(value => value.revision)).toEqual([5]);
    await connection.disconnect();
  });
  it("does not switch epochs from buffered or late events", async () => {
    const f = fake(), seen: AudioSnapshot[] = [];
    const bridge = { ...f.bridge, audioSnapshot: async () => { f.emit(snapshot(99, "old")); return snapshot(1, "new"); } };
    const connection = audioSnapshots(true, bridge).connect(value => seen.push(value), () => {}, snapshot(80, "old"));
    await connection.ready;
    f.emit(snapshot(100, "old")); f.emit(snapshot(2, "new")); f.emit(snapshot(200, "third"));
    expect(seen.map(value => [value.epoch, value.revision])).toEqual([["new", 1], ["new", 2]]);
    await connection.disconnect();
  });
  it("keeps a same-process reconnect ahead of an old initial reply", async () => {
    const f = fake();
    const bridge = { ...f.bridge, audioSnapshot: async () => snapshot(3) };
    const connection = audioSnapshots(true, bridge).connect(() => {}, () => {}, snapshot(10));
    expect(await connection.ready).toEqual({ ok: true, value: snapshot(10) });
    await connection.disconnect();
  });
  it("removes only this connection's listener and removes it once", async () => {
    const f = fake(), adapter = audioSnapshots(true, f.bridge), seen: AudioSnapshot[] = [];
    const first = adapter.connect(() => {}, () => {}), second = adapter.connect(value => seen.push(value), () => {});
    await Promise.all([first.ready, second.ready]);
    expect(f.listeners()).toBe(2);
    await first.disconnect(); await first.disconnect();
    expect(f.removals()).toBe(1); expect(f.listeners()).toBe(1);
    f.emit(snapshot(2)); expect(seen.map(value => value.revision)).toEqual([1, 2]);
    await second.disconnect(); expect(f.listeners()).toBe(0);
  });
  it("cancels before registration resolves and cleans up its eventual handle", async () => {
    const handle = deferred<{ remove: () => Promise<void> }>(), f = fake(), seen: AudioSnapshot[] = [];
    let callback: (raw: unknown) => void = () => {}, removals = 0;
    const bridge = { ...f.bridge, addListener: async (_event: "audioState", listener: (raw: unknown) => void) => { callback = listener; return handle.promise; } };
    const connection = audioSnapshots(true, bridge).connect(value => seen.push(value), () => {});
    const closing = connection.disconnect();
    expect((await connection.ready).ok).toBe(false);
    callback(snapshot(99));
    handle.resolve({ remove: async () => { removals++; } });
    await closing;
    expect(removals).toBe(1); expect(f.reads()).toBe(0); expect(seen).toEqual([]);
  });
  it("cancels a pending handshake without publishing its late reply", async () => {
    const reply = deferred<unknown>(), started = deferred<void>(), f = fake(), seen: AudioSnapshot[] = [];
    const bridge = { ...f.bridge, audioSnapshot: async () => { started.resolve(); return reply.promise; } };
    const connection = audioSnapshots(true, bridge).connect(value => seen.push(value), () => {});
    await started.promise; await connection.disconnect();
    expect(await connection.ready).toEqual({ ok: false, error: { kind: "CANCELLED", message: "Audio connection closed." } });
    reply.resolve(snapshot(100)); await Promise.resolve();
    expect(seen).toEqual([]); expect(f.removals()).toBe(1);
  });
  it("cleans up a failed handshake and reports subscription failure as a value", async () => {
    const f = fake();
    const bridge = { ...f.bridge, audioSnapshot: async () => { throw new Error("transport stopped"); } };
    const connection = audioSnapshots(true, bridge).connect(() => {}, () => {});
    expect((await connection.ready).ok).toBe(false); expect(f.removals()).toBe(1);
    await connection.disconnect(); expect(f.removals()).toBe(1);
    const unavailable = audioSnapshots(true, { ...f.bridge, addListener: async () => { throw new Error("no WebView"); } });
    const failed = unavailable.connect(() => {}, () => {});
    expect((await failed.ready).ok).toBe(false); expect((await failed.disconnect()).ok).toBe(true);
  });
  it("keeps the last valid state after a malformed event and rejects older roots", async () => {
    const f = fake(), seen: AudioSnapshot[] = [], failures: AudioFailure[] = [];
    const connection = audioSnapshots(true, f.bridge).connect(value => seen.push(value), failure => failures.push(failure));
    await connection.ready;
    f.emit({ ...snapshot(2), revision: "2" }); f.emit(snapshot(3, "native-one", 2)); f.emit(snapshot(99, "native-one", 1));
    expect(seen.map(value => value.revision)).toEqual([1, 3]); expect(failures[0]?.kind).toBe("BRIDGE");
    await connection.disconnect(); f.emit(snapshot(101)); expect(seen).toHaveLength(2);
  });
  it("refuses malformed handshakes and cleans up rather than inventing an empty library", async () => {
    const f = fake(), seen: AudioSnapshot[] = [];
    const connection = audioSnapshots(true, { ...f.bridge, audioSnapshot: async () => ({}) }).connect(value => seen.push(value), () => {});
    expect((await connection.ready).ok).toBe(false); expect(seen).toEqual([]); expect(f.removals()).toBe(1);
  });
  it("never calls native on an unsupported browser", async () => {
    const f = fake(), adapter = audioSnapshots(false, f.bridge);
    expect((await adapter.connect(() => {}, () => {}).ready).ok).toBe(false);
    expect((await adapter.refresh()).ok).toBe(false); expect(f.listeners()).toBe(0); expect(f.reads()).toBe(0);
    expect(nativeAudioSnapshots().supported).toBe(false);
  });
});

describe("audio native data boundary", () => {
  it("accepts the exact snapshot contract asserted by the real native serializer", () => {
    expect<unknown>(parseAudioSnapshot(nativeFixture)).toEqual({ ok: true, value: nativeFixture });
  });
  const full = (): AudioSnapshot => ({ ...snapshot(),
    rows: [{ item: "row-one", version: "cap-one", path: "audiobooks/book.m4b", title: "Book", author: null,
      sizeBytes: 12345, durationMs: 5000, durableId: "known-one", listening: { mark: "DONE", positionMs: 5000, durationMs: 5000 } }],
    history: [{ id: "known-one", path: "audiobooks/book.m4b", title: "Book", author: null, currentRoot: true,
      listening: { mark: "DONE", positionMs: 5000, durationMs: 5000 } }],
    player: { item: "known-one", positionMs: 5000, durationMs: 5000, playing: false },
  });
  it("parses complete native history and player state while discarding unknown properties", () => {
    expect(parseAudioSnapshot({ ...full(), futureMetadata: true })).toEqual({ ok: true, value: full() });
  });
  it("refuses coercion, non-finite positions, invalid marks and future protocols", () => {
    for (const field of [{ revision: "1" }, { rootGeneration: -1 }, { revision: 1.5 }, { protocol: 2 }, { history: null }])
      expect(parseAudioSnapshot({ ...full(), ...field }).ok).toBe(false);
    const value = full(), item = value.history[0]!;
    for (const listening of [{ ...item.listening, positionMs: NaN }, { ...item.listening, mark: ["DONE"] }, { ...item.listening, durationMs: -1 }])
      expect(parseAudioSnapshot({ ...value, history: [{ ...item, listening }] }).ok).toBe(false);
  });
  it("refuses ambiguous rows, missing listening fields and dangling native IDs", () => {
    const value = full();
    for (const field of [{ rows: [...value.rows, ...value.rows] }, { history: [] }, { player: { ...value.player, item: "absent" } },
      { rows: [{ ...value.rows[0], listening: undefined }] }]) expect(parseAudioSnapshot({ ...value, ...field }).ok).toBe(false);
  });
});
