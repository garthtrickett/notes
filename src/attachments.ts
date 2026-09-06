// Pasting an image. Git keeps binaries forever, so the resize is not a nicety:
// one raw screenshot is permanent and only removable by rewriting history.

export const ATTACHMENT_DIR = "attachments";
const MAX_EDGE = 2000;
const QUALITY = 0.85;
// After resizing, anything still this big is not a screenshot — refuse it rather
// than commit it.
export const MAX_BYTES = 1_000_000;

const BINARY_EXTENSIONS = new Set([
  ".webp",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".avif",
]);

// Decided by extension, not folder, so an image is an image wherever it sits.
export const isBinaryPath = (path: string): boolean => {
  const dot = path.lastIndexOf(".");
  return dot !== -1 && BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase());
};

export const isAttachmentPath = (path: string): boolean =>
  path.startsWith(`${ATTACHMENT_DIR}/`) || isBinaryPath(path);

const pad = (n: number): string => String(n).padStart(2, "0");

export const attachmentPath = (now: number, hash: string): string => {
  const d = new Date(now);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  // Dated so it sorts, hashed so identical pastes collapse to one file rather
  // than accumulating copies.
  return `${ATTACHMENT_DIR}/${day}-${hash}.webp`;
};

export const shortHash = async (bytes: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

export const base64Of = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes);
  let binary = "";
  // Chunked, because spreading a few hundred thousand arguments into
  // String.fromCharCode blows the call stack.
  for (let i = 0; i < view.length; i += 8192) {
    binary += String.fromCharCode(...view.subarray(i, i + 8192));
  }
  return btoa(binary);
};

export const dataUrlOf = (base64: string, path: string): string => {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "webp" : path.slice(dot + 1).toLowerCase();
  const type = ext === "jpg" ? "jpeg" : ext;
  return `data:image/${type};base64,${base64}`;
};

// Inserts the markdown reference where the cursor was, rather than appending —
// pasting into the middle of a sentence should behave like pasting.
export const insertAt = (body: string, at: number, text: string): string => {
  const cut = Math.max(0, Math.min(at, body.length));
  return `${body.slice(0, cut)}${text}${body.slice(cut)}`;
};

export interface Shrinker {
  (file: Blob): Promise<ArrayBuffer>;
}

// The only part that needs a browser, so it is injected and everything else is
// testable without one.
export const canvasShrinker: Shrinker = async (file) => {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot resize images.");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", QUALITY),
  );
  if (!blob) throw new Error("Could not re-encode the image.");
  return blob.arrayBuffer();
};
