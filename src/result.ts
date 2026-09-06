// A failure is a value, not an exception. Nothing below this file throws into
// the loop; the untyped world is converted at the boundary by attemptAsync
// (principle 2).
//
// Deliberately only what is used. A synchronous attempt() and a combine() are
// the obvious next two, and they get written when something needs them
// (principle 8) — not before, or their signatures are a guess.

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const attemptAsync = async <T, E>(
  run: () => Promise<T>,
  onThrow: (cause: unknown) => E,
): Promise<Result<T, E>> => {
  try {
    return ok(await run());
  } catch (cause) {
    return err(onThrow(cause));
  }
};
