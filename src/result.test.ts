import { describe, expect, it } from "bun:test";
import { attemptAsync, err, ok } from "./result.ts";

describe("result", () => {
  it("carries a value", () => {
    const r = ok(3);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(3);
  });

  it("carries a typed error", () => {
    const r = err({ kind: "offline" as const });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("offline");
  });

  it("converts a rejection into a value", async () => {
    const r = await attemptAsync(
      () => Promise.reject(new Error("nope")),
      () => "failed",
    );
    expect(r).toEqual(err("failed"));
  });

  it("catches a synchronous throw from the thunk itself", async () => {
    // The thunk form matters: an expression that throws before producing a
    // promise is still caught.
    const r = await attemptAsync(
      () => {
        throw new Error("sync");
      },
      () => "failed",
    );
    expect(r).toEqual(err("failed"));
  });
});
