import { Capacitor, registerPlugin } from "@capacitor/core";
import type { Loop } from "./loop.ts";
import { receiveAlarmAnswers } from "./alarm-inbox.ts";
import { takeAlarmAnswers, acknowledgeAlarmAnswers } from "./notify.ts";

const widget = registerPlugin<{
  addListener(name: "syncRequested", callback: (event: { request: string }) => void): Promise<{ remove(): Promise<void> }>;
  syncFinished(options: { request: string; ok: boolean }): Promise<void>;
}>("Widget");

export const listenForWidgetRefresh = async (loop: Loop): Promise<void> => {
  if (Capacitor.getPlatform() !== "android") return;
  let busy = false;
  let latestRequest = "";
  await widget.addListener("syncRequested", ({ request }) => {
    latestRequest = request;
    if (busy) return;
    busy = true;
    void (async () => {
      let ok = false;
      try {
        if (!await receiveAlarmAnswers(loop, takeAlarmAnswers, acknowledgeAlarmAnswers)) return;
        loop.propose({ kind: "online", online: true });
        loop.propose({ kind: "resumed" });
        ok = await loop.whenSynced();
      } catch { /* Native inbox copies survive for the next explicit retry. */ }
      finally {
        busy = false;
        await widget.syncFinished({ request: latestRequest, ok });
      }
    })();
  });
};
