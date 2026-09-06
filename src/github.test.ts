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

    const result = await createGithub(config).read("a.md");
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toBe(text);
  });

  it("sends the base sha so GitHub can refuse a stale write", async () => {
    const fetchMock = install({ content: { sha: "new" } });

    await createGithub(config).write("a.md", "body", "old-sha");

    const [, init] = fetchMock.calls[0]!;
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.sha).toBe("old-sha");
    expect(sent.branch).toBe("vault");
    expect(Buffer.from(sent.content, "base64").toString("utf8")).toBe("body");
  });

  it("omits sha entirely when the note has never existed remotely", async () => {
    const fetchMock = install({ content: { sha: "new" } });

    await createGithub(config).write("a.md", "body", null);

    const [, init] = fetchMock.calls[0]!;
    const sent = JSON.parse((init as RequestInit).body as string);
    expect("sha" in sent).toBe(false);
  });

  it("turns 409 into a conflict, which is the whole compare-and-swap", async () => {
    install({}, 409);
    const result = await createGithub(config).write("a.md", "body", "stale");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });

  it("treats 422 as a conflict too — the same collision from the other side", async () => {
    install({}, 422);
    const result = await createGithub(config).write("a.md", "body", null);
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
