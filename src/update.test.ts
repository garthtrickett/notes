import { describe, expect, it } from "bun:test";
import { canInstall, checkForUpdate, installUpdate, parseRelease } from "./update.ts";

const release = (version: number) => ({
  body: `Sideload build of abc.\n\nversionCode: ${version}`,
  assets: [{ browser_download_url: "https://example.com/notes.apk" }],
});

describe("parseRelease", () => {
  it("reads the version and the asset URL", () => {
    expect(parseRelease(release(42))).toEqual({
      version: 42,
      url: "https://example.com/notes.apk",
    });
  });

  it("refuses anything that is not a release", () => {
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease({})).toBeNull();
    expect(parseRelease({ body: "versionCode: 3", assets: [] })).toBeNull();
    expect(parseRelease({ body: "no version here", assets: release(3).assets })).toBeNull();
  });
});

describe("checkForUpdate", () => {
  const stubFetch = (json: unknown): typeof fetch =>
    (async () =>
      ({ ok: true, json: async () => json }) as unknown as Response) as unknown as typeof fetch;

  it("proposes an update when the release is newer", async () => {
    const p = await checkForUpdate(stubFetch(release(42)), 41, true);
    expect(p).toEqual({ kind: "updateFound", version: 42, url: "https://example.com/notes.apk" });
  });

  it("proposes nothing when up to date", async () => {
    const p = await checkForUpdate(stubFetch(release(42)), 42, true);
    expect(p).toBeNull();
  });

  it("proposes nothing when the release is unparseable", async () => {
    const p = await checkForUpdate(stubFetch({}), 41, true);
    expect(p).toBeNull();
  });

  it("proposes nothing when GitHub errors or the network is gone", async () => {
    const fail = (async () => ({ ok: false }) as unknown as Response) as unknown as typeof fetch;
    expect(await checkForUpdate(fail, 41, true)).toBeNull();
    const down = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    expect(await checkForUpdate(down, 41, true)).toBeNull();
  });

  it("stays silent when not native or unversioned", async () => {
    expect(await checkForUpdate(stubFetch(release(42)), 41, false)).toBeNull();
    expect(await checkForUpdate(stubFetch(release(42)), 0, true)).toBeNull();
  });
});

describe("the native gate", () => {
  // Invoking a method on a plugin with no native implementation does not
  // reject — it crashes past try/catch. So every entry checks the platform
  // first, and these settle instead of exploding.
  it("answers safely without a phone", async () => {
    await expect(canInstall()).resolves.toBe(false);
    await expect(installUpdate("/cache/update.apk")).rejects.toThrow();
  });
});
