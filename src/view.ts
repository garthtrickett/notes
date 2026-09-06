// Pure model -> DOM. No components, no classes, no state. lit-html patches only
// what changed, so painting the whole tree on every microtask is cheap.

import { html, nothing, type TemplateResult } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { visible, type Model, type Note, type Proposal } from "./model.ts";

type Propose = (p: Proposal) => void;

const noteRow = (note: Note, openPath: string | null, propose: Propose) => html`
  <li>
    <button
      class="row ${note.path === openPath ? "open" : ""}"
      @click=${() => propose({ kind: "opened", path: note.path })}
    >
      <span class="path">${note.path}</span>
      ${note.pending
        ? html`<span class="dot" title="Not yet on GitHub">•</span>`
        : nothing}
    </button>
    <button
      class="delete"
      title="Delete ${note.path}"
      @click=${() => propose({ kind: "deleted", path: note.path })}
    >
      ×
    </button>
  </li>
`;

const newNoteField = (propose: Propose) => {
  const create = (input: HTMLInputElement) => {
    const path = input.value.trim();
    if (path === "") return;
    propose({ kind: "created", path });
    input.value = "";
  };
  return html`
    <form
      class="new"
      @submit=${(e: SubmitEvent) => {
        e.preventDefault();
        const input = (e.target as HTMLFormElement).querySelector("input");
        if (input) create(input);
      }}
    >
      <input id="new-path" placeholder="inbox/new-note.md" autocomplete="off" />
      <button type="submit">New</button>
    </form>
  `;
};

const editor = (model: Model, propose: Propose) => {
  const path = model.openPath;
  if (path === null) {
    return html`<p class="empty">No note open.</p>`;
  }
  return html`
    <textarea
      id="editor"
      spellcheck="false"
      @input=${(e: Event) =>
        propose({
          kind: "edited",
          path,
          body: (e.target as HTMLTextAreaElement).value,
        })}
    ></textarea>
  `;
};

// Every SyncError kind gets a sentence. Adding a sixth kind stops this
// compiling, which is the entire point of the union.
const syncMessage = (model: Model): string | null => {
  const e = model.syncError;
  if (e === null) return model.syncing ? "Syncing…" : null;
  switch (e.kind) {
    case "offline":
      return "Offline — your edits are saved here and will sync later.";
    case "conflict":
      return "That note changed on GitHub; your version was kept alongside it.";
    case "auth":
      return "GitHub rejected the token. Check it in settings.";
    case "notFound":
      return "That repo or branch is missing. Check it in settings.";
    case "github":
      return `GitHub returned ${e.status}. Retrying shortly.`;
  }
};

const status = (model: Model) => {
  const message = syncMessage(model);
  return message === null
    ? nothing
    : html`<p class="status" role="status">${message}</p>`;
};

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

export const view = (model: Model, propose: Propose): TemplateResult => {
  if (!model.hydrated) return html`<p class="empty">Loading…</p>`;

  const notes = visible(model).sort((a, b) => a.path.localeCompare(b.path));

  return html`
    <main>
      <nav>
        ${newNoteField(propose)}
        <ul>
          ${repeat(notes, (n) => n.path, (n) => noteRow(n, model.openPath, propose))}
        </ul>
      </nav>
      <section>${editor(model, propose)}</section>
      ${status(model)}
      ${model.error
        ? html`<p class="error" role="alert">${model.error}</p>`
        : nothing}
    </main>
  `;
};
