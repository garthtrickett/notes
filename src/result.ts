// A failure is a value, not an exception. Nothing below this file throws into
// the loop; the untyped world is converted at the boundary by attempt/
// attemptAsync (principle 2).

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const attempt = <T, E>(
  fn: () => T,
  onThrow: (cause: unknown) => E,
): Result<T, E> => {
  try {
    return ok(fn());
  } catch (cause) {
    return err(onThrow(cause));
  }
};

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

export const combine = <T, E>(
  results: readonly Result<T, E>[],
): Result<T[], E[]> => {
  const values: T[] = [];
  const errors: E[] = [];
  for (const r of results) {
    if (r.ok) values.push(r.value);
    else errors.push(r.error);
  }
  return errors.length > 0 ? err(errors) : ok(values);
};
