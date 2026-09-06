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
import { ARCHIVE, TRASH, dropTarget } from "./paths.ts";
import {
  dragLanding,
  filedIn,
  orphanAttachments,
  noteTree,
  numberedRows,
  openable,
  visible,
  type Model,
  type Note,
  type Proposal,
} from "./model.ts";
import type { TreeNode } from "./tree.ts";
import { dayOfPath, dumpPathOf, isDumpPath } from "./dump.ts";
import { backlinksTo, followLink, resolveLink, searchNotes } from "./links.ts";
import { mimeOf } from "./attachments.ts";
import type { Media } from "./media.ts";
import { renderMarkdown } from "./render-markdown.ts";
import { settingsView, type VaultConfig } from "./view-settings.ts";

type Propose = (p: Proposal) => void;

// Everything the view is handed. The positional list grew by exactly one per
// feature and had reached six.
export interface ViewCtx {
  readonly propose: Propose;
  readonly now: () => number;
  readonly onCapture: (text: string) => void;
  readonly previewCache: PreviewCache;
  readonly media: Media;
  // Saving the vault config is ambient state, so it belongs to main rather than
  // to the loop; the view only asks.
  readonly onSaveConfig: (config: VaultConfig) => void;
  readonly config: VaultConfig | null;
}

// Only the top ten rows carry a digit, because only ten digits exist. Anything
// deeper or further down is reached by clicking or through the open palette.
const badge = (index: number | null) =>
  index === null ? nothing : html`<kbd class="num">${index}</kbd>`;

// Dragging a row moves what it stands for. The payload is the path, and the drop
// target works out the rest — so a note and a folder are dragged the same way.
const DRAG_TYPE = "text/x-note-path";

// The payload says what is being dragged as well as where it came from: a
// folder move is every note under it, which is a different proposal.
const dragSource =
  (path: string, folder: boolean, propose: Propose) => (event: DragEvent) => {
    event.dataTransfer?.setData(DRAG_TYPE, `${folder ? "folder" : "note"}:${path}`);
    event.dataTransfer?.setData("text/plain", path);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    event.stopPropagation();
    propose({ kind: "dragStarted", from: path, folder });
  };

const dropZone = (folder: string | null, model: Model, propose: Propose) => ({
  onDragOver: (event: DragEvent) => {
    if (event.dataTransfer?.types.includes(DRAG_TYPE) !== true) return;
    event.preventDefault();
    // The root zone is the whole sidebar, so a folder's dragover reaches it by
    // bubbling and immediately overwrote the answer with "root" — the preview
    // showed the root no matter which folder you were over. The innermost zone
    // is the one being pointed at.
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    // dragover fires continuously. Only say something when the answer changes,
    // or every frame of a drag becomes a repaint.
    if (model.drag !== null && model.drag.over !== folder) {
      propose({ kind: "draggedOver", over: folder });
    }
  },
  onDrop: (event: DragEvent) => {
    const payload = event.dataTransfer?.getData(DRAG_TYPE) ?? "";
    const [kind, ...rest] = payload.split(":");
    const from = rest.join(":");
    if (from === "") return;
    event.preventDefault();
    event.stopPropagation();
    const to = dropTarget(from, folder);
    propose({ kind: "dragEnded" });
    if (to === null) return;
    propose(
      kind === "folder"
        ? { kind: "folderMoved", from, to }
        : { kind: "renamed", from, to },
    );
  },
});

// Which rows wear a digit, keyed by path. Built from the same function the
// digits index into, so a badge cannot point somewhere its key does not go.
const badgesFor = (model: Model): Map<string, number> => {
  const map = new Map<string, number>();
  numberedRows(model)
    .slice(0, 10)
    .forEach((node, index) => {
      map.set(node.kind === "folder" ? node.path : node.note.path, index);
    });
  return map;
};

const noteRow = (
  note: Note,
  openPath: string | null,
  propose: Propose,
  index: number | null,
) => html`
  <div class="leaf">
    <button
      class="row ${note.path === openPath ? "open" : ""}"
      draggable="true"
      @dragstart=${dragSource(note.path, false, propose)}
      @dragend=${() => propose({ kind: "dragEnded" })}
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
      @click=${() =>
        propose({
          kind: "modalOpened",
          modal: { kind: "confirmDelete", path: note.path, folder: false },
        })}
    >
      ×
    </button>
  </div>
`;

const treeNodes = (
  nodes: readonly TreeNode[],
  model: Model,
  propose: Propose,
  badges: Map<string, number>,
): TemplateResult[] =>
  nodes.map((node) => {
    const path = node.kind === "folder" ? node.path : node.note.path;
    const index = badges.get(path) ?? null;
    // The row is being previewed where it would land, not where it is. Drawn as
    // a question rather than a fact until the mouse comes up.
    const landing = dragLanding(model);
    const provisional =
      landing !== null && (path === landing || path.startsWith(`${landing}/`));
    if (node.kind === "note") {
      return html`<li class=${provisional ? "provisional" : nothing}>
        ${noteRow(node.note, model.openPath, propose, index)}
      </li>`;
    }
    // A folder opens while something is being dragged into it. Otherwise the row
    // simply vanishes at the moment you most want to see where it is going.
    const open =
      model.expanded.has(node.path) ||
      (landing !== null && landing.startsWith(`${node.path}/`));
    return html`<li class=${provisional ? "provisional" : nothing}>
      <div class="leaf">
        <button
          class="row folder"
          aria-expanded=${open ? "true" : "false"}
          draggable="true"
          @dragstart=${dragSource(node.path, true, propose)}
          @dragend=${() => propose({ kind: "dragEnded" })}
          @dragover=${dropZone(node.path, model, propose).onDragOver}
          @drop=${dropZone(node.path, model, propose).onDrop}
          @click=${() => propose({ kind: "folderToggled", path: node.path })}
        >
          ${badge(index)}
          <span class="twist">${open ? "▾" : "▸"}</span>
          <span class="path">${node.name}</span>
        </button>
        <button
          class="delete"
          title="Delete ${node.path} and everything in it"
          @click=${() =>
            propose({
              kind: "modalOpened",
              modal: { kind: "confirmDelete", path: node.path, folder: true },
            })}
        >
          ×
        </button>
      </div>
      ${open
        ? html`<ul>${treeNodes(node.children, model, propose, badges)}</ul>`
        : nothing}
    </li>`;
  });

const editor = (model: Model, ctx: ViewCtx) => {
  const { propose, previewCache: cache } = ctx;
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
          // Leaving the field is what lets the loop put the real path back if
          // the rename is refused. Without it the box went on showing a name
          // the note does not have.
          (e.target as HTMLInputElement).blur();
          // A rename carries its inbound links with it. Moving between folders
          // is the same proposal — it just finds nothing to rewrite, because
          // links match on basename.
          if (to !== path) propose({ kind: "renamed", from: path, to });
        }}
      />
      <button
        class="toggle"
        title="History of ${path} (H)"
        aria-keyshortcuts="H"
        @click=${() => propose({ kind: "historyOpened", path })}
      >
        History <kbd>H</kbd>
      </button>
      <button
        class="toggle"
        title="Archive ${path}"
        @click=${() => propose({ kind: "archived", path })}
      >
        Archive
      </button>
      <button
        class="toggle ${model.preview ? "on" : ""}"
        title="Toggle preview (E)"
        aria-keyshortcuts="E"
        @click=${() => propose({ kind: "previewToggled" })}
      >
        ${model.preview ? "Edit" : "Preview"} <kbd>E</kbd>
      </button>
    </div>
    ${model.preview
      ? html`<div
          class="preview"
          @click=${(e: Event) => onPreviewClick(e, model, propose)}
        >
          ${preview(model, ctx.media, path, cache)}
        </div>`
      : // Empty on purpose. The loop holds the EditorView and attaches it here
        // once; rebuilding it per paint would tear the editor down mid-keystroke.
        html`<div id="editor-host"></div>`}
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
//
// The record says whether the attachment exists; the media cache says whether
// its bytes are here yet. Null from the second is temporary — asking is what
// starts the read, and the repaint that follows finds the URL.
export const localImage = (
  model: Model,
  media: Media,
  src: string,
): string | null => {
  if (/^[a-z]+:/i.test(src) || src.startsWith("//")) return null;
  const path = src.replace(/^\.?\//, "");
  const record = model.notes.get(path);
  if (!record || record.deleted || record.encoding !== "base64") return null;
  const mime = mimeOf(path);
  return mime === null ? null : media.urlFor(path, mime);
};

// Everything the rendered node depends on. The body is not enough: a link
// resolves against the whole vault, so a note appearing elsewhere changes how
// this one should look without changing a character of it.
const previewKey = (
  model: Model,
  media: Media,
  path: string,
  body: string,
): string => {
  const links = [...body.matchAll(WIKILINK_SCAN)].map(
    (m) => `${m[1]}=${resolveLink((m[1] ?? "").trim(), model.notes).kind}`,
  );
  const images = [...body.matchAll(IMAGE_SCAN)].map(
    (m) => `${m[1]}=${localImage(model, media, m[1] ?? "") === null ? "0" : "1"}`,
  );
  return [path, body, ...links, ...images].join("\u0000");
};

const preview = (
  model: Model,
  media: Media,
  path: string,
  cache: PreviewCache,
): HTMLElement => {
  const body = model.notes.get(path)?.body ?? "";
  const key = previewKey(model, media, path, body);
  if (key === cache.key && cache.node !== null) return cache.node;

  const container = document.createElement("div");
  container.className = "preview-body";
  container.append(
    renderMarkdown(body, document, (src) => localImage(model, media, src)),
  );

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
  if (e === null) {
    if (!model.syncing) return null;
    // A thousand-note import is otherwise a motionless "Syncing…" for a minute.
    return model.pullRemaining > 0
      ? `Syncing… ${model.pullRemaining} notes to go`
      : "Syncing…";
  }
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

// Deleting a folder takes everything under it, so the dialog says which it is
// rather than asking the same bland question for both. Cancel is the default:
// it is what the button is focused on and what Escape does.
const confirmBox = (propose: Propose, path: string, folder: boolean) => html`
  <form
    class="capture floating confirm"
    role="dialog"
    aria-modal="true"
    aria-label="Confirm delete"
    @submit=${(e: SubmitEvent) => {
      e.preventDefault();
      propose({ kind: "modalConfirmed" });
    }}
  >
    <p>
      Delete <strong>${path}</strong>${folder
        ? html` and everything in it`
        : nothing}?
    </p>
    <div class="confirm-actions">
      <button
        id="modal-input"
        type="button"
        @click=${() => propose({ kind: "modalClosed" })}
      >
        Cancel
      </button>
      <button class="danger" type="submit">Delete</button>
    </div>
  </form>
`;

// A note's history is the vault branch's commits for its path. Nothing here is
// stored and nothing is rewritten: restoring writes the old text as a new edit,
// so the history only ever moves forward.
const historyBox = (model: Model, propose: Propose) => {
  const h = model.history;
  if (h === null) return nothing;
  const when = (iso: string) =>
    iso === "" ? "" : new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });

  return html`
    <div class="capture floating history" role="dialog" aria-modal="true" aria-label="History">
      <h3>${h.path}</h3>
      ${h.error !== null ? html`<p class="empty">${h.error}</p>` : nothing}
      ${h.revisions === null
        ? html`<p class="empty">Reading history…</p>`
        : h.revisions.length === 0 && h.error === null
          ? html`<p class="empty">GitHub has no history for this note yet.</p>`
          : html`<ul class="revisions">
              ${h.revisions.map(
                (rev) => html`<li>
                  <button
                    class=${rev.sha === h.viewingSha ? "on" : ""}
                    @click=${() => propose({ kind: "revisionOpened", sha: rev.sha })}
                  >
                    <span class="when">${when(rev.when)}</span>
                    <span class="who">${rev.author}</span>
                  </button>
                </li>`,
              )}
            </ul>`}
      ${h.viewingSha === null
        ? nothing
        : h.viewingBody === null
          ? html`<p class="empty">Reading that version…</p>`
          : html`
              <pre class="revision-body">${h.viewingBody}</pre>
              <div class="confirm-actions">
                <button type="button" @click=${() => propose({ kind: "modalClosed" })}>
                  Close
                </button>
                <button
                  type="button"
                  @click=${() => propose({ kind: "revisionRestored" })}
                >
                  Restore this version
                </button>
              </div>
            `}
    </div>
  `;
};

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
    model.modal.kind === "capture"
      ? modalBox(propose, "What's on your mind?", "Quick capture", "Add", onCapture)
      : model.modal.kind === "newNote"
        ? modalBox(propose, "inbox/new-note.md", "New note", "Create", (path) =>
            propose({ kind: "created", path }),
          )
        : model.modal.kind === "confirmDelete"
          ? confirmBox(propose, model.modal.path, model.modal.folder)
          : model.modal.kind === "history"
            ? historyBox(model, propose)
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
    <button
      class=${model.mode === "archive" ? "on" : ""}
      title="Archive (V)"
      aria-keyshortcuts="V"
      @click=${() => propose({ kind: "modeChanged", mode: "archive" })}
    >
      Archive <kbd>V</kbd>
    </button>
    <button
      class=${model.mode === "trash" ? "on" : ""}
      title="Deleted notes (T)"
      aria-keyshortcuts="T"
      @click=${() => propose({ kind: "modeChanged", mode: "trash" })}
    >
      Trash <kbd>T</kbd>
    </button>
    <button
      class=${model.mode === "settings" ? "on" : ""}
      title="Vault settings"
      @click=${() => propose({ kind: "modeChanged", mode: "settings" })}
    >
      Vault
    </button>
  </div>
`;

// The bin and the archive are the same list with one button's difference, so
// they are one component. Both show the note's original path, because that is
// what you are looking for — not where it was filed.
const filedView = (model: Model, propose: Propose, folder: string) => {
  const notes = filedIn(model, folder);
  const trash = folder === TRASH;
  // Unused attachments belong with the bin: it is where you go to get space
  // back. They are listed rather than collected — see orphanAttachments.
  const orphans = trash ? orphanAttachments(model) : [];
  if (notes.length === 0 && orphans.length === 0) {
    return html`<p class="empty">
      ${trash ? "Nothing deleted." : "Nothing archived."}
    </p>`;
  }
  return html`
    <ul class="filed">
      ${notes.map(
        (note) => html`<li>
          <span class="path" title=${note.path}>
            ${note.path.slice(folder.length + 1)}
          </span>
          <button @click=${() => propose({ kind: "restored", path: note.path })}>
            ${trash ? "Restore" : "Unarchive"}
          </button>
          ${trash
            ? html`<button
                class="delete"
                title="Delete ${note.path} for good"
                @click=${() =>
                  propose({
                    kind: "modalOpened",
                    modal: { kind: "confirmDelete", path: note.path, folder: false },
                  })}
              >
                ×
              </button>`
            : nothing}
        </li>`,
      )}
      ${orphans.length === 0
        ? nothing
        : html`
            <li class="filed-heading">
              Unused images — no note points at these any more
            </li>
            ${orphans.map(
              (note) => html`<li>
                <span class="path" title=${note.path}>
                  ${note.path.slice(note.path.lastIndexOf("/") + 1)}
                </span>
                <button
                  class="delete"
                  title="Delete ${note.path} for good"
                  @click=${() =>
                    propose({
                      kind: "modalOpened",
                      modal: { kind: "confirmDelete", path: note.path, folder: false },
                    })}
                >
                  ×
                </button>
              </li>`,
            )}
          `}
    </ul>
  `;
};

export const view = (model: Model, ctx: ViewCtx): TemplateResult => {
  const { propose, now, onCapture, previewCache } = ctx;
  if (!model.hydrated) return html`<p class="empty">Loading…</p>`;

  if (model.mode === "settings") {
    return html`
      <main class="single">
        ${tabs(model, propose)}
        ${settingsView(ctx.onSaveConfig, ctx.config, () =>
          propose({ kind: "modeChanged", mode: "notes" }),
        )}
        ${status(model)}
      </main>
    `;
  }

  if (model.mode === "archive" || model.mode === "trash") {
    return html`
      <main class="single">
        ${tabs(model, propose)}
        ${filedView(model, propose, model.mode === "trash" ? TRASH : ARCHIVE)}
        ${modal(model, propose, onCapture)}
        ${status(model)}
        ${model.error
          ? html`<p class="error" role="alert">${model.error}</p>`
          : nothing}
      </main>
    `;
  }

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
      <nav
        @dragover=${dropZone(null, model, propose).onDragOver}
        @drop=${dropZone(null, model, propose).onDrop}
      >
        ${tabs(model, propose)}
        <ul class="tree">
          ${treeNodes(noteTree(model), model, propose, badgesFor(model))}
        </ul>
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
