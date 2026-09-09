import { describe, expect, it } from "bun:test";
import { bytesToBase64, canInstall, checkForUpdate, createB64Stream, installUpdate, parseRelease } from "./update.ts";

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

describe("bytesToBase64", () => {
  it("round-trips bytes, including across a chunk boundary", () => {
    const bytes = new Uint8Array(0x8002);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const back = Uint8Array.from(atob(bytesToBase64(bytes)), (c) => c.charCodeAt(0));
    expect(back).toEqual(bytes);
  });
});

describe("B64Stream", () => {
  it("round-trips across awkward chunk boundaries", () => {
    const bytes = new Uint8Array(100003);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 3) % 251;
    const stream = createB64Stream();
    // Splits deliberately misaligned to triple boundaries.
    let out = "";
    for (const size of [1, 2, 5, 4096, 65537, 7]) {
      let at = 0;
      while (at < bytes.length) {
        out += stream.push(bytes.slice(at, at + size));
        at += size;
      }
    }
    void out;
    // Single pass with 1-byte pushes is the adversarial case.
    const single = createB64Stream();
    let acc = "";
    for (let i = 0; i < bytes.length; i++) acc += single.push(bytes.slice(i, i + 1));
    acc += single.flush();
    const back = Uint8Array.from(atob(acc), (c) => c.charCodeAt(0));
    expect(back).toEqual(bytes);
  });

  it("flushes the carry", () => {
    const stream = createB64Stream();
    const head = stream.push(new Uint8Array([1, 2, 3, 4]));
    const tail = stream.flush();
    const back = Uint8Array.from(atob(head + tail), (c) => c.charCodeAt(0));
    expect(back).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(stream.flush()).toBe("");
  });
});
