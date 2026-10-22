import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { attemptAsync, err, ok, type Result } from "./result.ts";
import { parseAudioSnapshot, type AudioFailure, type AudioSnapshot, type AudioStamp } from "./audio-wire.ts";
export type { AudioFailure, AudioSnapshot, AudioStamp } from "./audio-wire.ts";

export const nativeAudioPlugin = registerPlugin<AudioBridge & {
  openStorageTest(): Promise<void>;
  audioChooseFolder(scope: unknown): Promise<unknown>;
  audioPrepareDelete(target: unknown): Promise<unknown>;
  audioCommand(command: unknown): Promise<unknown>;
}>("Audio");

// Storage qualification stays on a separate native screen. The snapshot seam
// below carries metadata, never audio bytes or caller-supplied media URIs.
export interface AudioStorageTest {
  readonly supported: boolean;
  readonly open: () => Promise<Result<void, string>>;
}

export const nativeStorageTest = (): AudioStorageTest => {
  const supported = Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("Audio");
  const plugin = nativeAudioPlugin;
  return {
    supported,
    open: async () => {
      if (!supported) return err("The audio storage test requires the Android Notes app.");
      const result = await attemptAsync(() => plugin.openStorageTest(), () => "Could not open the audio storage test. Please retry.");
      return result.ok ? ok(undefined) : result;
    },
  };
};

// Events may advance a connection, but only a completed native handshake can
// establish a new process epoch. A late callback can never switch it back.
export const acceptAudioEvent = <T extends AudioStamp>(current: T, event: T): T =>
  event.epoch === current.epoch &&
  event.rootGeneration >= current.rootGeneration &&
  event.revision > current.revision
    ? event
    : current;

// Subscribe first, buffer intervening updates, then reconcile the handshake and
// those updates through the same ordering rule. A reconnect in the same process
// cannot roll an already accepted snapshot backwards.
export const acceptAudioHandshake = <T extends AudioStamp>(
  current: T | null,
  handshake: T,
  earlyEvents: readonly T[],
): T => {
  const initial = current?.epoch === handshake.epoch
    ? acceptAudioEvent(current, handshake)
    : handshake;
  return earlyEvents.reduce((latest, event) => acceptAudioEvent(latest, event), initial);
};

export interface AudioBridge {
  readonly addListener: (event: "audioState", listener: (raw: unknown) => void) => Promise<PluginListenerHandle>;
  readonly audioSnapshot: () => Promise<unknown>;
  readonly audioRefresh: () => Promise<unknown>;
}
export interface AudioConnection {
  readonly ready: Promise<Result<AudioSnapshot, AudioFailure>>;
  readonly disconnect: () => Promise<Result<void, AudioFailure>>;
}
export interface AudioSnapshots {
  readonly supported: boolean;
  readonly connect: (changed: (snapshot: AudioSnapshot) => void, failed: (failure: AudioFailure) => void, previous?: AudioSnapshot | null) => AudioConnection;
  // Resolves with the state at refresh start; the subscription reports its
  // eventual successful listing or failure. Refresh never starts playback.
  readonly refresh: () => Promise<Result<AudioSnapshot, AudioFailure>>;
}
const bridgeFailure = (): AudioFailure => ({ kind: "BRIDGE", message: "Could not connect to native audio. Update or reopen Notes." });
const cancelled = (): Result<never, AudioFailure> => err({ kind: "CANCELLED", message: "Audio connection closed." });
const unsupported = (): Result<never, AudioFailure> => err({ kind: "UNSUPPORTED", message: "The audio library requires the Android Notes app." });

// The injected bridge is also the test seam. Native data is parsed once here;
// callers receive complete immutable projections and never issue media URIs.
export const audioSnapshots = (supported: boolean, bridge: AudioBridge): AudioSnapshots => ({
  supported,
  refresh: async () => {
    if (!supported) return unsupported();
    const result = await attemptAsync(() => bridge.audioRefresh(), bridgeFailure);
    return result.ok ? parseAudioSnapshot(result.value) : result;
  },
  connect: (changed, failed, previous = null) => {
    if (!supported) return { ready: Promise.resolve(unsupported()), disconnect: async () => ok(undefined) };
    let closed = false, initialized = false, current = previous;
    const early = new Map<string, AudioSnapshot>();
    let cancelReady: (result: Result<AudioSnapshot, AudioFailure>) => void = () => {};
    const cancellation = new Promise<Result<AudioSnapshot, AudioFailure>>(resolve => { cancelReady = resolve; });
    const registration = attemptAsync(() => bridge.addListener("audioState", raw => {
      if (closed) return;
      const parsed = parseAudioSnapshot(raw);
      if (!parsed.ok) { failed(parsed.error); return; }
      const event = parsed.value;
      if (!initialized) {
        const prior = early.get(event.epoch);
        early.set(event.epoch, prior ? acceptAudioEvent(prior, event) : event);
      } else if (current !== null) {
        const next = acceptAudioEvent(current, event);
        if (next !== current) { current = next; changed(next); }
      }
    }), bridgeFailure);
    let removal: Promise<Result<void, AudioFailure>> | null = null;
    const detach = async (): Promise<Result<void, AudioFailure>> => {
      const subscribed = await registration;
      if (!subscribed.ok) return ok(undefined);
      removal ??= attemptAsync(() => subscribed.value.remove(), bridgeFailure);
      return removal;
    };
    const initialize = async (): Promise<Result<AudioSnapshot, AudioFailure>> => {
      const subscribed = await registration;
      if (!subscribed.ok) { closed = true; return subscribed; }
      if (closed) { await detach(); return cancelled(); }
      const result = await attemptAsync(() => bridge.audioSnapshot(), bridgeFailure);
      if (closed) return cancelled();
      const parsed = result.ok ? parseAudioSnapshot(result.value) : result;
      if (!parsed.ok) { closed = true; await detach(); return parsed; }
      current = acceptAudioHandshake(previous, parsed.value, [...early.values()]);
      early.clear(); initialized = true; changed(current);
      return ok(current);
    };
    return {
      ready: Promise.race([initialize(), cancellation]),
      disconnect: () => { closed = true; early.clear(); cancelReady(cancelled()); return detach(); },
    };
  },
});

export const nativeAudioSnapshots = (): AudioSnapshots => audioSnapshots(
  Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("Audio"),
  nativeAudioPlugin,
);
