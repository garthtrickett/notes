// The GitHub API, and the only place HTTP statuses exist. Above this file a
// failure is a SyncError, never a number (parse at the boundary).
//
// Every method is on the Github interface so the loop can be handed a fake, and
// all of sync is testable with no network.

import { attemptAsync, err, ok, type Result } from "./result.ts";
import type { Config } from "./config.ts";
import type { Encoding } from "./model.ts";

export type SyncError =
  | { readonly kind: "offline" }
  | { readonly kind: "conflict" }
  | { readonly kind: "auth" }
  | { readonly kind: "rateLimited"; readonly retryAfterMs: number }
  | { readonly kind: "notFound" }
  | { readonly kind: "github"; readonly status: number };

export interface RemoteEntry {
  readonly path: string;
  readonly sha: string;
}

export interface Github {
  readonly manifest: () => Promise<Result<RemoteEntry[], SyncError>>;
  // The encoding decides whether the body is converted or passed through. An
  // attachment is already base64, and the Contents API wants base64, so
  // re-encoding it would be wrong twice.
  readonly read: (
    path: string,
    encoding: Encoding,
  ) => Promise<Result<string, SyncError>>;
  readonly write: (
    path: string,
    body: string,
    baseSha: string | null,
    encoding: Encoding,
  ) => Promise<Result<string, SyncError>>;
  readonly remove: (
    path: string,
    baseSha: string,
  ) => Promise<Result<void, SyncError>>;
}

// btoa alone mangles anything outside Latin-1, which for a notes app is the
// first accented character or emoji anyone types.
const encode = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const decode = (base64: string): string => {
  const binary = atob(base64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

// An allowlist, not a denylist. A symlink is reported as a blob whose content is
// the path it points at, so treating one as a note would show that path as the
// body — and saving it would replace the link with a plain file. Submodules are
// worse. Anything that is not an ordinary file is not a note.
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

const isRegularFile = (entry: { type?: string; mode?: string }): boolean =>
  entry.type === "blob" && REGULAR_FILE_MODES.has(entry.mode ?? "");

// Each path segment separately, because encodeURI leaves `?` and `#` alone — a
// note called `why?.md` would turn its own name into a query string. Splitting on
// `/` first keeps the separators that GitHub needs.
const encodePath = (path: string): string =>
  path.split("/").map(encodeURIComponent).join("/");

// GitHub answers a rate limit with 403, the same status it uses for a bad token.
// Telling someone their token was rejected sends them off to reissue a token
// that was working, so the headers decide which it is.
const responseToError = (res: Response): SyncError => {
  const status = res.status;

  if (status === 403 || status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const retryAfter = res.headers.get("retry-after");
    const reset = res.headers.get("x-ratelimit-reset");

    if (retryAfter !== null) {
      return { kind: "rateLimited", retryAfterMs: Number(retryAfter) * 1000 };
    }
    if (remaining === "0") {
      const resetMs = reset === null ? 0 : Number(reset) * 1000 - Date.now();
      return { kind: "rateLimited", retryAfterMs: Math.max(0, resetMs) };
    }
    return { kind: "auth" };
  }

  if (status === 401) return { kind: "auth" };
  if (status === 404) return { kind: "notFound" };
  return { kind: "github", status };
};

export const createGithub = (config: Config): Github => {
  const base = `https://api.github.com/repos/${config.owner}/${config.repo}`;
  const headers = {
    Authorization: `Bearer ${config.token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };

  const send = async (
    url: string,
    init?: RequestInit,
  ): Promise<Result<Response, SyncError>> => {
    // A thrown fetch means the network is unreachable, which is a different
    // thing from the server saying no.
    const sent = await attemptAsync(
      // GitHub sends `Cache-Control: private, max-age=60` on authenticated API
      // responses, so without this the browser happily serves a minute-old tree
      // and a note written on another device appears not to exist yet.
      () => fetch(url, { ...init, headers, cache: "no-store" }),
      (): SyncError => ({ kind: "offline" }),
    );
    return sent;
  };

  const json = async <T>(res: Response): Promise<Result<T, SyncError>> =>
    attemptAsync(
      () => res.json() as Promise<T>,
      (): SyncError => ({ kind: "github", status: res.status }),
    );

  return {
    manifest: async () => {
      const res = await send(
        `${base}/git/trees/${config.branch}?recursive=1`,
      );
      if (!res.ok) return res;
      if (!res.value.ok) return err(responseToError(res.value));

      const body = await json<{
        tree?: { path?: string; sha?: string; type?: string; mode?: string }[];
      }>(res.value);
      if (!body.ok) return body;

      const entries: RemoteEntry[] = (body.value.tree ?? [])
        .filter((e) => e.path && e.sha && isRegularFile(e))
        .map((e) => ({ path: e.path as string, sha: e.sha as string }));
      return ok(entries);
    },

    read: async (path, encoding) => {
      const res = await send(
        `${base}/contents/${encodePath(path)}?ref=${config.branch}`,
      );
      if (!res.ok) return res;
      if (!res.value.ok) return err(responseToError(res.value));

      const body = await json<{ content?: string }>(res.value);
      if (!body.ok) return body;
      const content = (body.value.content ?? "").replace(/\n/g, "");
      return ok(encoding === "base64" ? content : decode(content));
    },

    write: async (path, content, baseSha, encoding) => {
      const res = await send(`${base}/contents/${encodePath(path)}`, {
        method: "PUT",
        body: JSON.stringify({
          message: `notes: ${path}`,
          content: encoding === "base64" ? content : encode(content),
          branch: config.branch,
          ...(baseSha === null ? {} : { sha: baseSha }),
        }),
      });
      if (!res.ok) return res;

      // 409 is the compare-and-swap failing: the file moved on since baseSha.
      // 422 is GitHub's answer to creating a path that already exists, which is
      // the same situation reached from the other direction.
      if (res.value.status === 409 || res.value.status === 422) {
        return err({ kind: "conflict" });
      }
      if (!res.value.ok) return err(responseToError(res.value));

      const body = await json<{ content?: { sha?: string } }>(res.value);
      if (!body.ok) return body;

      const sha = body.value.content?.sha;
      if (!sha) return err({ kind: "github", status: res.value.status });
      return ok(sha);
    },

    remove: async (path, baseSha) => {
      const res = await send(`${base}/contents/${encodePath(path)}`, {
        method: "DELETE",
        body: JSON.stringify({
          message: `notes: delete ${path}`,
          sha: baseSha,
          branch: config.branch,
        }),
      });
      if (!res.ok) return res;
      if (res.value.status === 409) {
        return err({ kind: "conflict" });
      }
      // Already gone is the outcome we wanted.
      if (res.value.status === 404) return ok(undefined);
      if (!res.value.ok) return err(responseToError(res.value));
      return ok(undefined);
    },
  };
};
