import { Capacitor, registerPlugin } from "@capacitor/core";
import { attemptAsync, err, ok, type Result } from "./result.ts";

// The storage spike is a separate native screen. The eventual playback seam
// will carry metadata/snapshots here, never audio bytes or caller-supplied URIs.
export interface AudioStorageTest {
  readonly supported: boolean;
  readonly open: () => Promise<Result<void, string>>;
}

export const nativeStorageTest = (): AudioStorageTest => {
  const supported = Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("Audio");
  const plugin = registerPlugin<{ openStorageTest(): Promise<void> }>("Audio");
  return {
    supported,
    open: async () => {
      if (!supported) return err("The audio storage test requires the Android Notes app.");
      const result = await attemptAsync(() => plugin.openStorageTest(), () => "Could not open the audio storage test. Please retry.");
      return result.ok ? ok(undefined) : result;
    },
  };
};

export interface AudioStamp {
  readonly epoch: string;
  readonly rootGeneration: number;
  readonly revision: number;
}

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
