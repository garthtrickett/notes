// The screen shown before a vault is connected.
//
// It shares nothing with the note view — no model, no proposals, no context — so
// it lives apart rather than adding an eighth thing to a file that was already
// holding seven.

import { html, type TemplateResult } from "lit-html";

export const settingsView = (
  onSave: (c: {
    owner: string;
    repo: string;
    token: string;
    branch: string;
  }) => void,
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
    <h1>Connect your vault</h1>
    <label>Owner <input name="owner" autocomplete="off" /></label>
    <label>Repo <input name="repo" autocomplete="off" /></label>
    <label>Branch <input name="branch" value="vault" autocomplete="off" /></label>
    <label>
      Token
      <input name="token" type="password" autocomplete="off" />
    </label>
    <p class="hint">
      A personal access token with contents write access to that repo. It stays
      in this browser.
    </p>
    <button type="submit">Save</button>
  </form>
`;
