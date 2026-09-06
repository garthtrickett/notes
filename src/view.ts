// Model -> DOM. No components and no classes; lit-html patches only what
// changed, so painting the whole tree on every microtask is cheap.
//
// One exception, stated rather than hidden: `preview()` builds a real element
// imperatively and memoises it. It has to — markdown is handed to lit as a
// sanitised *node*, never a string, so nothing can inject unfiltered markup —
// and it has to be cached, because a fresh node each paint made lit tear the
// rendered note down and rebuild it on every render.
//
// The cache is passed in rather than held here, so it belongs to a loop like
// every other piece of state. This file has none of its own.

import { html, nothing, type TemplateResult } from "lit-html";
import {
  noteTree,
  openable,
  visible,
  type Model,
  type Note,
  type Proposal,
} from "./model.ts";
import type { TreeNode } from "./tree.ts";
import { dayOfPath, dumpPathOf, isDumpPath } from "./dump.ts";
import { backlinksTo, followLink, resolveLink, searchNotes } from "./links.ts";
import { dataUrlOf } from "./attachments.ts";
import { renderMarkdown } from "./render-markdown.ts";
import type { EditorKind } from "./config.ts";

type Propose = (p: Proposal) => void;
export type PasteHandler = (event: ClipboardEvent, path: string) => void;

// Everything the view is handed. The positional list grew by exactly one per
// feature and had reached six.
export interface ViewCtx {
  readonly propose: Propose;
  readonly now: () => number;
  readonly onCapture: (text: string) => void;
  readonly onPaste: PasteHandler;
  readonly previewCache: PreviewCache;
  readonly editorKind: EditorKind;
  // Flipping the surface reloads, because the flag is read once at boot. Goes
  // away with the textarea path.
  readonly onEditorKind: (kind: EditorKind) => void;
}

// Only the top ten rows carry a digit, because only ten digits exist. Anything
// deeper or further down is reached by clicking or through the open palette.
const badge = (index: number | null) =>
  index === null ? nothing : html`<kbd class="num">${index}</kbd>`;

const noteRow = (
  note: Note,
  openPath: string | null,
  propose: Propose,
  index: number | null,
) => html`
  <div class="leaf">
    <button
      class="row ${note.path === openPath ? "open" : ""}"
      @click=${() => propose({ kind: "opened", path: note.path })}
    >
      ${badge(index)}
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
  nodes.map((node, position) => {
    const index = depth === 0 && position < 10 ? position : null;
    if (node.kind === "note") {
      return html`<li style="--depth:${depth}">
        ${noteRow(node.note, model.openPath, propose, index)}
      </li>`;
    }
    const open = model.expanded.has(node.path);
    return html`<li style="--depth:${depth}">
      <div class="leaf">
        <button
          class="row folder"
          aria-expanded=${open ? "true" : "false"}
          @click=${() => propose({ kind: "folderToggled", path: node.path })}
        >
          ${badge(index)}
          <span class="twist">${open ? "▾" : "▸"}</span>
          <span class="path">${node.name}</span>
        </button>
        <button
          class="delete"
          title="Delete ${node.path} and everything in it"
          @click=${() => propose({ kind: "folderDeleted", path: node.path })}
        >
          ×
        </button>
      </div>
      ${open
        ? html`<ul>${treeNodes(node.children, model, propose, depth + 1)}</ul>`
        : nothing}
    </li>`;
  });

const editor = (model: Model, ctx: ViewCtx) => {
  const { propose, onPaste, previewCache: cache, editorKind } = ctx;
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
          // A rename carries its inbound links with it. Moving between folders
          // is the same proposal — it just finds nothing to rewrite, because
          // links match on basename.
          if (to !== path) propose({ kind: "renamed", from: path, to });
        }}
      />
      <button
        class="toggle ${model.preview ? "on" : ""}"
        title="Toggle preview (E)"
        aria-keyshortcuts="E"
        @click=${() => propose({ kind: "previewToggled" })}
      >
        ${model.preview ? "Edit" : "Preview"} <kbd>E</kbd>
      </button>
      <button
        class="toggle ${editorKind === "codemirror" ? "on" : ""}"
        title="Editing surface, this device only"
        @click=${() =>
          ctx.onEditorKind(editorKind === "codemirror" ? "textarea" : "codemirror")}
      >
        ${editorKind === "codemirror" ? "CM" : "Plain"}
      </button>
    </div>
    ${model.preview
      ? html`<div
          class="preview"
          @click=${(e: Event) => onPreviewClick(e, model, propose)}
        >
          ${preview(model, path, cache)}
        </div>`
      : editorKind === "codemirror"
        ? // Empty on purpose. The loop holds the EditorView and attaches it here
          // once; rebuilding it per paint would tear the editor down mid-keystroke.
          html`<div id="editor-host"></div>`
        : html`<textarea
            id="editor"
            spellcheck="false"
            @paste=${(e: ClipboardEvent) => onPaste(e, path)}
            @input=${(e: Event) =>
              propose({
                kind: "edited",
                path,
                body: (e.target as HTMLTextAreaElement).value,
              })}
          ></textarea>`}
    ${backlinks(model, path, propose)}
  `;
};

// Rendered into a real element and sanitised, then handed to lit as a node —
// never as a string, so there is no path that injects unfiltered markup.
//
// The node is cached, and that is not an optimisation. lit-html re-inserts a
// Node value whenever its identity changes, so returning a fresh fragment each
// paint tore the whole preview down and rebuilt it on *every* render — several
// times per sync, re-decoding every image. That is the flash.
export interface PreviewCache {
  key: string | null;
  node: HTMLElement | null;
}

export const createPreviewCache = (): PreviewCache => ({ key: null, node: null });

const WIKILINK_SCAN = /\[\[([^\]\n]+)\]\]/g;
const IMAGE_SCAN = /!\[[^\]]*\]\(([^)\s]+)\)/g;

// A relative source is an attachment in this vault; anything absolute is
// somebody else's problem and left alone.
export const localImage = (model: Model, src: string): string | null => {
  if (/^[a-z]+:/i.test(src) || src.startsWith("//")) return null;
  const record = model.notes.get(src.replace(/^\.?\//, ""));
  if (!record || record.deleted || record.encoding !== "base64") return null;
  return dataUrlOf(record.body, record.path);
};

// Everything the rendered node depends on. The body is not enough: a link
// resolves against the whole vault, so a note appearing elsewhere changes how
// this one should look without changing a character of it.
const previewKey = (model: Model, path: string, body: string): string => {
  const links = [...body.matchAll(WIKILINK_SCAN)].map(
    (m) => `${m[1]}=${resolveLink((m[1] ?? "").trim(), model.notes).kind}`,
  );
  const images = [...body.matchAll(IMAGE_SCAN)].map(
    (m) => `${m[1]}=${localImage(model, m[1] ?? "") === null ? "0" : "1"}`,
  );
  return [path, body, ...links, ...images].join("\u0000");
};

const preview = (
  model: Model,
  path: string,
  cache: PreviewCache,
): HTMLElement => {
  const body = model.notes.get(path)?.body ?? "";
  const key = previewKey(model, path, body);
  if (key === cache.key && cache.node !== null) return cache.node;

  const container = document.createElement("div");
  container.className = "preview-body";
  container.append(renderMarkdown(body, document, (src) => localImage(model, src)));

  // A wikilink became an ordinary anchor. It carries its target as data and no
  // listener at all: one delegated handler on the container resolves at click
  // time, against the model as it is then rather than as it was when this was
  // built. That is what makes caching the node safe.
  for (const anchor of [...container.querySelectorAll("a")]) {
    const href = anchor.getAttribute("href") ?? "";
    if (!href.startsWith("#note:")) continue;
    const target = decodeURIComponent(href.slice("#note:".length));
    anchor.dataset.note = target;

    const resolved = resolveLink(target, model.notes);
    if (resolved.kind === "found") continue;
    // Linking to a note you have not written yet is normal. Say so rather than
    // failing silently.
    anchor.classList.add(resolved.kind === "missing" ? "unresolved" : "ambiguous");
    anchor.title =
      resolved.kind === "missing"
        ? "No note yet — click to create it"
        : `Ambiguous: ${resolved.paths.join(", ")}`;
  }

  cache.key = key;
  cache.node = container;
  return container;
};

const onPreviewClick = (event: Event, model: Model, propose: Propose): void => {
  const anchor = (event.target as HTMLElement | null)?.closest?.("a[data-note]");
  if (!(anchor instanceof HTMLAnchorElement)) return;
  event.preventDefault();

  const proposal = followLink(anchor.dataset.note ?? "", model.notes);
  if (proposal !== null) propose(proposal);
};

const backlinks = (model: Model, path: string, propose: Propose) => {
  const referrers = backlinksTo(path, model.notes);
  if (referrers.length === 0) return nothing;
  return html`
    <aside class="backlinks">
      <h3>Linked from</h3>
      <ul>
        ${referrers.map(
          (from) => html`<li>
            <button @click=${() => propose({ kind: "opened", path: from })}>
              ${from}
            </button>
          </li>`,
        )}
      </ul>
    </aside>
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
    case "rateLimited": {
      const minutes = Math.ceil(e.retryAfterMs / 60_000);
      return minutes <= 1
        ? "GitHub is rate limiting; retrying shortly."
        : `GitHub is rate limiting; retrying in about ${minutes} minutes.`;
    }
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
        <button type="submit" title="Capture (A)" aria-keyshortcuts="A">
          Add <kbd>A</kbd>
        </button>
      </form>
    </div>
  `;
};

// Capture and new-note are the same shape — one field, submit — so they share a
// box told what it is. The open palette is not that shape and does not share it:
// it filters as you type and has a selection.
const modalBox = (
  propose: Propose,
  placeholder: string,
  label: string,
  action: string,
  onSubmit: (text: string) => void,
) => html`
  <form
    class="capture floating"
    role="dialog"
    aria-modal="true"
    aria-label=${label}
    @submit=${(e: SubmitEvent) => {
      e.preventDefault();
      const input = (e.target as HTMLFormElement).querySelector("input");
      if (!input) return;
      const text = input.value.trim();
      if (text !== "") onSubmit(text);
      input.value = "";
      propose({ kind: "modalClosed" });
    }}
  >
    <input id="modal-input" placeholder=${placeholder} autocomplete="off" />
    <button type="submit">${action}</button>
  </form>
`;

// An empty query lists everything rather than nothing, so `o` then Enter is
// useful without typing.
const paletteResults = (model: Model): Note[] => {
  const notes = openable(model).sort((a, b) => a.path.localeCompare(b.path));
  return (model.query.trim() === "" ? notes : searchNotes(notes, model.query)).slice(
    0,
    50,
  );
};

const openPalette = (model: Model, propose: Propose) => {
  const results = paletteResults(model);
  const selected = Math.min(model.paletteIndex, Math.max(0, results.length - 1));
  const go = (path: string | undefined) => {
    if (path === undefined) return;
    propose({ kind: "opened", path });
    propose({ kind: "modalClosed" });
  };

  return html`
    <form
      class="palette floating"
      role="dialog"
      aria-modal="true"
      aria-label="Open a note"
      @submit=${(e: SubmitEvent) => {
        e.preventDefault();
        go(results[selected]?.path);
      }}
    >
      <input
        id="modal-input"
        placeholder="Find a note"
        autocomplete="off"
        .value=${model.query}
        @input=${(e: Event) =>
          propose({
            kind: "searched",
            query: (e.target as HTMLInputElement).value,
          })}
        @keydown=${(e: KeyboardEvent) => {
          // Arrows have to be handled here: the global shortcuts stand down
          // while a field has focus, which is exactly where this one is.
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          propose({ kind: "paletteMoved", delta: e.key === "ArrowDown" ? 1 : -1 });
        }}
      />
      <ul class="results">
        ${results.length === 0
          ? html`<li class="empty">No note matches.</li>`
          : nothing}
        ${results.map(
          (note, index) => html`<li>
            <button
              type="button"
              class="row ${index === selected ? "open" : ""}"
              @click=${() => go(note.path)}
            >
              <span class="path">${note.path}</span>
            </button>
          </li>`,
        )}
      </ul>
    </form>
  `;
};

const modal = (
  model: Model,
  propose: Propose,
  onCapture: (text: string) => void,
) => {
  if (model.modal === null) return nothing;
  const inner =
    model.modal === "capture"
      ? modalBox(propose, "What's on your mind?", "Quick capture", "Add", onCapture)
      : model.modal === "newNote"
        ? modalBox(propose, "inbox/new-note.md", "New note", "Create", (path) =>
            propose({ kind: "created", path }),
          )
        : openPalette(model, propose);

  return html`<div
    class="scrim"
    @click=${(e: Event) => {
      if (e.target === e.currentTarget) propose({ kind: "modalClosed" });
    }}
  >
    ${inner}
  </div>`;
};

const tabs = (model: Model, propose: Propose) => html`
  <div class="tabs">
    <button
      class=${model.mode === "notes" ? "on" : ""}
      title="Notes (N)"
      aria-keyshortcuts="N"
      @click=${() => propose({ kind: "modeChanged", mode: "notes" })}
    >
      Notes <kbd>N</kbd>
    </button>
    <button
      class=${model.mode === "dump" ? "on" : ""}
      title="Dump (D)"
      aria-keyshortcuts="D"
      @click=${() => propose({ kind: "modeChanged", mode: "dump" })}
    >
      Dump <kbd>D</kbd>
    </button>
  </div>
`;

export const view = (model: Model, ctx: ViewCtx): TemplateResult => {
  const { propose, now, onCapture, onPaste, previewCache } = ctx;
  if (!model.hydrated) return html`<p class="empty">Loading…</p>`;

  if (model.mode === "dump") {
    return html`
      <main class="single">
        ${tabs(model, propose)}
        ${dumpView(model, propose, now, onCapture)}
        ${modal(model, propose, onCapture)}
        ${status(model)}
        ${model.error
          ? html`<p class="error" role="alert">${model.error}</p>`
          : nothing}
      </main>
    `;
  }

  // The dump lives in its own view, so it does not clutter the note tree.
  // One definition of "is this a note", shared with whatever the model decides
  // to open.
  return html`
    <main>
      <nav>
        ${tabs(model, propose)}
        <ul>${treeNodes(noteTree(model), model, propose, 0)}</ul>
      </nav>
      <section>${editor(model, ctx)}</section>
      ${modal(model, propose, onCapture)}
      ${status(model)}
      ${model.error
        ? html`<p class="error" role="alert">${model.error}</p>`
        : nothing}
    </main>
  `;
};
