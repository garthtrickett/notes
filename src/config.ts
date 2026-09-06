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

// Which editing surface this device uses. Deliberately *not* in the vault
// config: during the rollout the desktop can run CodeMirror while the phone
// stays on the textarea, and either can be moved back without touching the
// other. It goes away with the textarea path.

export type EditorKind = "textarea" | "codemirror";

const EDITOR_KEY = "notes.editor";

export const loadEditorKind = (storage: Storage): EditorKind =>
  storage.getItem(EDITOR_KEY) === "codemirror" ? "codemirror" : "textarea";

export const saveEditorKind = (storage: Storage, kind: EditorKind): void => {
  storage.setItem(EDITOR_KEY, kind);
};
