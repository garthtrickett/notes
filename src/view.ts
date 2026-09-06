// Pure model -> DOM. No components, no classes, no state. lit-html patches only
// what changed, so painting the whole tree on every microtask is cheap.

import { html, nothing, type TemplateResult } from "lit-html";
import { visible, type Model, type Note, type Proposal } from "./model.ts";
import { buildTree, type TreeNode } from "./tree.ts";
import { dayOfPath, dumpPathOf, isDumpPath } from "./dump.ts";

type Propose = (p: Proposal) => void;

const noteRow = (note: Note, openPath: string | null, propose: Propose) => html`
  <div class="leaf">
    <button
      class="row ${note.path === openPath ? "open" : ""}"
      @click=${() => propose({ kind: "opened", path: note.path })}
    >
      <span class="path">${note.path.slice(note.path.lastIndexOf("/") + 1)}</span>
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
  </div>
`;

const treeNodes = (
  nodes: readonly TreeNode[],
  model: Model,
  propose: Propose,
  depth: number,
): TemplateResult[] =>
  nodes.map((node) => {
    if (node.kind === "note") {
      return html`<li style="--depth:${depth}">
        ${noteRow(node.note, model.openPath, propose)}
      </li>`;
    }
    const open = model.expanded.has(node.path);
    return html`<li style="--depth:${depth}">
      <button
        class="row folder"
        aria-expanded=${open ? "true" : "false"}
        @click=${() => propose({ kind: "folderToggled", path: node.path })}
      >
        <span class="twist">${open ? "▾" : "▸"}</span>
        <span class="path">${node.name}</span>
      </button>
      ${open
        ? html`<ul>${treeNodes(node.children, model, propose, depth + 1)}</ul>`
        : nothing}
    </li>`;
  });

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
    <div class="pathbar">
      <input
        class="pathfield"
        .value=${path}
        aria-label="Note path"
        @keydown=${(e: KeyboardEvent) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const to = (e.target as HTMLInputElement).value.trim();
          // Moving is just a path change. Links match on basename, so nothing
          // else has to be rewritten.
          if (to !== path) propose({ kind: "moved", from: path, to });
        }}
      />
    </div>
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

// One continuous scroll, oldest to newest, that reads like a single document.
// The storage stays one file per day: a single editor over everything would have
// to parse file boundaries back out of the text, and that breaks the first time
// a note contains a line that looks like a date header.
const dumpView = (
  model: Model,
  propose: Propose,
  now: () => number,
  onCapture: (text: string) => void,
): TemplateResult => {
  const todayPath = dumpPathOf(now());
  const days = visible(model)
    .filter((n) => isDumpPath(n.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  return html`
    <div class="dump">
      <div class="days">
        ${days.length === 0
          ? html`<p class="empty">Nothing captured yet.</p>`
          : nothing}
        ${days.map((day) => {
          const isToday = day.path === todayPath;
          return html`
            <article class="day">
              <h2>
                ${isToday ? "Today" : dayOfPath(day.path)}
                ${day.pending
                  ? html`<span class="dot" title="Not yet on GitHub">•</span>`
                  : nothing}
              </h2>
              <textarea
                class="day-body"
                data-day=${day.path}
                spellcheck="false"
                rows=${Math.max(2, day.body.split("\n").length)}
                ?readonly=${!isToday}
                title=${isToday ? "" : "Settled — click to edit"}
                @dblclick=${(e: Event) => {
                  (e.target as HTMLTextAreaElement).readOnly = false;
                }}
                @input=${(e: Event) =>
                  propose({
                    kind: "edited",
                    path: day.path,
                    body: (e.target as HTMLTextAreaElement).value,
                  })}
                .value=${day.body}
              ></textarea>
            </article>
          `;
        })}
      </div>
      <form
        class="capture"
        @submit=${(e: SubmitEvent) => {
          e.preventDefault();
          const input = (e.target as HTMLFormElement).querySelector("input");
          if (!input) return;
          onCapture(input.value);
          input.value = "";
        }}
      >
        <input id="capture" placeholder="What's on your mind?" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
    </div>
  `;
};

const tabs = (model: Model, propose: Propose) => html`
  <div class="tabs">
    <button
      class=${model.mode === "notes" ? "on" : ""}
      @click=${() => propose({ kind: "modeChanged", mode: "notes" })}
    >
      Notes
    </button>
    <button
      class=${model.mode === "dump" ? "on" : ""}
      @click=${() => propose({ kind: "modeChanged", mode: "dump" })}
    >
      Dump
    </button>
  </div>
`;

export const view = (
  model: Model,
  propose: Propose,
  now: () => number,
  onCapture: (text: string) => void,
): TemplateResult => {
  if (!model.hydrated) return html`<p class="empty">Loading…</p>`;

  if (model.mode === "dump") {
    return html`
      <main class="single">
        ${tabs(model, propose)}
        ${dumpView(model, propose, now, onCapture)}
        ${status(model)}
        ${model.error
          ? html`<p class="error" role="alert">${model.error}</p>`
          : nothing}
      </main>
    `;
  }

  // The dump lives in its own view, so it does not clutter the note tree.
  const notes = visible(model)
    .filter((n) => !isDumpPath(n.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  return html`
    <main>
      <nav>
        ${tabs(model, propose)}
        ${newNoteField(propose)}
        <ul>${treeNodes(buildTree(notes), model, propose, 0)}</ul>
      </nav>
      <section>${editor(model, propose)}</section>
      ${status(model)}
      ${model.error
        ? html`<p class="error" role="alert">${model.error}</p>`
        : nothing}
    </main>
  `;
};
