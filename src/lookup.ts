import { Capacitor, registerPlugin } from "@capacitor/core";
import { parseLookupCaptures, type LookupCapture } from "./lookup-capture.ts";

export interface LookupInbox {
  readonly supported: boolean;
  readonly pending: () => Promise<readonly LookupCapture[]>;
  readonly acknowledge: (id: string) => Promise<void>;
  readonly listen: (changed: () => void) => Promise<() => void>;
}
interface NativeLookup {
  pending(): Promise<unknown>;
  acknowledge(options: { id: string }): Promise<void>;
  addListener(name: "lookupCaptured", callback: () => void): Promise<{ remove(): Promise<void> }>;
}
const plugin = registerPlugin<NativeLookup>("Lookup");
export const nativeLookupInbox = (): LookupInbox => {
  const supported = Capacitor.getPlatform() === "android";
  return {
    supported,
    pending: async () => supported ? parseLookupCaptures(await plugin.pending()) : [],
    acknowledge: async id => { if (supported) await plugin.acknowledge({ id }); },
    listen: async changed => {
      if (!supported) return () => {};
      const handle = await plugin.addListener("lookupCaptured", changed);
      return () => { void handle.remove(); };
    },
  };
};
