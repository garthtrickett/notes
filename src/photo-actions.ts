import { attach } from "./actions.ts";
import type { Shrinker } from "./attachments.ts";
import type { LocalError } from "./local-error.ts";
import type { Note, NoteRecord } from "./model.ts";
import { uniquePath } from "./paths.ts";
import type { PhotoShare, PhotoShares } from "./photos.ts";
import type { Result } from "./result.ts";

export const photoNotePath = (share: PhotoShare, occupied: ReadonlySet<string>): string => {
  const date = new Date(share.receivedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return uniquePath(`inbox/Photo ${stamp} ${share.id.slice(0, 8)}.md`, candidate => occupied.has(candidate));
};

export interface PreparedPhotoShare {
  readonly note: NoteRecord;
  readonly attachments: readonly { readonly record: NoteRecord; readonly base64: string }[];
}

// Sharing and choosing a file use the same resize, limit, hash and reference.
export const preparePhotoShare = async (
  share: PhotoShare,
  path: string,
  read: PhotoShares["read"],
  shrink: Shrinker,
): Promise<Result<PreparedPhotoShare, LocalError>> => {
  const host: Note = { path, body: "# Photo\n\n", baseSha: null,
    pending: true, deleted: false, dirty: false, encoding: "utf8" };
  const attachments: { record: NoteRecord; base64: string }[] = [];
  const refs: string[] = [];
  for (const metadata of share.files) {
    let photo: File;
    try { photo = await read(share.id, metadata); }
    catch (cause) { return { ok: false, error: { kind: "imageUnreadable", cause: String(cause) } }; }
    const prepared = await attach(photo, host, 0, () => share.receivedAt, shrink);
    if (prepared.kind !== "attached") {
      if (prepared.kind === "failed") return { ok: false, error: prepared.error };
      throw new Error("Unexpected photo preparation result.");
    }
    attachments.push({ record: { path: prepared.path, body: "", baseSha: null,
      pending: true, deleted: false, encoding: "base64" }, base64: prepared.base64 });
    refs.push(prepared.ref);
  }
  return { ok: true, value: { note: { path, body: host.body + refs.join("\n\n") + "\n",
    baseSha: null, pending: true, deleted: false, encoding: "utf8" }, attachments } };
};
