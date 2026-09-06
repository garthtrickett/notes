// What can go wrong on this device, as a union rather than a sentence.
//
// The counterpart to SyncError. Actions report what happened; this file is the
// only place that decides how to say it, so an action never decides presentation
// (principle 6).

export type LocalError =
  | { readonly kind: "readFailed"; readonly cause: string }
  | { readonly kind: "writeFailed"; readonly cause: string }
  | { readonly kind: "forgetFailed"; readonly cause: string }
  | { readonly kind: "imageUnreadable"; readonly cause: string }
  | { readonly kind: "imageTooBig"; readonly bytes: number };

// Exhaustive by construction: a sixth kind stops this compiling, which is the
// whole reason for the union.
export const describeLocal = (error: LocalError): string => {
  switch (error.kind) {
    case "readFailed":
      return "Could not read your notes from this device.";
    case "writeFailed":
      return "Could not save to this device. Your edits are still here, and will be written again shortly.";
    case "forgetFailed":
      return "Could not finish deleting on this device.";
    case "imageUnreadable":
      return "That image could not be read.";
    case "imageTooBig": {
      const mb = (error.bytes / 1_000_000).toFixed(1);
      return `That image is still ${mb} MB after resizing, so it was not added. Git keeps binaries forever.`;
    }
  }
};
