import { acceptAudioEvent, acceptAudioHandshake } from "./audio.ts";
import type { AudioFailure, AudioSnapshot } from "./audio-wire.ts";
import type { AudioCommand, DeleteConfirmation } from "./audio-library.ts";

// A projection only: the native ledger owns bookmarks, marks and deletion.
export interface AudioModel {
  readonly supported: boolean;
  readonly snapshot: AudioSnapshot | null;
  readonly error: AudioFailure | null;
  readonly filter: "UNPLAYED" | "IN_PROGRESS" | "DONE";
  readonly source: string;
  readonly query: string;
  readonly busy: number;
  readonly confirmation: DeleteConfirmation | null;
}
export const emptyAudio = (): AudioModel => ({ supported: false, snapshot: null, error: null, filter: "UNPLAYED", source: "all", query: "", busy: 0, confirmation: null });
export type AudioProposal =
  | { readonly kind: "audioReconnect" }
  | { readonly kind: "audioSupported"; readonly supported: boolean }
  | { readonly kind: "audioSnapshot"; readonly snapshot: AudioSnapshot; readonly handshake?: boolean }
  | { readonly kind: "audioError"; readonly error: AudioFailure }
  | { readonly kind: "audioFilter"; readonly filter?: AudioModel["filter"]; readonly source?: string; readonly query?: string }
  | { readonly kind: "audioRequested"; readonly command: AudioCommand }
  | { readonly kind: "audioFinished"; readonly error: AudioFailure | null; readonly confirmation?: DeleteConfirmation };
export const isAudioProposal = (p: { readonly kind: string }): p is AudioProposal =>
  ["audioReconnect", "audioSupported", "audioSnapshot", "audioError", "audioFilter", "audioRequested", "audioFinished"].includes(p.kind);
export const presentAudio = (audio: AudioModel, p: AudioProposal): AudioModel => {
  switch (p.kind) {
    case "audioReconnect": return { ...audio, error: null };
    case "audioSupported": return { ...audio, supported: p.supported };
    case "audioSnapshot": {
      const snapshot = p.handshake ? acceptAudioHandshake(audio.snapshot, p.snapshot, []) :
        audio.snapshot ? acceptAudioEvent(audio.snapshot, p.snapshot) : null;
      if (snapshot === null || snapshot === audio.snapshot) return audio;
      const rebound = snapshot.epoch !== audio.snapshot?.epoch || snapshot.rootGeneration !== audio.snapshot?.rootGeneration;
      return { ...audio, snapshot, confirmation: rebound ? null : audio.confirmation };
    }
    case "audioError": return { ...audio, error: p.error };
    case "audioFilter": return { ...audio, filter: p.filter ?? audio.filter, source: p.source ?? audio.source, query: p.query ?? audio.query };
    case "audioRequested": return { ...audio, busy: audio.busy + 1, error: null,
      confirmation: p.command.action === "cancelDelete" || p.command.action === "confirmDelete" ? null : audio.confirmation };
    case "audioFinished": {
      const confirmation = p.confirmation;
      const current = !confirmation || (confirmation.epoch === audio.snapshot?.epoch && confirmation.rootGeneration === audio.snapshot?.rootGeneration);
      return { ...audio, busy: Math.max(0, audio.busy - 1), error: p.error, confirmation: current ? confirmation ?? audio.confirmation : null };
    }
  }
};
