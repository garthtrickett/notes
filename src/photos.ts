import { Capacitor, registerPlugin } from "@capacitor/core";

export interface SharedPhoto {
  readonly key: string;
  readonly name: string;
  readonly mime: string;
}
export interface PhotoShare {
  readonly id: string;
  readonly receivedAt: number;
  readonly files: readonly SharedPhoto[];
}
export interface PhotoShares {
  readonly supported: boolean;
  readonly pending: () => Promise<readonly PhotoShare[]>;
  readonly read: (id: string, photo: SharedPhoto) => Promise<File>;
  readonly acknowledge: (id: string) => Promise<void>;
  readonly listen: (changed: () => void) => Promise<() => void>;
}

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid shared photo response.");
  return value as Record<string, unknown>;
};
const imageMime = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("image/") && value !== "image/svg+xml";

// Android is a boundary too: no native payload enters the loop unparsed.
export const parsePhotoShares = (raw: unknown): readonly PhotoShare[] => {
  const batches = object(raw).batches;
  if (!Array.isArray(batches)) throw new Error("Invalid shared photo list.");
  const seen = new Set<string>();
  return batches.map(value => {
    const batch = object(value);
    if (batch.schema !== 1 || typeof batch.id !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(batch.id) || seen.has(batch.id) ||
      typeof batch.receivedAt !== "number" || !Number.isSafeInteger(batch.receivedAt) || batch.receivedAt < 0 || batch.receivedAt > 8_640_000_000_000_000 ||
      !Array.isArray(batch.files) || batch.files.length < 1 || batch.files.length > 10)
      throw new Error("Invalid shared photo metadata.");
    seen.add(batch.id);
    return {
      id: batch.id,
      receivedAt: batch.receivedAt,
      files: batch.files.map((value, index) => {
        const file = object(value);
        if (file.key !== String(index) || typeof file.name !== "string" || !imageMime(file.mime))
          throw new Error("Invalid shared photo selection.");
        return { key: String(index), name: file.name, mime: file.mime };
      }),
    };
  });
};

interface NativePhotos {
  pending(): Promise<unknown>;
  read(options: { id: string; key: string }): Promise<unknown>;
  acknowledge(options: { id: string }): Promise<void>;
  addListener(name: "photosShared", callback: () => void): Promise<{ remove(): Promise<void> }>;
}
const plugin = registerPlugin<NativePhotos>("Photos");

export const nativePhotoShares = (): PhotoShares => {
  const supported = Capacitor.getPlatform() === "android";
  return {
    supported,
    pending: async () => supported ? parsePhotoShares(await plugin.pending()) : [],
    read: async (id, photo) => {
      if (!supported) throw new Error("Android photo sharing is unavailable.");
      const value = object(await plugin.read({ id, key: photo.key }));
      if (typeof value.uri !== "string" || !value.uri.startsWith("file:///") ||
          typeof value.name !== "string" || !imageMime(value.mime))
        throw new Error("The shared photo could not be opened.");
      const response = await fetch(Capacitor.convertFileSrc(value.uri));
      if (!response.ok) throw new Error("The shared photo could not be read.");
      return new File([await response.blob()], value.name, { type: value.mime });
    },
    acknowledge: async id => { if (supported) await plugin.acknowledge({ id }); },
    listen: async changed => {
      if (!supported) return () => {};
      const handle = await plugin.addListener("photosShared", changed);
      return () => { void handle.remove(); };
    },
  };
};
