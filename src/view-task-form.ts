import { html } from "lit-html";
import type { Model, Proposal } from "./model.ts";
import { isFiledPath } from "./paths.ts";
import { TASK_REPEATS, type TaskDraft } from "./task-draft.ts";
import { dependencyProblem, taskChoice, taskRefs } from "./task-links.ts";

export const taskForm = (model: Model, draft: TaskDraft, propose: (p: Proposal) => void) => {
  const change = (patch: Partial<TaskDraft>) => propose({ kind: "taskDraftChanged", patch });
  const text = (key: keyof TaskDraft) => (event: Event) =>
    change({ [key]: (event.target as HTMLInputElement).value });
  const notes = [...model.notes.values()].filter((note) =>
    !note.deleted && note.encoding === "utf8" && /\.md$/i.test(note.path) && !isFiledPath(note.path));
  const refs = taskRefs(model.notes.values());
  const following = Boolean(draft.after);
  return html`
    <form class="task-form floating" role="dialog" aria-modal="true" aria-labelledby="task-form-title"
      @submit=${(event: SubmitEvent) => { event.preventDefault(); propose({ kind: "taskAdded" }); }}>
      <h2 id="task-form-title">New task</h2>
      <label>Title
        <input id="modal-input" name="title" required autocomplete="off" .value=${draft.title} @input=${text("title")} />
      </label>
      <label><span>Description <span class="optional">(optional)</span></span>
        <textarea name="description" rows="3" .value=${draft.description} @input=${text("description")}></textarea>
      </label>
      <div class="task-form-field">
        <label for="task-after">After completing</label>
        <select id="task-after" name="after" .value=${draft.after ?? ""} @change=${(event: Event) => {
          const after = (event.target as HTMLSelectElement).value;
          change({ after, date: "", repeat: "", alarm: false });
        }}>
          <option value="" ?selected=${!following}>No predecessor</option>
          ${refs.filter(r => !r.done && !dependencyProblem(r, refs)).map(ref => html`
            <option value=${taskChoice(ref)} ?selected=${draft.after === taskChoice(ref)}>${ref.title} — ${ref.path}</option>`)}
        </select>
      </div>
      ${following ? html`<p class="task-hint">Waits until you complete that task. If it repeats, this follow-up can return after each completion. An alarm is scheduled for the next minute.</p>` : ""}
      <div class="task-date-fields" ?hidden=${following}>
        <label><span>Due date <span class="optional">(optional)</span></span>
          <input name="date" type="date" ?disabled=${following} .value=${draft.date} @input=${(event: Event) => {
            const date = (event.target as HTMLInputElement).value;
            change(date === "" ? { date, alarm: false, repeat: "" } : { date });
          }} />
        </label>
        <label>Time
          <input name="time" type="time" ?disabled=${draft.date === ""} .value=${draft.time} @input=${text("time")} />
        </label>
      </div>
      <p class="task-hint" ?hidden=${following}>Times use this device’s local time. A date without a time means 9am.</p>
      <label class="task-alarm">
        <input name="alarm" type="checkbox" ?disabled=${draft.date === "" && !following} .checked=${draft.alarm}
          @change=${(event: Event) => change({ alarm: (event.target as HTMLInputElement).checked })} />
        ${following ? "Ring an alarm after completion" : "Ring an alarm (!)"}
      </label>
      <div class="task-form-field" ?hidden=${following}>
        <label for="task-repeat">Repeat</label>
        <select id="task-repeat" name="repeat" ?disabled=${draft.date === ""} .value=${draft.repeat} @change=${text("repeat")}>
          ${TASK_REPEATS.map(([value, label]) => html`<option value=${value} ?selected=${draft.repeat === value}>${label}</option>`)}
        </select>
      </div>
      <label>Save in note
        <input name="path" list="task-note-paths" required autocomplete="off" .value=${draft.path} @input=${text("path")} />
        <datalist id="task-note-paths">${notes.sort((a, b) => a.path.localeCompare(b.path)).map((note) => html`<option value=${note.path}></option>`)}</datalist>
      </label>
      <p class="task-hint">Choose an existing note or enter a new Markdown note name.</p>
      ${model.error === null ? "" : html`<p class="task-form-error" role="alert">${model.error}</p>`}
      <div class="task-form-actions">
        <button type="button" @click=${() => propose({ kind: "modalClosed" })}>Cancel</button>
        <button type="submit">Create task</button>
      </div>
    </form>
  `;
};
