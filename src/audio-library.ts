import { Capacitor } from "@capacitor/core";
import { attemptAsync, err, ok, type Result } from "./result.ts";
import { nativeAudioPlugin, audioSnapshots, type AudioBridge, type AudioSnapshots } from "./audio.ts";
import { parseAudioSnapshot, type AudioFailure, type AudioSnapshot } from "./audio-wire.ts";

export interface AudioTarget { readonly item: string; readonly version: string }
export interface DeleteConfirmation {
  readonly epoch: string; readonly rootGeneration: number;
  readonly token: string; readonly title: string; readonly path: string; readonly sizeBytes: number;
}
export type AudioCommand =
  | { readonly action: "refresh" | "chooseFolder" | "pause" | "reopen" | "restore" | "openDelivery" }
  | { readonly action: "play" | "done" | "unplayed" | "prepareDelete"; readonly target: AudioTarget }
  | { readonly action: "seek"; readonly id: string; readonly positionMs: number }
  | { readonly action: "confirmDelete" | "cancelDelete"; readonly token: string }
  | { readonly action: "retryDelete" | "stopRetrying" | "historyDone" | "historyUnplayed"; readonly id: string };
export interface AudioLibrary extends AudioSnapshots {
  readonly execute: (command: AudioCommand, snapshot: AudioSnapshot) => Promise<Result<AudioSnapshot | DeleteConfirmation, AudioFailure>>;
}
export interface AudioLibraryBridge extends AudioBridge {
  readonly audioChooseFolder: (scope: unknown) => Promise<unknown>;
  readonly audioPrepareDelete: (target: unknown) => Promise<unknown>;
  readonly audioCommand: (command: unknown) => Promise<unknown>;
}
const bridgeFailure = (): AudioFailure => ({ kind: "BRIDGE", message: "The audio action could not be completed. Reopen Audio and retry." });
const object = (v: unknown): Record<string, unknown> | null => typeof v === "object" && v !== null ? v as Record<string, unknown> : null;
const kinds = new Set(["PERMISSION", "MISSING", "VERSION_CHANGED", "UNSUPPORTED", "STORAGE", "PLAYBACK", "CANCELLED", "STALE", "RECOVERY", "BRIDGE"]);
export const audioLibrary = (supported: boolean, bridge: AudioLibraryBridge): AudioLibrary => {
  const snapshots = audioSnapshots(supported, bridge);
  return { ...snapshots, execute: async (command, snapshot) => {
    if (!supported) return err({ kind: "UNSUPPORTED", message: "Audio requires the Android Notes app." });
    if (command.action === "refresh") return snapshots.refresh();
    const scope = { epoch: snapshot.epoch, rootGeneration: snapshot.rootGeneration };
    const args = { ...scope, ...command, ...("target" in command ? command.target : {}) };
    const result = await attemptAsync(() => command.action === "chooseFolder" ? bridge.audioChooseFolder(scope) :
      command.action === "prepareDelete" ? bridge.audioPrepareDelete(args) : bridge.audioCommand(args), bridgeFailure);
    if (!result.ok) return result;
    const value = object(result.value); if (!value) return err(bridgeFailure());
    if (value.failure !== null) {
      const failure = object(value.failure);
      if (!failure || typeof failure.kind !== "string" || !kinds.has(failure.kind) || typeof failure.message !== "string") return err(bridgeFailure());
      return err({ kind: failure.kind as AudioFailure["kind"], message: failure.message });
    }
    if (command.action !== "prepareDelete") return parseAudioSnapshot(value.snapshot);
    const c = object(value.confirmation);
    if (!c || typeof c.token !== "string" || !c.token || typeof c.title !== "string" || typeof c.path !== "string" ||
        typeof c.sizeBytes !== "number" || !Number.isSafeInteger(c.sizeBytes) || c.sizeBytes < 0) return err(bridgeFailure());
    return ok({ ...scope, token: c.token, title: c.title, path: c.path, sizeBytes: c.sizeBytes });
  } };
};
export const nativeAudioLibrary = (): AudioLibrary => audioLibrary(
  Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("Audio"), nativeAudioPlugin,
);
