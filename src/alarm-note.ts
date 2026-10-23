import { Capacitor } from "@capacitor/core";
import { alarmPlugin as plugin } from "./notify.ts";

export interface AlarmNoteRequest { readonly id: string; readonly path: string }
export interface AlarmNoteInbox {
  readonly supported: boolean;
  pending(): Promise<AlarmNoteRequest | null>;
  acknowledge(id: string): Promise<void>;
  listen(changed: () => void): Promise<() => void>;
}
export const nativeAlarmNotes = (): AlarmNoteInbox => {
  const supported = Capacitor.getPlatform() === "android";
  return {
    supported,
    pending: async () => {
      if (!supported) return null;
      const request = (await plugin.pendingNote()).request;
      return request && typeof request.id === "string" && typeof request.path === "string"
        && request.id !== "" && request.path !== "" ? { id: request.id, path: request.path } : null;
    },
    acknowledge: async id => { if (supported) await plugin.acknowledgeNote({ id }); },
    listen: async changed => {
      if (!supported) return () => {};
      const handle = await plugin.addListener("noteRequested", changed);
      return () => { void handle.remove(); };
    },
  };
};
