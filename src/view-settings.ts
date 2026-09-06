// The vault connection screen, shown before there is one and reachable again
// afterwards.
//
// Reachable afterwards is the point: the app tells you to "check it in settings"
// when GitHub rejects a token, and for a long time there was no way to get
// there. The only escape was clearing site data, which also throws away every
// note that has not synced yet.
//
// It shares nothing with the note view — no model, no proposals, no context — so
// it lives apart.

import { html, nothing, type TemplateResult } from "lit-html";

export interface VaultConfig {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
  readonly branch: string;
}

export const settingsView = (
  onSave: (c: VaultConfig) => void,
  current: VaultConfig | null = null,
  onCancel: (() => void) | null = null,
): TemplateResult => html`
  <form
    class="settings"
    @submit=${(e: SubmitEvent) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      const value = (name: string) =>
        (form.elements.namedItem(name) as HTMLInputElement).value.trim();
      if (!value("owner") || !value("repo") || !value("token")) return;
      onSave({
        owner: value("owner"),
        repo: value("repo"),
        token: value("token"),
        branch: value("branch") || "vault",
      });
    }}
  >
    <h1>${current === null ? "Connect your vault" : "Your vault"}</h1>
    <label>Owner <input name="owner" .value=${current?.owner ?? ""} autocomplete="off" /></label>
    <label>Repo <input name="repo" .value=${current?.repo ?? ""} autocomplete="off" /></label>
    <label>Branch <input name="branch" .value=${current?.branch ?? "vault"} autocomplete="off" /></label>
    <label>
      Token
      <input name="token" type="password" .value=${current?.token ?? ""} autocomplete="off" />
    </label>
    <p class="hint">
      A personal access token with contents write access to that repo. It stays
      in this browser.
    </p>
    <div class="settings-actions">
      ${onCancel === null
        ? nothing
        : html`<button type="button" @click=${onCancel}>Cancel</button>`}
      <button type="submit">Save</button>
    </div>
  </form>
`;
