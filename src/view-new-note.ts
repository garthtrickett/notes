import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { emptyNotePath, folderCompletions } from "./folder-completion.ts";
import { openable, type Model, type Proposal } from "./model.ts";

export const newNoteForm = (model: Model, propose: (p: Proposal) => void) => {
  if (model.modal?.kind !== "newNote") return nothing;
  const draft = model.modal.draft ?? emptyNotePath;
  const choices = folderCompletions(openable(model).map(n => n.path), draft.path);
  const selected = Math.min(draft.index, Math.max(0, choices.length - 1));
  const complete = (path: string, input: HTMLInputElement) => {
    propose({ kind: "noteFolderCompleted", path });
    // The model's render is queued first. Keep the keyboard open on touch and
    // leave the caret ready to type the next segment after the completed slash.
    queueMicrotask(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  };
  return html`
    <form class="capture floating new-note-form" role="dialog" aria-modal="true" aria-label="New note"
      @submit=${(e: SubmitEvent) => {
        e.preventDefault();
        const input = (e.currentTarget as HTMLFormElement).querySelector("input")!;
        const path = input.value.trim();
        if (path === "") return;
        if (path.endsWith("/")) {
          input.setCustomValidity("Add a note name after the folder.");
          input.reportValidity();
          return;
        }
        propose({ kind: "created", path });
        propose({ kind: "modalClosed" });
      }}>
      <div class="note-path-row">
        <input id="modal-input" placeholder="inbox/new-note.md" aria-label="Note path"
          autocomplete="off" autocapitalize="none" spellcheck="false" role="combobox"
          aria-autocomplete="list" aria-expanded=${choices.length > 0 ? "true" : "false"}
          aria-controls=${choices.length > 0 ? "note-folders" : nothing}
          aria-activedescendant=${choices.length > 0 ? `note-folder-${selected}` : nothing}
          aria-describedby="note-path-help" .value=${live(draft.path)}
          @input=${(e: Event) => {
            const input = e.currentTarget as HTMLInputElement;
            input.setCustomValidity("");
            propose({ kind: "notePathChanged", path: input.value });
          }}
          @keydown=${(e: KeyboardEvent) => {
            const input = e.currentTarget as HTMLInputElement;
            // Completion is for the segment being typed at the end. Ordinary
            // caret movement/selection and IME composition keep their meaning.
            if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || choices.length === 0
                || input.selectionStart !== input.value.length || input.selectionEnd !== input.value.length) return;
            if (e.key === "Tab") {
              e.preventDefault();
              e.stopPropagation();
              complete(choices[selected]!, input);
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              propose({ kind: "noteFolderMoved", delta: e.key === "ArrowDown" ? 1 : -1 });
            }
          }}/>
        <button type="submit">Create</button>
      </div>
      ${choices.length === 0 ? nothing : html`
        <ul id="note-folders" class="folder-suggestions" role="listbox" aria-label="Existing folders">
          ${choices.map((path, index) => html`
            <li role="none"><button type="button" role="option" tabindex="-1"
              id=${`note-folder-${index}`} aria-selected=${index === selected ? "true" : "false"}
              @mousedown=${(e: MouseEvent) => e.preventDefault()}
              @click=${(e: MouseEvent) => {
                const input = (e.currentTarget as HTMLElement).closest("form")!.querySelector("input")!;
                input.setCustomValidity("");
                complete(path, input);
              }}>${path}</button></li>`)}
        </ul>`}
      <p id="note-path-help" class="note-path-help">Folders: Tab to complete · ↑↓ to choose · tap to fill</p>
    </form>`;
};
