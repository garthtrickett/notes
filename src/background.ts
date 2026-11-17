import { boot } from "./loop.ts";
import { openDb } from "./idb.ts";
import { loadConfig } from "./config.ts";
import { createGithub } from "./github.ts";
import { canvasShrinker } from "./attachments.ts";
import { parseLookupCaptures } from "./lookup-capture.ts";
import { parsePhotoShares } from "./photos.ts";
import { acquireVaultSession } from "./vault-session.ts";
import { receiveAlarmAnswers } from "./alarm-inbox.ts";
import { alarmsWanted, alarmsLive } from "./notify.ts";
import { nativeTaskLinks } from "./task-links.ts";
import type { Loop } from "./loop.ts";
import { serialWidgetSyncReporter } from "./widget-sync.ts";

declare global {
  interface Window {
    NotesSync: { call(id: number, method: string, payload: string): void };
    notesSyncReply(id: number, ok: boolean, result: unknown): void;
  }
}
let next = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(reason: Error): void }>();
window.notesSyncReply = (id, ok, result) => {
  const reply = pending.get(id);
  if (!reply) return;
  pending.delete(id);
  if (ok) reply.resolve(result); else reply.reject(new Error("The background operation failed."));
};
const call = <T>(method: string, payload: unknown = {}): Promise<T> => new Promise((resolve, reject) => {
  const id = ++next;
  pending.set(id, { resolve: value => resolve(value as T), reject });
  window.NotesSync.call(id, method, JSON.stringify(payload));
});

// Same origin, IndexedDB and sync loop as the visible app. The Web Lock also
// prevents a newly opened activity from hydrating stale records mid-transfer.
let loop: Loop | undefined;
let release: (() => void) | undefined;
let db: IDBDatabase | undefined;
let ok = false;
let statusTail: Promise<void> = Promise.resolve();
const report = serialWidgetSyncReporter(snapshot => {
  const config = loadConfig(localStorage);
  const vault = config ? `${config.owner}/${config.repo}@${config.branch}` : "";
  return call<void>("status", { vault, ...snapshot });
});
try {
  if (typeof window.NotesSync?.call !== "function") throw new Error("Native sync bridge required.");
  release = await acquireVaultSession();
  const config = loadConfig(localStorage);
  if (!config) throw new Error("Open Notes once to configure the vault.");
  db = await openDb();
  loop = await boot({
    db, config, github: createGithub(config), shrink: canvasShrinker,
    now: () => Date.now(), schedule: (ms, fire) => { setTimeout(fire, ms); },
    widgetSync: snapshot => {
      statusTail = report(snapshot);
      return statusTail;
    },
    lookupInbox: {
      supported: true,
      pending: async () => parseLookupCaptures(await call("lookups")),
      acknowledge: id => call<void>("lookupAck", { id }),
      listen: async () => () => {},
    },
    photoShares: {
      supported: true,
      pending: async () => parsePhotoShares(await call("photos")),
      read: async (id, photo) => {
        const response = await fetch(`/_sync_photo/${id}/${photo.key}`);
        if (!response.ok) throw new Error("Could not read shared photo.");
        return new File([await response.blob()], photo.name, { type: photo.mime });
      },
      acknowledge: id => call<void>("photoAck", { id }),
      listen: async () => () => {},
    },
    backgroundReminders: (refs, shas) => call<void>("alarms", {
      alarms: alarmsWanted(refs, Date.now()), live: alarmsLive(refs), links: nativeTaskLinks(refs), shas,
    }),
  }, document.getElementById("app")!);
  // Persist every imported answer before acknowledging the native queue.
  if (!await receiveAlarmAnswers(loop, () => call("answers"), receipts => call<void>("answersAck", { receipts })))
    throw new Error("Could not save alarm answers.");
  ok = await loop.whenSynced();
  await statusTail.catch(() => {});
} catch { /* Native UI reports a problem; no private data is logged. */ }
finally {
  loop?.dispose();
  db?.close();
  // On failure, retain the writer lock until Android destroys this WebView:
  // a timed-out fetch may still have a continuation queued in this page.
  if (ok) release?.();
  if (typeof window.NotesSync?.call === "function") await call("finished", { ok });
}
