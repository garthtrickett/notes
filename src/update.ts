// In-app updates, Android only. Check on boot, download on tap, hand to the
// system installer — which always takes one tap of its own. Silent install is
// not available outside the Play Store, so one tap is the ceiling and this
// reaches it.
//
// Everything native is dynamically imported behind isNativePlatform(). On the
// web this module loads and does nothing: the web updates through Vercel, and
// offering an APK there would be nonsense.

import { Capacitor } from "@capacitor/core";
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

// Chunked: spreading megabytes of bytes across one apply call blows the stack.
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

// Base64 in a stream. A chunk boundary mid-triple would emit padding into the
// middle of the output and corrupt the file, so 0-2 bytes carry over between
// pushes and only complete triples are encoded.
export interface B64Stream {
  push(chunk: Uint8Array): string;
  flush(): string;
}

export const createB64Stream = (): B64Stream => {
  let carry = new Uint8Array(0);
  return {
    push(chunk: Uint8Array): string {
      const combined = new Uint8Array(carry.length + chunk.length);
      combined.set(carry);
      combined.set(chunk, carry.length);
      const complete = combined.length - (combined.length % 3);
      carry = combined.slice(complete);
      return bytesToBase64(combined.slice(0, complete));
    },
    flush(): string {
      const out = carry.length > 0 ? bytesToBase64(carry) : "";
      carry = new Uint8Array(0);
      return out;
    },
  };
};

// The bytes travel fetch, not Filesystem.downloadFile. The release URL answers
// 302 with an empty body to a signed storage URL, and the plugin's downloader
// hangs on exactly that instead of following it — a banner stuck on
// "Downloading…" forever, which is how this was found. fetch follows redirects
// by specification, so the plugin only ever writes bytes it already holds.
// The timeout is the other half: whatever hangs next becomes a named failure
// after two minutes instead of a stuck banner.
export const downloadUpdate = async (
  url: string,
  // Observed, never awaited for control flow: lets the banner move from
  // "fetching" to "saving" while the bytes are in hand.
  onFetched: () => void,
): Promise<Proposal> => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) return { kind: "updateFailed", error: `Download failed: HTTP ${res.status}` };
    // Streamed, a chunk at a time: the previous shape built one 4.6 MB string
    // and pushed it over the bridge in a single writeFile, which is where a
    // ten-minute stuck-downloading came from. Small writes, each awaited.
    onFetched();
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    // A stale partial from an interrupted run must not prefix the new file.
    await Filesystem.deleteFile({ path: "update.apk", directory: Directory.Cache }).catch(() => undefined);
    const stream = createB64Stream();
    const reader = res.body?.getReader();
    if (reader === undefined) return { kind: "updateFailed", error: "Download failed: no response body" };
    let first = true;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = stream.push(value) + (done ? "" : "");
      if (text === "") continue;
      if (first) {
        await Filesystem.writeFile({ path: "update.apk", data: text, directory: Directory.Cache });
        first = false;
      } else {
        await Filesystem.appendFile({ path: "update.apk", data: text, directory: Directory.Cache });
      }
    }
    const tail = stream.flush();
    if (tail !== "") await Filesystem.appendFile({ path: "update.apk", data: tail, directory: Directory.Cache });
    const { uri } = await Filesystem.getUri({ path: "update.apk", directory: Directory.Cache });
    return { kind: "updateDownloaded", path: uri.replace(/^file:\/\//, "") };
  } catch (error) {
    return { kind: "updateFailed", error: `Download failed: ${String(error)}` };
  }
};

export interface Installer {
  canInstall(): Promise<boolean>;
  openInstallSettings(): Promise<void>;
  install(path: string): Promise<void>;
}

const installer = async (): Promise<Installer> => {
  const { registerPlugin } = await import("@capacitor/core");
  return registerPlugin<Installer>("Update");
};

// Hands the downloaded file to the system installer and returns. There is no
// result to wait for: if the user cancels, nothing happened, and the banner is
// already gone — which is the correct end state either way.
export const installUpdate = async (path: string): Promise<void> => {
  if (!Capacitor.isNativePlatform())
    throw new Error("installing an update needs the Android shell");
  await (await installer()).install(path);
};

// Three primitives; the loop orchestrates them. Split (rather than one
// ensure-style helper) so every step has a visible model state — a silent
// nothing was exactly the failure this flow shipped with first.
export const canInstall = async (): Promise<boolean> => {
  // The gate comes before any plugin touch. Calling a method on a plugin with
  // no native implementation does not reject — it crashes the process past any
  // try/catch — so every entry here checks the platform first.
  if (!Capacitor.isNativePlatform()) return false;
  return await (await installer()).canInstall();
};

export const openInstallSettings = async (): Promise<void> => {
  await (await installer()).openInstallSettings();
};
