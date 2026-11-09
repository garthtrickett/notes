// A tab's location is UI state, never vault content. The device copy is only
// a fallback for a fresh tab/native process; existing tabs restore themselves.
import type { Mode } from "./model.ts";
import type { VaultConfig } from "./view-settings.ts";

export interface ViewLocation {
  readonly mode: Mode;
  readonly openPath: string | null;
  readonly preview: boolean;
}

export const emptyLocation: ViewLocation = { mode: "notes", openPath: null, preview: false };
const modes: readonly string[] = ["notes", "dump", "tasks", "archive", "trash", "settings", "audio"];

export const parseLocation = (value: unknown): ViewLocation | null => {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.mode !== "string" || !modes.includes(v.mode) || typeof v.preview !== "boolean" ||
      (v.openPath !== null && (typeof v.openPath !== "string" || v.openPath.length === 0 || v.openPath.length > 4096))) return null;
  return { mode: v.mode as Mode, openPath: v.openPath as string | null, preview: v.preview };
};

export const locationKey = (v: ViewLocation): string => JSON.stringify([v.mode, v.openPath, v.preview]);
const storageKey = (c: VaultConfig): string =>
  `notes.view.${JSON.stringify([c.owner.toLowerCase(), c.repo.toLowerCase(), c.branch])}`;

const read = (storage: Pick<Storage, "getItem">, key: string): ViewLocation | null => {
  try { return parseLocation(JSON.parse(storage.getItem(key) ?? "null")); }
  catch { return null; }
};

export const loadLocation = (
  tab: Pick<Storage, "getItem">, device: Pick<Storage, "getItem">, vault: VaultConfig,
): ViewLocation | null => read(tab, storageKey(vault)) ?? read(device, storageKey(vault));

export const saveLocation = (
  tab: Pick<Storage, "setItem">, device: Pick<Storage, "setItem">, vault: VaultConfig, location: ViewLocation,
): void => {
  for (const storage of [tab, device]) {
    try { storage.setItem(storageKey(vault), JSON.stringify(location)); }
    catch { /* A blocked/full preference store must not interrupt editing. */ }
  }
};
