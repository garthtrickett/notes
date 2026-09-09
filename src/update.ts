// In-app updates, Android only. Check on boot, download on tap, hand to the
// system installer — which always takes one tap of its own. Silent install is
// not available outside the Play Store, so one tap is the ceiling and this
// reaches it.
//
// Everything native is dynamically imported behind isNativePlatform(). On the
// web this module loads and does nothing: the web updates through Vercel, and
// offering an APK there would be nonsense.

import { Capacitor, registerPlugin } from "@capacitor/core";
import type { Proposal } from "./model.ts";

export interface Release {
  readonly version: number;
  readonly url: string;
}

// The CI release body carries a `versionCode: N` line (see the workflow); the
// asset URL is whatever GitHub names the file, so it is read rather than
// constructed.
// Dummy-commit anchor: the first release carrying the updater (versionCode 6)
// was proven by pushing a no-op and watching this parser fire on the phone.
export const parseRelease = (json: unknown): Release | null => {
  if (typeof json !== "object" || json === null) return null;
  const body =
    "body" in json && typeof json.body === "string" ? json.body : "";
  const assets =
    "assets" in json && Array.isArray(json.assets) ? json.assets : [];
  const first = assets[0];
  const url =
    typeof first === "object" &&
    first !== null &&
    "browser_download_url" in first &&
    typeof first.browser_download_url === "string"
      ? first.browser_download_url
      : null;
  const match = /^versionCode: (\d+)$/m.exec(body);
  if (url === null || match === null || match[1] === undefined) return null;
  return { version: Number(match[1]), url };
};

export const currentVersion = (): number => {
  // The global only exists in a Vite build; under tests (and anywhere else)
  // the reference itself would throw, so typeof guards it first.
  const stamped: unknown =
    typeof __APP_VERSION_CODE__ !== "undefined" ? __APP_VERSION_CODE__ : "0";
  const n = typeof stamped === "string" ? Number(stamped) : NaN;
  return Number.isInteger(n) && n > 0 ? (n as number) : 0;
};

// A failed check is silence, not an error proposal. It runs on boot, often
// offline, and an error toast for "could not ask GitHub about updates" on
// every tunnel would be the app crying wolf.
export const checkForUpdate = async (
  fetchImpl: typeof fetch,
  current: number = currentVersion(),
  // Injected so tests can run the whole path without a phone. Defaults to the
  // real answer, which is the only thing production passes.
  native: boolean = Capacitor.isNativePlatform(),
): Promise<Proposal | null> => {
  if (!native) return null;
  if (current <= 0) return null;
  try {
    const res = await fetchImpl(
      "https://api.github.com/repos/garthtrickett/notes/releases/tags/android-apk",
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) return null;
    const release = parseRelease(await res.json());
    if (release === null || release.version <= current) return null;
    return { kind: "updateFound", version: release.version, url: release.url };
  } catch {
    return null;
  }
};

// The download happens in Java, not here. A release asset answers with no
// Access-Control-Allow-Origin header, so fetch() from the WebView's origin is
// refused before a byte arrives — proven against the real URL in a real
// engine, which rejects it in under half a second. No amount of reshaping the
// JavaScript could have worked, and reshaping it three times is how this was
// finally found. The native side has no CORS, follows the 302 to the signed
// storage host by hand, and writes straight to the cache directory, so the
// megabytes never become a base64 string on a bridge call either.
// Deliberately console, not a model state: this has to survive in a release
// build on a device with no debugger attached, and Capacitor forwards console
// to logcat once loggingBehavior is 'production'.
export const trace = (step: string): void => {
  console.log(`[update] ${step}`);
};

export const downloadUpdate = async (url: string): Promise<Proposal> => {
  trace(`download start ${url}`);
  if (!Capacitor.isNativePlatform())
    return { kind: "updateFailed", error: "Download failed: needs the Android shell" };
  try {
    trace("download bridge call issued");
    const { path } = await installer().download({ url });
    trace(`download bridge resolved ${path}`);
    return { kind: "updateDownloaded", path };
  } catch (error) {
    trace(`download bridge threw ${String(error)}`);
    return { kind: "updateFailed", error: `Download failed: ${String(error)}` };
  }
};

// Every method answers with a JSObject, because that is what a Capacitor
// bridge call returns; typing canInstall as a bare boolean made the refusal
// { allowed: false } a truthy object and the permission gate never fired.
export interface Installer {
  canInstall(): Promise<{ allowed: boolean }>;
  openInstallSettings(): Promise<void>;
  install(options: { path: string }): Promise<void>;
  download(options: { url: string }): Promise<{ path: string }>;
}

// Synchronous, and it must stay that way. Returning the plugin from an async
// function meant awaiting it, and awaiting a value makes the promise machinery
// look for a .then on it — but this is a Capacitor proxy, which turns every
// property access into a bridge call. So the await invoked Update.then(),
// which no native plugin implements, and the promise it was resolving never
// settled. That is the hang: the banner said Downloading forever because
// canInstall never came back and the download was never reached. It survived
// four rewrites of the download because none of them were ever run.
//
// The tests missed it because both entries check isNativePlatform() first and
// return before touching the plugin, so off a phone this line never executed.
const installer = (): Installer => registerPlugin<Installer>("Update");

// Hands the downloaded file to the system installer and returns. There is no
// result to wait for: if the user cancels, nothing happened, and the banner is
// already gone — which is the correct end state either way.
export const installUpdate = async (path: string): Promise<void> => {
  if (!Capacitor.isNativePlatform())
    throw new Error("installing an update needs the Android shell");
  await installer().install({ path });
};

// Three primitives; the loop orchestrates them. Split (rather than one
// ensure-style helper) so every step has a visible model state — a silent
// nothing was exactly the failure this flow shipped with first.
export const canInstall = async (): Promise<boolean> => {
  // The gate comes before any plugin touch. Calling a method on a plugin with
  // no native implementation does not reject — it crashes the process past any
  // try/catch — so every entry here checks the platform first.
  trace(`canInstall native=${String(Capacitor.isNativePlatform())}`);
  if (!Capacitor.isNativePlatform()) return false;
  trace("canInstall bridge call issued");
  const answer = await installer().canInstall();
  trace(`canInstall bridge resolved ${JSON.stringify(answer)}`);
  return answer.allowed;
};

export const openInstallSettings = async (): Promise<void> => {
  await installer().openInstallSettings();
};
