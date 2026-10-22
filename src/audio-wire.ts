import { err, ok, type Result } from "./result.ts";

export interface AudioStamp {
  readonly epoch: string;
  readonly rootGeneration: number;
  readonly revision: number;
}
export type AudioFailureKind = "PERMISSION" | "MISSING" | "VERSION_CHANGED" | "UNSUPPORTED" |
  "STORAGE" | "PLAYBACK" | "CANCELLED" | "STALE" | "RECOVERY" | "BRIDGE";
export interface AudioFailure { readonly kind: AudioFailureKind; readonly message: string }
export interface AudioListening {
  readonly mark: "UNPLAYED" | "IN_PROGRESS" | "DONE";
  readonly positionMs: number;
  readonly durationMs: number | null;
}
export interface AudioRow {
  readonly item: string;
  readonly version: string;
  readonly path: string;
  readonly title: string;
  readonly author: string | null;
  readonly error?: string | null;
  readonly sizeBytes: number | null;
  readonly durationMs: number | null;
  readonly durableId: string | null;
  readonly listening: AudioListening | null;
}
export interface AudioHistory {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly author: string | null;
  readonly availability?: "PRESENT" | "MISSING" | "UNKNOWN" | "OTHER_ROOT";
  readonly deletion?: "INTENT" | "ABSENT" | "CHANGED" | null;
  readonly currentRoot: boolean;
  readonly listening: AudioListening;
}
export interface AudioPlayer {
  readonly item: string;
  readonly positionMs: number;
  readonly durationMs: number | null;
  readonly playing: boolean;
}
export interface AudioSnapshot extends AudioStamp {
  readonly protocol: 1;
  readonly rootSelected: boolean;
  readonly operation: string | null;
  readonly warning: string | null;
  readonly recoveryRequired: boolean;
  readonly failure: AudioFailure | null;
  readonly rows: readonly AudioRow[];
  readonly history: readonly AudioHistory[];
  readonly player: AudioPlayer | null;
}

const object = (raw: unknown): Record<string, unknown> | null =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
const text = (raw: unknown): raw is string => typeof raw === "string" && raw.length > 0;
const optionalText = (raw: unknown): raw is string | null => raw === null || typeof raw === "string";
const integer = (raw: unknown): raw is number => typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0;
const duration = (raw: unknown): raw is number | null => raw === null || integer(raw) && raw > 0;
const size = (raw: unknown): raw is number | null => raw === null || integer(raw);
const failureKinds: readonly string[] = ["PERMISSION", "MISSING", "VERSION_CHANGED", "UNSUPPORTED", "STORAGE", "PLAYBACK", "CANCELLED", "STALE", "RECOVERY", "BRIDGE"];
const listening = (raw: unknown): AudioListening | null => {
  const value = object(raw);
  if (!value || typeof value.mark !== "string" || !["UNPLAYED", "IN_PROGRESS", "DONE"].includes(value.mark) ||
      !integer(value.positionMs) || !duration(value.durationMs)) return null;
  return { mark: value.mark as AudioListening["mark"], positionMs: value.positionMs, durationMs: value.durationMs };
};

// Fail the whole message instead of dropping rows and risking a command aimed
// at a different item. Relative paths are display metadata, never authority.
export const parseAudioSnapshot = (raw: unknown): Result<AudioSnapshot, AudioFailure> => {
  const invalid = (): Result<never, AudioFailure> => err({ kind: "BRIDGE", message: "Notes returned an invalid audio snapshot. Update or reconnect the app." });
  const value = object(raw);
  if (!value || value.protocol !== 1 || !text(value.epoch) || !integer(value.rootGeneration) || !integer(value.revision) ||
      typeof value.rootSelected !== "boolean" || typeof value.recoveryRequired !== "boolean" ||
      !optionalText(value.operation) || !optionalText(value.warning) || !Array.isArray(value.rows) || value.rows.length > 10000 ||
      !Array.isArray(value.history) || value.history.length > 100000) return invalid();
  let failure: AudioFailure | null = null;
  if (value.failure !== null) {
    const problem = object(value.failure);
    if (!problem || typeof problem.kind !== "string" || !failureKinds.includes(problem.kind) || !text(problem.message)) return invalid();
    failure = { kind: problem.kind as AudioFailureKind, message: problem.message };
  }
  const rows: AudioRow[] = [], rowIds = new Set<string>();
  for (const rawRow of value.rows) {
    const row = object(rawRow);
    if (!row || !text(row.item) || !text(row.version) || !text(row.path) || !text(row.title) ||
        !optionalText(row.author) || !optionalText(row.durableId) || !size(row.sizeBytes) || !duration(row.durationMs) || rowIds.has(row.item)) return invalid();
    const progress = row.listening === null ? null : listening(row.listening);
    if (row.listening !== null && progress === null) return invalid();
    if (row.error !== undefined && !optionalText(row.error)) return invalid();
    rowIds.add(row.item);
    rows.push({ item: row.item, version: row.version, path: row.path, title: row.title, author: row.author,
      durableId: row.durableId, sizeBytes: row.sizeBytes, durationMs: row.durationMs, listening: progress, ...(row.error === undefined ? {} : { error: row.error as string | null }) });
  }
  const history: AudioHistory[] = [], historyIds = new Set<string>();
  for (const rawItem of value.history) {
    const item = object(rawItem);
    if (!item || !text(item.id) || !text(item.path) || !text(item.title) || !optionalText(item.author) ||
        typeof item.currentRoot !== "boolean" || historyIds.has(item.id)) return invalid();
    const progress = listening(item.listening); if (progress === null) return invalid();
    if (item.availability !== undefined && !["PRESENT", "MISSING", "UNKNOWN", "OTHER_ROOT"].includes(String(item.availability))) return invalid();
    if (item.deletion !== undefined && item.deletion !== null && !["INTENT", "ABSENT", "CHANGED"].includes(String(item.deletion))) return invalid();
    historyIds.add(item.id);
    history.push({ id: item.id, path: item.path, title: item.title, author: item.author, currentRoot: item.currentRoot, listening: progress,
      ...(item.availability === undefined ? {} : { availability: item.availability as Exclude<AudioHistory["availability"], undefined> }),
      ...(item.deletion === undefined ? {} : { deletion: item.deletion as Exclude<AudioHistory["deletion"], undefined> }) });
  }
  let player: AudioPlayer | null = null;
  if (value.player !== null) {
    const playing = object(value.player);
    if (!playing || !text(playing.item) || !historyIds.has(playing.item) || !integer(playing.positionMs) ||
        !duration(playing.durationMs) || typeof playing.playing !== "boolean") return invalid();
    player = { item: playing.item, positionMs: playing.positionMs, durationMs: playing.durationMs, playing: playing.playing };
  }
  if (rows.some(row => row.durableId !== null && !historyIds.has(row.durableId))) return invalid();
  return ok({ protocol: 1, epoch: value.epoch, rootGeneration: value.rootGeneration, revision: value.revision,
    rootSelected: value.rootSelected, operation: value.operation, warning: value.warning, recoveryRequired: value.recoveryRequired,
    failure, rows, history, player });
};
