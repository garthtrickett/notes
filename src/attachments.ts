// Pasting an image. Git keeps binaries forever, so the resize is not a nicety:
// one raw screenshot is permanent and only removable by rewriting history.

export const ATTACHMENT_DIR = "attachments";
// Tried in order, and the first one that fits wins. One pass at 2000px/0.85
// was a guess that a photo would come out small, and a big enough source — a
// long screenshot, a phone panorama — came out over the limit and was simply
// refused. Refusing is the wrong answer when the thing to do next is obvious:
// compress it harder.
const ATTEMPTS: readonly { edge: number; quality: number }[] = [
  { edge: 2000, quality: 0.85 },
  { edge: 2000, quality: 0.6 },
  { edge: 1400, quality: 0.6 },
  { edge: 1000, quality: 0.5 },
];
// After resizing, anything still this big is not a screenshot — refuse it rather
// than commit it.
export const MAX_BYTES = 1_000_000;
// Media that is not re-encoded gets a larger allowance, because the 1MB above
// is a statement about a shrunk screenshot rather than about what the vault can
// hold. Verified against the real repo: a 2,500,000-byte write through the
// Contents API is accepted, and reads back whole through the Blobs API.
export const MAX_PASSTHROUGH_BYTES = 8_000_000;

// The one list of what a media file is: which extensions count as binary, and
// what mime each becomes. Two lists would be a rule written twice, and the pair
// that matters most is that neither of them says svg — an SVG is a document
// that can carry script, and nothing in a vault needs one.
//
// Video is here because a vault of surfing clips is a real thing to keep, and
// because the alternative — a link out to somewhere else — breaks the moment
// the repo is private. Neither mp4 nor webm can carry script.
const IMAGE_MIME: Readonly<Record<string, string>> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  avif: "image/avif",
};

const VIDEO_MIME: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  webm: "video/webm",
};

const MEDIA_MIME: Readonly<Record<string, string>> = { ...IMAGE_MIME, ...VIDEO_MIME };

const BINARY_EXTENSIONS = new Set(
  Object.keys(MEDIA_MIME).map((ext) => `.${ext}`),
);

// What must not be re-encoded, and why.
//
// canvasShrinker draws one frame onto a canvas and asks for webp back. For a
// photo that is the point. For an animation it is the destruction of the thing
// — an animated GIF comes out a still, which is what "gifs don't play" was —
// and for a video createImageBitmap simply throws, so a clip could not be
// attached at all.
//
// So these pass through untouched, at their own extension.
const PASSTHROUGH: Readonly<Record<string, string>> = {
  gif: "image/gif",
  ...VIDEO_MIME,
};

// By the file's own type where the browser gives one, falling back to the name.
// A paste often has a type and no name; a dropped file always has a name.
export const passesThrough = (type: string, name: string): string | null => {
  for (const [ext, mime] of Object.entries(PASSTHROUGH)) {
    if (type === mime) return ext;
  }
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return ext in PASSTHROUGH ? ext : null;
};

export const isVideoPath = (path: string): boolean => {
  const dot = path.lastIndexOf(".");
  return dot !== -1 && `${path.slice(dot + 1).toLowerCase()}` in VIDEO_MIME;
};

// Decided by extension, not folder, so an image is an image wherever it sits.
export const isBinaryPath = (path: string): boolean => {
  const dot = path.lastIndexOf(".");
  return dot !== -1 && BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase());
};

export const isAttachmentPath = (path: string): boolean =>
  path.startsWith(`${ATTACHMENT_DIR}/`) || isBinaryPath(path);

const pad = (n: number): string => String(n).padStart(2, "0");

export const attachmentPath = (
  now: number,
  hash: string,
  ext = "webp",
): string => {
  const d = new Date(now);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  // Dated so it sorts, hashed so identical pastes collapse to one file rather
  // than accumulating copies.
  return `${ATTACHMENT_DIR}/${day}-${hash}.${ext}`;
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

// Null for anything not on the allowlist, so an unrenderable attachment is
// declined here rather than turned into a `data:image/svg` or `data:image/html`
// URL by taking the extension at its word.
//
// Previously safe only because encoding is set from the same extension list —
// but `moved` inherits encoding, so renaming x.webp to foo.svg walked straight
// past that. The check belongs where the URL is built.
// The mime a path implies, or null when it is not media this app will render.
export const mimeOf = (path: string): string | null => {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  return MEDIA_MIME[ext] ?? null;
};

export const dataUrlOf = (base64: string, path: string): string | null => {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  const mime = MEDIA_MIME[ext];
  return mime === undefined ? null : `data:${mime};base64,${base64}`;
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
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("This browser cannot resize images.");
  }

  let smallest: ArrayBuffer | null = null;
  for (const { edge, quality } of ATTEMPTS) {
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", quality),
    );
    if (!blob) continue;
    const bytes = await blob.arrayBuffer();
    // Kept even when it does not fit, so the caller reports the best that
    // could be done rather than the first attempt.
    if (smallest === null || bytes.byteLength < smallest.byteLength) {
      smallest = bytes;
    }
    if (bytes.byteLength <= MAX_BYTES) break;
  }
  bitmap.close();

  if (smallest === null) throw new Error("Could not re-encode the image.");
  return smallest;
};
