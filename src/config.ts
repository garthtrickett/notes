// Owner, repo and token. The token is the user's own, on their own repo — not a
// secret from themselves — so localStorage is the right place for it.

export interface Config {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
  readonly branch: string;
}

const KEY = "notes.config";

export const loadConfig = (storage: Storage): Config | null => {
  const raw = storage.getItem(KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Config>;
    // Parse at the boundary: nothing above this returns a half-built config
    // (parse at the boundary).
    if (!parsed.owner || !parsed.repo || !parsed.token) return null;
    return {
      owner: parsed.owner,
      repo: parsed.repo,
      token: parsed.token,
      branch: parsed.branch || "vault",
    };
  } catch {
    return null;
  }
};

export const saveConfig = (storage: Storage, config: Config): void => {
  storage.setItem(KEY, JSON.stringify(config));
};
