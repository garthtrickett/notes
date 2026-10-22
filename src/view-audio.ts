import { html, nothing, type TemplateResult } from "lit-html";
import { live } from "lit-html/directives/live.js";
import type { AudioModel, AudioProposal } from "./audio-model.ts";
import type { AudioCommand } from "./audio-library.ts";
import type { AudioHistory, AudioRow } from "./audio-wire.ts";

type Propose = (p: AudioProposal) => void;
const request = (propose: Propose, command: AudioCommand) => propose({ kind: "audioRequested", command });
export const audioTime = (ms: number): string => {
  const seconds = Math.floor(Math.max(0, ms) / 1000), minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` :
    `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
};
const bytes = (n: number): string => n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const label = (mark: string): string => mark === "IN_PROGRESS" ? "In progress" : mark === "DONE" ? "Done" : "Unplayed";
const title = (row: AudioRow | AudioHistory) => html`<h2>${row.title}</h2>
  ${row.author ? html`<p class="audio-author">${row.author}</p>` : nothing}<p class="audio-path">${row.path}</p>`;
const rowView = (row: AudioRow, busy: boolean, propose: Propose): TemplateResult => {
  const progress = row.listening, duration = progress?.durationMs ?? row.durationMs;
  const target = { item: row.item, version: row.version };
  return html`<li class="audio-row">${title(row)}
    <p class="audio-detail">${duration === null ? "Duration loading…" : audioTime(duration)}
      ${progress && progress.positionMs > 0 ? html` · ${audioTime(progress.positionMs)} listened` : nothing}
      ${row.sizeBytes === null ? nothing : html` · ${bytes(row.sizeBytes)}`}</p>
    ${duration !== null && progress ? html`<progress aria-label="Listening progress" max=${duration} value=${progress.positionMs}></progress>` : nothing}
    ${row.error ? html`<p class="audio-error" role="status">${row.error} Refresh or retry Play.</p>` : nothing}
    <div class="audio-actions">
      <button ?disabled=${busy} @click=${() => request(propose, { action: "play", target })}>${progress?.mark === "DONE" ? "Play again" : progress?.positionMs ? "Resume" : "Play"}</button>
      ${progress?.mark !== "DONE" ? html`<button ?disabled=${busy} @click=${() => request(propose, { action: "done", target })}>Mark done</button>` : nothing}
      ${progress && progress.mark !== "UNPLAYED" ? html`<button ?disabled=${busy} @click=${() => request(propose, { action: "unplayed", target })}>Mark unplayed</button>` : nothing}
      <button class="audio-delete" ?disabled=${busy} @click=${() => request(propose, { action: "prepareDelete", target })}>Delete download</button>
    </div></li>`;
};
const historyView = (item: AudioHistory, busy: boolean, propose: Propose): TemplateResult => html`
  <li class="audio-row audio-history">${title(item)}
    <p class="audio-detail">${item.availability === "MISSING" || item.deletion === "ABSENT" ? "Not downloaded on this phone" : item.availability === "OTHER_ROOT" ? "From another folder" : "Download availability not confirmed"}
      · ${label(item.listening.mark)} · ${audioTime(item.listening.positionMs)}</p>
    ${item.deletion === "INTENT" ? html`<p class="audio-error">Deletion pending. Retry checks the original file version.</p>
      <div class="audio-actions"><button ?disabled=${busy} @click=${() => request(propose, { action: "retryDelete", id: item.id })}>Retry deletion</button>
      <button ?disabled=${busy} @click=${() => request(propose, { action: "stopRetrying", id: item.id })}>Stop retrying</button></div>` : nothing}
    ${item.deletion === "CHANGED" ? html`<p class="audio-detail">A replacement download was kept.</p>` : nothing}
    <div class="audio-actions"><button ?disabled=${busy} @click=${() => request(propose, {
      action: item.listening.mark === "DONE" ? "historyUnplayed" : "historyDone", id: item.id })}>${item.listening.mark === "DONE" ? "Mark unplayed" : "Mark done"}</button></div>
  </li>`;

export const audioView = (audio: AudioModel, propose: Propose): TemplateResult => {
  const s = audio.snapshot, busy = audio.busy > 0 || s?.operation !== null && s?.operation !== undefined;
  const failure = audio.error ?? s?.failure;
  const terms = audio.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = (item: AudioRow | AudioHistory): boolean => {
    const text = [item.title, item.author ?? "", item.path].join(" ").toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  };
  const rows = (s?.rows ?? []).filter(row => (row.listening?.mark ?? "UNPLAYED") === audio.filter &&
    (audio.source === "all" || row.path.startsWith(`${audio.source}/`)) && matches(row));
  const visibleIds = new Set((s?.rows ?? []).flatMap(row => row.durableId === null ? [] : [row.durableId]));
  const history = (s?.history ?? []).filter(item => item.deletion !== "INTENT" && !visibleIds.has(item.id) && item.listening.mark === audio.filter &&
    (audio.source === "all" || item.path.startsWith(`${audio.source}/`)) && matches(item));
  const pending = (s?.history ?? []).filter(item => item.deletion === "INTENT");
  return html`<section class="audio-library" aria-label="Audio library">
    <header class="audio-heading"><div><h1>Audio</h1><p>Downloaded recordings, at your own pace.</p></div>
      <button ?disabled=${busy || s === null} @click=${() => request(propose, { action: "refresh" })}>Refresh</button></header>
    ${failure ? html`<div class="audio-error" role="alert"><p>${failure.message}</p>
      ${s === null ? html`<button @click=${() => propose({ kind: "audioReconnect" })}>Reconnect audio</button>` : html`<button ?disabled=${busy} @click=${() => request(propose, { action: "reopen" })}>Reopen audio state</button>`}</div>` : nothing}
    ${s?.warning ? html`<p class="audio-notice">${s.warning}</p>` : nothing}
    ${s?.recoveryRequired ? html`<button ?disabled=${busy} @click=${() => request(propose, { action: "restore" })}>Restore prior checkpoint</button>` : nothing}
    ${pending.length ? html`<div class="audio-pending"><h2>Pending deletions</h2>
      <p>Stop retrying keeps the current files as they are. It does not restore a removed download.</p>
      <ul class="audio-list">${pending.map(item => historyView(item, busy, propose))}</ul></div>` : nothing}
    ${s?.operation ? html`<p class="audio-notice" role="status">${s.operation}</p>` : nothing}
    ${s === null ? html`<p class="audio-notice">Connecting to audio…</p>` : !s.rootSelected ? html`
      <div class="audio-empty"><h2>Your downloads, here.</h2><p>Choose this phone’s phone-media folder to listen to Opus recordings and M4B audiobooks.</p>
      <button ?disabled=${busy} @click=${() => request(propose, { action: "chooseFolder" })}>Choose audio folder</button></div>` : html`
      <div class="audio-search">
        <input type="search" aria-label="Search audio" placeholder="Search title, author or filename"
          autocomplete="off" autocapitalize="none" spellcheck="false" .value=${live(audio.query)}
          @input=${(event: Event) => propose({ kind: "audioFilter", query: (event.target as HTMLInputElement).value })} />
        ${audio.query ? html`<button @click=${() => propose({ kind: "audioFilter", query: "" })}>Clear</button>` : nothing}
      </div>
      <div class="audio-filters"><div role="group" aria-label="Listening state">${(["UNPLAYED", "IN_PROGRESS", "DONE"] as const).map(filter => html`
        <button aria-pressed=${audio.filter === filter} class=${audio.filter === filter ? "on" : ""}
          @click=${() => propose({ kind: "audioFilter", filter })}>${label(filter)}</button>`)}</div>
        <label>Source <select .value=${live(audio.source)} @change=${(event: Event) => propose({ kind: "audioFilter", source: (event.target as HTMLSelectElement).value })}>
          <option value="all">All sources</option><option value="youtube">YouTube</option><option value="podcasts">Podcasts</option><option value="audiobooks">Audiobooks</option>
        </select></label></div>
      ${rows.length || history.length ? html`<ul class="audio-list">${rows.map(row => rowView(row, busy || pending.some(item => item.currentRoot && item.path === row.path), propose))}${history.map(item => historyView(item, busy, propose))}</ul>` : html`
        <p class="audio-notice" role="status">${terms.length ? "No recordings match your search in this view." : `No ${label(audio.filter).toLowerCase()} recordings here.`}</p>`}
      <footer class="audio-footer"><span>Opus · M4B · Local files only</span>
        <button ?disabled=${busy} @click=${() => request(propose, { action: "chooseFolder" })}>Change audio folder</button></footer>`}
  </section>`;
};

export const audioPlayer = (audio: AudioModel, propose: Propose): TemplateResult | typeof nothing => {
  const s = audio.snapshot, player = s?.player;
  if (!s || !player) return nothing;
  const item = s.history.find(item => item.id === player.item), row = s.rows.find(row => row.durableId === player.item);
  const busy = audio.busy > 0 || s.operation !== null;
  const seek = (positionMs: number) => request(propose, { action: "seek", id: player.item, positionMs: Math.max(0, positionMs) });
  return html`<aside class="audio-player" aria-label="Audio player">
    <div class="audio-player-title"><strong>${item?.title ?? "Audio"}</strong><span>${player.playing ? "Playing" : "Paused"}</span></div>
    <div class="audio-player-controls">
      <button aria-label="Back 15 seconds" ?disabled=${busy || player.durationMs === null} @click=${() => seek(player.positionMs - 15000)}>−15</button>
      ${player.playing || s.operation !== null ? html`<button @click=${() => request(propose, { action: "pause" })}>Pause</button>` : html`
        <button ?disabled=${busy || !row} @click=${() => { if (row) request(propose, { action: "play", target: { item: row.item, version: row.version } }); }}>Play</button>`}
      <button aria-label="Forward 30 seconds" ?disabled=${busy || player.durationMs === null} @click=${() => seek(player.positionMs + 30000)}>+30</button>
      <span class="audio-clock">${audioTime(player.positionMs)} / ${player.durationMs === null ? "—" : audioTime(player.durationMs)}
        ${player.durationMs === null ? nothing : html` · −${audioTime(player.durationMs - player.positionMs)}`}</span>
    </div>
    <input class="audio-seek" aria-label="Playback position" type="range" min="0" max=${player.durationMs ?? 1}
      .value=${live(String(player.positionMs))} ?disabled=${busy || player.durationMs === null}
      @change=${(event: Event) => seek(Number((event.target as HTMLInputElement).value))} />
  </aside>`;
};
export const audioConfirmation = (audio: AudioModel, propose: Propose): TemplateResult | typeof nothing => {
  const c = audio.confirmation; if (!c) return nothing;
  const cancel = () => request(propose, { action: "cancelDelete", token: c.token });
  return html`<div class="audio-dialog-backdrop"><div role="dialog" aria-modal="true" aria-labelledby="audio-delete-title" class="audio-dialog"
    @keydown=${(event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); cancel(); }
      if (event.key === "Tab") {
        const buttons = (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("button");
        if ((!event.shiftKey && document.activeElement === buttons[1]) || (event.shiftKey && document.activeElement === buttons[0])) {
          event.preventDefault(); buttons[event.shiftKey ? 1 : 0]?.focus();
        }
      } }}>
    <h2 id="audio-delete-title">Delete download?</h2><p><strong>${c.title}</strong></p><p class="audio-path">${c.path} · ${bytes(c.sizeBytes)}</p>
    <p>Remove this phone’s download and keep its listening history. This cannot be undone here.</p>
    <div class="audio-actions"><button data-audio-confirm @click=${cancel}>Cancel</button>
      <button class="audio-delete" @click=${() => request(propose, { action: "confirmDelete", token: c.token })}>Delete download</button></div>
  </div></div>`;
};
