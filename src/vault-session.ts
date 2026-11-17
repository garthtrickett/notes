// The visible app and the widget worker share IndexedDB. Hold one writer for
// its whole session, including async network replies, not just individual puts.
export const acquireVaultSession = async (): Promise<() => void> => {
  if (!navigator.locks) throw new Error("Background sync needs Android WebView with Web Locks support.");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let acquired!: () => void;
  let rejected!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { acquired = resolve; rejected = reject; });
  void navigator.locks.request("notes-vault-writer", async () => {
    acquired();
    await held;
  }).catch(rejected);
  await ready;
  return release;
};
