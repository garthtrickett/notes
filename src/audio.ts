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
