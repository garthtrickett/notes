import { Capacitor, registerPlugin } from "@capacitor/core";
import type { Config } from "./config.ts";
import type { Model } from "./model.ts";

export interface WidgetSyncSnapshot {
  readonly state: "unknown" | "pending" | "syncing" | "synced" | "offline" | "error";
  readonly checkedAt: number | null;
  readonly pulledAt: number | null;
}

// The pull-start watermark is not proof that anything finished. The loop
// supplies a successful remote observation; dirty records still have to land
// on this device before the widget can call that observation synced.
export const widgetSyncSnapshot = (m: Model, checkedAt: number | null, configured: boolean, pulledAt: number | null): WidgetSyncSnapshot => {
  const state = !configured ? "unknown"
    : m.persistBlocked || m.photoShareFailure !== null || (m.syncError !== null && m.syncError.kind !== "offline") ? "error"
    : !m.online || m.syncError?.kind === "offline" ? "offline"
    : m.syncing || m.photosBusy > 0 ? "syncing"
    : m.forgotten.size > 0 || [...m.notes.values()].some(n => n.dirty || n.pending) ? "pending"
    : !m.hydrated || m.lastSyncedAt === null || m.pullRemaining > 0 || (checkedAt === null || pulledAt === null) ? "unknown"
    : "synced";
  return { state, checkedAt, pulledAt };
};

export type WidgetSyncReporter = (snapshot: WidgetSyncSnapshot) => Promise<void>;

// Serialise bridge writes and skip superseded waiting reports. A slow older
// reply must never overwrite a newer pending state. Indicator failure cannot
// interrupt note persistence, sync, or the alarm pipeline.
export const serialWidgetSyncReporter = (write: WidgetSyncReporter): WidgetSyncReporter => {
  let tail = Promise.resolve();
  let version = 0;
  let lastKey: string | null = null;
  return snapshot => {
    const key = JSON.stringify(snapshot);
    if (key === lastKey) return tail;
    lastKey = key;
    const next = ++version;
    tail = tail.then(async () => {
      if (next !== version) return;
      try { await write(snapshot); }
      catch { if (next === version) lastKey = null; }
    });
    return tail;
  };
};

interface NativeWidget {
  syncStatus(options: WidgetSyncSnapshot & { readonly vault: string }): Promise<void>;
}
const plugin = registerPlugin<NativeWidget>("Widget");

export const nativeWidgetSyncReporter = (config: Pick<Config, "owner" | "repo" | "branch"> | null): WidgetSyncReporter => {
  if (Capacitor.getPlatform() !== "android") return async () => {};
  const vault = config === null ? "" : `${config.owner}/${config.repo}@${config.branch}`;
  return serialWidgetSyncReporter(snapshot => plugin.syncStatus({
    vault, state: snapshot.state, checkedAt: snapshot.checkedAt, pulledAt: snapshot.pulledAt,
  }));
};
