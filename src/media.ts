// Attachment bytes, fetched when something needs to show them.
//
// The model holds every note, so anything on a note is held for as long as the
// app is open. Bytes cannot live there: a vault with a few clips in it would
// mean tens of megabytes of base64 strings resident on a phone, and base64 is a
// third larger again than the bytes it encodes.
//
// So the model holds the record and this holds the picture, keyed by path. An
// object URL rather than a data URL, because the bytes then sit in the browser's
// blob store instead of the JavaScript heap.

import * as idb from "./idb.ts";

export interface Media {
  // The URL to render, or null when the bytes are not here yet. Null is normal
  // and brief: asking begins the fetch, and the repaint that follows finds it.
  readonly urlFor: (path: string, mime: string) => string | null;
  readonly forget: (paths: readonly string[]) => void;
  readonly size: () => number;
}

export const createMedia = (
  db: IDBDatabase,
  onReady: () => void,
): Media => {
  const urls = new Map<string, string>();
  const loading = new Set<string>();
  // A path asked for and not in the store: never ask again, or every paint
  // starts another read that will not find it either.
  const absent = new Set<string>();

  const load = (path: string, mime: string): void => {
    if (loading.has(path) || absent.has(path)) return;
    loading.add(path);
    void idb
      .getBlob(db, path)
      .then((base64) => {
        loading.delete(path);
        if (base64 === null || base64 === "") {
          absent.add(path);
          return;
        }
        urls.set(path, URL.createObjectURL(toBlob(base64, mime)));
        onReady();
      })
      .catch(() => {
        loading.delete(path);
        absent.add(path);
      });
  };

  return {
    urlFor: (path, mime) => {
      const hit = urls.get(path);
      if (hit !== undefined) return hit;
      load(path, mime);
      return null;
    },
    forget: (paths) => {
      for (const path of paths) {
        const url = urls.get(path);
        // Revoking matters: an object URL keeps its blob alive until it is
        // released, so forgetting without this is the leak it was avoiding.
        if (url !== undefined) URL.revokeObjectURL(url);
        urls.delete(path);
        absent.delete(path);
      }
    },
    size: () => urls.size,
  };
};

const toBlob = (base64: string, mime: string): Blob => {
  const binary = atob(base64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mime });
};
