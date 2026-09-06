// Pure model -> DOM. No components, no classes, no state. lit-html patches only
// what changed, so painting the whole tree on every microtask is cheap.

import { html, nothing, type TemplateResult } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import type { Model, Note, Proposal } from "./model.ts";

type Propose = (p: Proposal) => void;

const noteRow = (note: Note, openPath: string | null, propose: Propose) => html`
  <li>
    <button
      class="row ${note.path === openPath ? "open" : ""}"
      @click=${() => propose({ kind: "opened", path: note.path })}
    >
      <span class="path">${note.path}</span>
      ${note.dirty ? html`<span class="dot" title="Unsaved">•</span>` : nothing}
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

export const view = (model: Model, propose: Propose): TemplateResult => {
  if (!model.hydrated) return html`<p class="empty">Loading…</p>`;

  const notes = [...model.notes.values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );

  return html`
    <main>
      <nav>
        ${newNoteField(propose)}
        <ul>
          ${repeat(notes, (n) => n.path, (n) => noteRow(n, model.openPath, propose))}
        </ul>
      </nav>
      <section>${editor(model, propose)}</section>
      ${model.error
        ? html`<p class="error" role="alert">${model.error}</p>`
        : nothing}
    </main>
  `;
};
