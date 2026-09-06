import { afterEach, describe, expect, it } from "bun:test";
import { createGithub } from "./github.ts";
import type { Config } from "./config.ts";

const config: Config = {
  owner: "o",
  repo: "r",
  token: "t",
  branch: "vault",
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// `typeof fetch` carries extras like preconnect that a stub has no business
// implementing, so install the stub through one narrow cast in one place.
interface FetchStub {
  (...args: unknown[]): Promise<Response>;
  calls: unknown[][];
}

const install = (body: unknown, status = 200): FetchStub => {
  const calls: unknown[][] = [];
  const stub = Object.assign(
    async (...args: unknown[]) => {
      calls.push(args);
      return new Response(JSON.stringify(body), { status });
    },
    { calls },
  );
  globalThis.fetch = stub as unknown as typeof fetch;
  return stub;
};

describe("manifest", () => {
  it("keeps ordinary files and drops everything that is not one", async () => {
    install({
      tree: [
        { path: "a.md", sha: "s1", type: "blob", mode: "100644" },
        { path: "run.sh", sha: "s2", type: "blob", mode: "100755" },
        // A symlink is a blob whose content is the path it points at. Treated as
        // a note it would show that path as its body, and saving it would
        // replace the link with a plain file.
        { path: "CLAUDE.md", sha: "s3", type: "blob", mode: "120000" },
        { path: "inbox", sha: "s4", type: "tree", mode: "040000" },
        { path: "vendor", sha: "s5", type: "commit", mode: "160000" },
      ],
    });
    const result = await createGithub(config).manifest();
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.map((e) => e.path)).toEqual(["a.md", "run.sh"]);
  });

  it("bypasses the browser cache, or another device's note looks absent", async () => {
    const fetchMock = install({ tree: [] });
    await createGithub(config).manifest();
    const [, init] = fetchMock.calls[0]!;
    // GitHub sends Cache-Control: private, max-age=60 on authenticated
    // responses, so without this a note written elsewhere stays invisible for
    // up to a minute and pull-on-focus appears to do nothing.
    expect((init as RequestInit).cache).toBe("no-store");
  });

  it("maps 401 to auth rather than leaking a status", async () => {
    install({}, 401);
    const result = await createGithub(config).manifest();
    expect(result).toEqual({ ok: false, error: { kind: "auth" } });
  });

  it("maps an unreachable network to offline", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const result = await createGithub(config).manifest();
    expect(result).toEqual({ ok: false, error: { kind: "offline" } });
  });

  it("does not call a rate limit a bad token", async () => {
    // GitHub answers both with 403. Telling someone their token was rejected
    // sends them off to reissue a token that was working.
    globalThis.fetch = (async () =>
      new Response("{}", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" },
      })) as unknown as typeof fetch;
    const result = await createGithub(config).manifest();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("rateLimited");
  });

  it("honours retry-after on a secondary rate limit", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 429, headers: { "retry-after": "120" } })) as unknown as typeof fetch;
    const result = await createGithub(config).manifest();
    if (result.ok) throw new Error("expected a failure");
    expect(result.error).toEqual({ kind: "rateLimited", retryAfterMs: 120_000 });
  });

  it("still calls a genuine 403 an auth problem", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 403 })) as unknown as typeof fetch;
    const result = await createGithub(config).manifest();
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.kind).toBe("auth");
  });

  it("escapes a path segment, not just the spaces in it", async () => {
    const fetchMock = install({ content: { sha: "new" } });
    // encodeURI leaves ? and # alone, so `why?.md` turned its own name into a
    // query string and the write went to the wrong place.
    await createGithub(config).write("inbox/why?.md", "body", null, "utf8");
    const [url] = fetchMock.calls[0]!;
    expect(url).toContain("/contents/inbox/why%3F.md");
    expect(url).not.toContain("why?.md");
  });

  it("keeps the slashes that separate segments", async () => {
    const fetchMock = install({ content: { sha: "new" } });
    await createGithub(config).write("a/b/c.md", "body", null, "utf8");
    expect(fetchMock.calls[0]![0]).toContain("/contents/a/b/c.md");
  });

  it("maps an unexpected status to github with the number", async () => {
    install({}, 503);
    const result = await createGithub(config).manifest();
    expect(result).toEqual({
      ok: false,
      error: { kind: "github", status: 503 },
    });
  });
});

describe("read and write", () => {
  it("round-trips text outside Latin-1", async () => {
    // btoa alone throws or mangles here, which for a notes app is the first
    // accented character or emoji anyone types.
    const text = "日本語 café 🎉\n";
    const encoded = Buffer.from(text, "utf8").toString("base64");
    install({ content: encoded });

    const result = await createGithub(config).read("a.md", "utf8");
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toBe(text);
  });

  it("sends the base sha so GitHub can refuse a stale write", async () => {
    const fetchMock = install({ content: { sha: "new" } });

    await createGithub(config).write("a.md", "body", "old-sha", "utf8");

    const [, init] = fetchMock.calls[0]!;
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.sha).toBe("old-sha");
    expect(sent.branch).toBe("vault");
    expect(Buffer.from(sent.content, "base64").toString("utf8")).toBe("body");
  });

  it("omits sha entirely when the note has never existed remotely", async () => {
    const fetchMock = install({ content: { sha: "new" } });

    await createGithub(config).write("a.md", "body", null, "utf8");

    const [, init] = fetchMock.calls[0]!;
    const sent = JSON.parse((init as RequestInit).body as string);
    expect("sha" in sent).toBe(false);
  });

  it("turns 409 into a conflict, which is the whole compare-and-swap", async () => {
    install({}, 409);
    const result = await createGithub(config).write("a.md", "body", "stale", "utf8");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });

  it("treats 422 as a conflict too — the same collision from the other side", async () => {
    install({}, 422);
    const result = await createGithub(config).write("a.md", "body", null, "utf8");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });
});

describe("remove", () => {
  it("treats an already-missing file as success", async () => {
    install({}, 404);
    const result = await createGithub(config).remove("a.md", "sha");
    expect(result.ok).toBe(true);
  });
});
