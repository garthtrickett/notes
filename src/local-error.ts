// What can go wrong on this device, as a union rather than a sentence.
//
// The counterpart to SyncError. Actions report what happened; this file is the
// only place that decides how to say it, so an action never decides presentation
// (parse at the boundary).

export type LocalError =
  | { readonly kind: "readFailed"; readonly cause: string }
  | { readonly kind: "writeFailed"; readonly cause: string }
  | { readonly kind: "forgetFailed"; readonly cause: string }
  | { readonly kind: "imageUnreadable"; readonly cause: string }
  | { readonly kind: "imageTooBig"; readonly bytes: number }
  // Not the same failure. A clip or an animation is never resized — resizing
  // one means re-encoding it, which the browser will not do on a canvas — so
  // telling someone it is "still" too big "after resizing" describes work that
  // did not happen and suggests a fix that does not exist.
  | { readonly kind: "mediaTooBig"; readonly bytes: number; readonly limit: number };

// Exhaustive by construction: a new kind stops this compiling, which is the
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
    case "mediaTooBig": {
      const mb = (error.bytes / 1_000_000).toFixed(1);
      const cap = (error.limit / 1_000_000).toFixed(0);
      // Says what it is rather than what was attempted, and says what would
      // work, because the answer here is outside the app.
      return `That clip is ${mb} MB, over the ${cap} MB limit, so it was not added. It is kept as-is — animations and video cannot be re-encoded here — so shorten or compress it first. Git keeps binaries forever.`;
    }
  }
};
