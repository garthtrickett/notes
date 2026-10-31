// The loop. Everything enters through propose() and leaves through nap().
//
//   proposal -> present() -> render() -> nap() -> action -> proposal -> ...
//
// present() owns note state; nap() and propose() additionally write the in-flight
// flags beside it — persisting, syncing, retryAt, lastSyncedAt. That is a
// deliberate boundary, not an oversight: the loop *starts* an operation, present
// *concludes* it, so the fields do not partition by owner.
//
// The safety property does not rest on there being one writer. It rests on every
// write happening synchronously inside one turn — nap() is called from propose(),
// never from a callback — and on no async code ever seeing a Model. Actions take
// notes and a client; none of them receives one.

import { render } from "lit-html";
import {
  createModel,
  dumpDays,
  present,
  type Model,
  type Note,
  type Proposal,
} from "./model.ts";
import { canInstall, downloadUpdate, installUpdate, openInstallSettings } from "./update.ts";
import { composeDump, dumpEdits, dumpPathOf, dumpSections, dumpSpotAt, isDumpPath } from "./dump.ts";
import * as actions from "./actions.ts";
import type { Github } from "./github.ts";
import { createPreviewCache, localImage, view } from "./view.ts";
import { createTaskCache, rollRepeats, setReminder, tasksInVault, type TaskRef } from "./tasks.ts";
import { advanceTaskLinks, guardedTasks } from "./task-links.ts";
import { askToRemind, reminderSetKey, remindersDeliverable, knownShas, syncAlarms, syncTaskReminders, syncWebReminders } from "./notify.ts";
import type { CheckinSlot } from "./checkins.ts";
import { createMedia } from "./media.ts";
import type { VaultConfig } from "./view-settings.ts";
import { createEditor, type EditorHandle } from "./editor.ts";
import { followLink, resolveLink } from "./links.ts";
import { titleFor, urlFor } from "./url.ts";
import { nativeAudioLibrary, type AudioLibrary } from "./audio-library.ts";
import type { AudioConnection } from "./audio.ts";
import { nativeStorageTest, type AudioStorageTest } from "./audio.ts";
import { nativePhotoShares, type PhotoShares } from "./photos.ts";
import { photoNotePath, preparePhotoShare } from "./photo-actions.ts";
import { importPhotoShare, photoImportPath } from "./idb.ts";
import { nativeLookupInbox, type LookupInbox } from "./lookup.ts";
import { lookupImported } from "./idb.ts";
import { nativeAlarmNotes, type AlarmNoteInbox } from "./alarm-note.ts";
import { nativeWidgetSyncReporter, widgetSyncSnapshot, type WidgetSyncReporter } from "./widget-sync.ts";

export interface Deps {
  readonly widgetSync?: WidgetSyncReporter;
  readonly alarmNotes?: AlarmNoteInbox;
  readonly lookupInbox?: LookupInbox;
  readonly photoShares?: PhotoShares;
  readonly audioStorageTest?: AudioStorageTest;
  readonly audioLibrary?: AudioLibrary;
  readonly db: IDBDatabase;
  readonly shrink: import("./attachments.ts").Shrinker;
  readonly github: Github | null;
  readonly now: () => number;
  // Injected so tests can drive the cooldown without waiting for real seconds.
  readonly schedule: (ms: number, fire: () => void) => void;
  // Reading and writing the stored vault config is ambient, so it is injected
  // rather than reached for.
  readonly config?: VaultConfig | null;
  readonly saveConfig?: (config: VaultConfig) => void;
  // Check-in done-ness is per-device state in localStorage. Injected like the
  // config rather than reached for; absent (as in most tests) it simply does
  // not persist.
  // Where the app now is. The loop says it; whether that becomes a new history
  // entry or replaces the current one is not a decision it can make, so it
  // does not try to.
  readonly navigate?: (url: string, title: string) => void;
}

export interface Loop {
  readonly dispose: () => void;
  readonly model: Model;
  readonly propose: (p: Proposal) => void;
  readonly flush: () => Promise<void>;
  readonly whenSaved: () => Promise<boolean>;
  // Focus is not model state, so it is not a proposal. The loop holds the
  // editor, so it is the only thing that can offer this.
  readonly enterEditor: () => void;
  // Opens the editor's find when there is an editor on screen, and says
  // whether it did — so Ctrl+F can fall through to the browser's find where
  // the page itself is the text (preview, the tasks list).
  readonly find: () => boolean;
}

const FIRST_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

// How long a note has to sit untouched before it is worth pushing. Nothing is
// at risk while it waits: phase 1 has already put the edit on the device, and
// only the trip to GitHub is held back. Without it every keystroke that settles
// became its own commit, so a sentence arrived as a dozen of them.
const QUIET_MS = 1_500;

export const createLoop = (deps: Deps, root: HTMLElement): Loop => {
  const { db, github, now, schedule, shrink } = deps;
  const model = createModel();
  const audioStorageTest = deps.audioStorageTest ?? nativeStorageTest();
  const audioLibrary = deps.audioLibrary ?? nativeAudioLibrary();
  const photoShares = deps.photoShares ?? nativePhotoShares();
  const lookupInbox = deps.lookupInbox ?? nativeLookupInbox();
  const alarmNotes = deps.alarmNotes ?? nativeAlarmNotes();
  let audioConnection: AudioConnection | null = null;
  let disposed = false;
  let audioConnectionGeneration = 0;
  let wakeScheduled = false;
  // When each note was last typed into. Bookkeeping about the loop rather than
  // about notes — the same reason the backoff lives here and not in present(),
  // which has no clock and should not be given one.
  const touched = new Map<string, number>();

  let renderQueued = false;
  // A change of note, or of preview, replaces the editor's contents wholesale.
  // Anything else is a change dispatched into the state that is already there.
  let lastEditorKey: string | null = null;
  const reportWidgetSync = deps.widgetSync ?? nativeWidgetSyncReporter(deps.config ?? null);
  let checkedAt: number | null = null;
  let pulledAt: number | null = null;
  let lastModal: string | null = null;
  let lastAudioConfirmation: string | null = null;
  let lastPaletteIndex: number | null = null;
  let lastUrl: string | null = null;
  const previewCache = createPreviewCache();
  // File bodies scan identically every paint, so the task list keeps a
  // per-path memo beside the preview cache.
  const tasks = createTaskCache();
  // Bytes are read from the blob store when something needs to show them, and
  // held as object URLs rather than on the notes themselves.
  const media = createMedia(db, () => scheduleRender());
  // Everything currently in flight, not merely the most recent thing started.
  // A push can begin while a persist is still running — the first block is
  // skipped rather than returned from — so assigning would drop the persist's
  // promise on the floor.
  // The note or the dump is in the editor. Not the bin, the archive,
  // settings, preview, or no note open.
  const editorOnScreen = (): boolean =>
    model.mode === "dump" ||
    (model.mode === "notes" && model.openPath !== null && !model.preview);

  let idle: Promise<void> = Promise.resolve();
  const track = (work: Promise<unknown>): void => {
    idle = Promise.all([idle, work]).then(() => undefined);
  };

  // One place that starts (or restarts) the update machine. Permission first:
  // downloading without it is what produced the original silent nothing.
  const beginUpdate = async (): Promise<void> => {
    // A bridge that throws instead of answering is a failure with a name,
    // not an unhandled rejection in the console.
    let allowed: boolean;
    try {
      allowed = await canInstall();
    } catch (error) {
      propose({ kind: "updateFailed", error: `Install check failed: ${String(error)}` });
      return;
    }
    if (!allowed) {
      propose({ kind: "updatePermissionNeeded" });
      return;
    }
    const found = await downloadUpdate(model.update.url);
    propose(found);
  };

  const capture = (text: string) => {
    for (const p of actions.captureProposals(model.notes, text, now)) propose(p);
  };

  // Ticking a check-in is an edit to today's dump file and nothing else, so it
  // takes capture's route rather than growing a proposal of its own.
  const checkin = (slot: CheckinSlot) => {
    for (const p of actions.checkinProposals(model.notes, slot, now)) propose(p);
  };

  // Setting a reminder is an edit to the line it is on, so it goes the same way
  // a tick does. Nothing is stored beside the note.
  const remind = (ref: TaskRef, at: number | null, alarm = ref.alarm) => {
    const body = model.notes.get(ref.path)?.body;
    if (body === undefined) return;
    const next = setReminder(body, ref, at, alarm);
    if (next === body) return;
    propose({ kind: "edited", path: ref.path, body: next });
    // Setting one is the gesture that earns the right to ask. The answer moves
    // nothing in the model — napReminders is already retrying until something
    // accepts the set — so it is proposed back only to re-run that.
    if (at !== null) {
      track(askToRemind().then(() => propose({ kind: "woke" })));
    }
  };

  // Where the caret is differs by surface; what to do with a pasted image does
  // not (never duplicate rules).
  // The clipboard and a drag hand over an image differently; what happens to it
  // afterwards is the same (never duplicate rules).
  const attachImage = (file: File, path: string, caret: number | null): Promise<number> => {
    const note = model.notes.get(path);
    if (!note || note.deleted) return Promise.resolve(0);
    propose({ kind: "photoWorkStarted" });
    const work = actions
        .attach(file, note, caret ?? note.body.length, now, shrink)
        .then(async (p) => {
          // Store the bytes first. The proposal that follows describes a record
          // whose bytes are already somewhere the renderer can find them.
          if (p.kind === "attached") {
            await actions.storeBlobs(db, [
              { path: p.path, body: p.base64, encoding: "base64" },
            ]);
            media.forget([p.path]);
          }
          return p;
        })
        .then(p => {
          propose(p.kind === "failed" ? { kind: "photoFailed", error: p.error } : p);
          return p.kind === "attached" ? p.ref.length : 0;
        })
        .catch((cause: unknown) => {
          propose({ kind: "photoFailed", error: { kind: "imageUnreadable", cause: String(cause) } });
          return 0;
        }).finally(() => { if (!disposed) propose({ kind: "photoWorkFinished" }); });
    track(work);
    return work;
  };

  const addPhoto = (camera: boolean): void => {
    if (model.mode !== "notes" || model.openPath === null) return;
    // Capture the destination before leaving for Android's picker/camera.
    // A sync, navigation, or re-render while it is open must not redirect it.
    const path = model.openPath;
    const note = model.notes.get(path);
    if (!note || note.deleted) return;
    let caret = model.preview ? note.body.length : cm.caret();
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = !camera;
    input.hidden = true;
    input.setAttribute("data-photo-picker", "");
    if (camera) input.setAttribute("capture", "environment");
    input.addEventListener("cancel", () => input.remove(), { once: true });
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      input.remove();
      track((async () => {
        for (const file of files) caret += await attachImage(file, path, caret);
      })());
    }, { once: true });
    root.append(input);
    input.click();
  };

  let receivingPhotos = false;
  let receivingNote = false;
  let noteChanged = false;
  let openedNoteRequest: string | null = null;
  const receiveNote = async (): Promise<void> => {
    if (!alarmNotes.supported || !model.hydrated || disposed) return;
    noteChanged = true;
    if (receivingNote) return;
    receivingNote = true;
    try {
      do {
        noteChanged = false;
        const request = await alarmNotes.pending();
        if (disposed || request === null) return;
        // The native background reader can see an alert before this WebView's
        // cache does. Leave the request pending until a pull brings its note.
        const target = model.notes.get(request.path);
        if (!target || target.deleted || target.encoding !== "utf8") return;
        if (openedNoteRequest !== request.id) {
          propose({ kind: "openRequested", path: request.path });
          if (model.openPath !== request.path || model.mode !== "notes") return;
          openedNoteRequest = request.id;
        }
        // An acknowledgement loss must not drag the user back after they
        // navigate away. A newer tap has a different ID and wins atomically.
        await alarmNotes.acknowledge(request.id);
      } while (noteChanged && !disposed);
    } catch { /* Older shells/offline bridges keep their durable request. */ }
    finally { receivingNote = false; }
  };
  let receivingLookups = false;
  let lookupsChanged = false;
  const receiveLookups = async (): Promise<void> => {
    if (!lookupInbox.supported || !model.hydrated || disposed) return;
    lookupsChanged = true;
    if (receivingLookups) return;
    receivingLookups = true;
    try {
      do {
        lookupsChanged = false;
        for (const capture of await lookupInbox.pending()) {
          if (disposed) return;
          if (await lookupImported(db, capture.id)) {
            try { await lookupInbox.acknowledge(capture.id); } catch { /* Retry next open. */ }
          } else if (!disposed) propose({ kind: "lookupCaptured", capture });
        }
      } while (lookupsChanged && !disposed);
    } catch { if (!disposed) propose({ kind: "lookupFailed" }); }
    finally { receivingLookups = false; }
  };
  let photosChanged = false;
  const receivePhotos = async (): Promise<void> => {
    if (!photoShares.supported || !model.hydrated || disposed) return;
    photosChanged = true;
    if (receivingPhotos) return;
    receivingPhotos = true;
    try {
      do {
        photosChanged = false;
        const batches = await photoShares.pending();
        for (const batch of batches) {
          if (disposed) return;
          let preparing = false;
          try {
            if (await photoImportPath(db, batch.id) === null) {
              preparing = true;
              propose({ kind: "photoWorkStarted" });
              const path = photoNotePath(batch, new Set(model.notes.keys()));
              const prepared = await preparePhotoShare(batch, path, photoShares.read, shrink);
              if (!prepared.ok) { propose({ kind: "photoShareFailed", id: batch.id, error: prepared.error }); continue; }
              if (disposed) return;
              const saved = await importPhotoShare(db, batch.id, prepared.value.note, prepared.value.attachments);
              media.forget(saved.attachments.map(record => record.path));
              if (!saved.alreadyImported && !disposed) propose({ kind: "photoShareImported",
                note: prepared.value.note, attachments: saved.attachments });
            }
            // A failed acknowledgment is retried on the next foreground entry.
            // The durable receipt prevents duplicate or resurrected notes.
            propose({ kind: "photoShareResolved", id: batch.id });
            try { await photoShares.acknowledge(batch.id); }
            catch { /* Only the temporary-copy cleanup remains; the note is safe. */ }
          } catch (cause) {
            if (!disposed) propose({ kind: "photoShareFailed", id: batch.id, error: { kind: "photoImportFailed", cause: String(cause) } });
          } finally {
            if (preparing && !disposed) propose({ kind: "photoWorkFinished" });
          }
        }
      } while (photosChanged && !disposed);
    } catch (cause) {
      if (!disposed) propose({ kind: "photoFailed", error: { kind: "photoImportFailed", cause: String(cause) } });
    } finally { receivingPhotos = false; }
  };

  const retryPhotoShare = (): void => {
    if (disposed || model.photosBusy > 0) return;
    const id = model.photoShareFailure?.id;
    if (id !== undefined) propose({ kind: "photoShareResolved", id });
    track(receivePhotos());
  };
  const discardPhotoShare = (id: string): void => {
    if (disposed || model.photosBusy > 0 || model.photoShareFailure?.id !== id) return;
    propose({ kind: "photoWorkStarted" });
    track(photoShares.acknowledge(id).then(() => {
      if (!disposed) propose({ kind: "photoShareResolved", id });
    }).catch((cause: unknown) => {
      if (!disposed) propose({ kind: "photoShareFailed", id, error: { kind: "photoImportFailed", cause: String(cause) } });
    }).finally(() => { if (!disposed) propose({ kind: "photoWorkFinished" }); }));
  };

  const pasteImage = (event: ClipboardEvent, path: string, caret: number | null) => {
    const file = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .find((f): f is File => f !== null);
    if (!file) return; // a normal text paste; let the editor handle it

    event.preventDefault();
    attachImage(file, path, caret);
  };

  // Which file a picture dropped at this position belongs in, and where in it.
  //
  // In the dump that is not the open note: openPath still names whichever note
  // the tree had open behind it, and attaching there would file the picture
  // somewhere you are not looking. It is the day under the caret, which needs
  // the document offset turned back into one in that day's file.
  const attachSpot = (caret: number | null): { path: string; offset: number } | null => {
    if (model.mode === "dump") return dumpSpotAt(dumpDays(model), caret ?? 0);
    if (model.openPath === null) return null;
    const note = model.notes.get(model.openPath);
    return { path: model.openPath, offset: caret ?? note?.body.length ?? 0 };
  };

  // Created once, before the first paint, and outlives every one of them. lit is
  // handed an empty container and never touches what is inside it.
  const cm: EditorHandle = createEditor({
    resolveImage: (src) => localImage(model, media, src),
    // Asked at paint time, so a link starts working the moment the note it
    // points at exists.
    resolveWikilink: (target) => resolveLink(target, model.notes).kind,
    onEdit: (body) => {
      // The dump is many files behind one document, so an edit is however many
      // of them the text now disagrees with — usually one, and none at all
      // while you are typing inside a day that has not changed shape.
      if (model.mode === "dump") {
        for (const day of dumpEdits(body, dumpDays(model))) {
          propose({ kind: "edited", path: day.path, body: day.body });
        }
        return;
      }
      if (model.openPath !== null) {
        propose({ kind: "edited", path: model.openPath, body });
      }
    },
    onPaste: (event, caret) => {
      const spot = attachSpot(caret);
      if (spot !== null) pasteImage(event, spot.path, spot.offset);
    },
    onDropFiles: (files, caret) => {
      const image = [...files].find((f) => f.type.startsWith("image/"));
      // Anything else is left to CodeMirror, which will drop its text in.
      const spot = attachSpot(caret);
      if (image === undefined || spot === null) return false;
      attachImage(image, spot.path, spot.offset);
      return true;
    },
    onWikilink: (target) => {
      const proposal = followLink(target, model.notes);
      if (proposal !== null) {
        propose(proposal);
        return;
      }
      // followLink says nothing for an ambiguous target, and a click that
      // silently does nothing is how someone concludes the app is broken.
      propose({ kind: "linkRefused", target });
    },
  });

  // Whether a picture can be drawn at all is what the decorations depend on, and
  // it changes when an attachment arrives or goes. Cheaper than re-parsing on
  // every paint, and it moves for both.
  let lastImageKey = "";
  const imageKey = (): string => {
    let key = "";
    for (const note of model.notes.values()) {
      if (note.encoding === "base64" && !note.deleted) key += `${note.path};`;
    }
    // How many attachments have their bytes to hand, which changes as they
    // arrive. A repaint alone does not rebuild decorations, so without this the
    // widget asked once, got null, and never asked again — the picture stayed
    // missing until the note was edited.
    return `${key}|${media.size()}`;
  };

  // A search navigation is a one-shot editor position, not stored note state.
  // Resolve it after composing the current dump, so edits and incoming days
  // cannot leave an offset pointing into a different day.
  let dumpJump: { path: string; query: string } | null = null;
  const paint = () => {
    if (model.mode !== "dump") dumpJump = null;
    render(
      view(model, {
        audioStorageTestSupported: audioStorageTest.supported,
        propose,
        now,
        onCapture: capture,
        onAddPhoto: addPhoto,
        onRetryPhotoShare: retryPhotoShare,
        onDiscardPhotoShare: discardPhotoShare,
        photoCaptureSupported: photoShares.supported,
        onCheckin: checkin,
        onRemind: remind,
        previewCache,
        media,
        tasks,
        config: deps.config ?? null,
        onSaveConfig: (next) => deps.saveConfig?.(next),
      }),
      root,
    );

    // Focus a modal as it opens, and only then — refocusing on every paint would
    // fight the caret while typing. One rule, whichever modal it is.
    // By kind, not by object: what matters is that a different dialog appeared.
    const confirmation = model.audio.confirmation?.token ?? null;
    if (confirmation !== lastAudioConfirmation) {
      lastAudioConfirmation = confirmation;
      if (confirmation !== null) root.querySelector<HTMLElement>("[data-audio-confirm]")?.focus();
    }
    const modalKind = model.modal?.kind ?? null;
    if (modalKind !== lastModal) {
      lastModal = modalKind;
      if (model.modal !== null) {
        // Not always an input: the confirm dialog puts it on Cancel, so the
        // safe answer is the one already under your fingers.
        root.querySelector<HTMLElement>("#modal-input")?.focus();
      }
    }

    // Arrow keys move the palette's selection, and past the tenth result it was
    // moving out of sight — you were choosing blind and Enter opened something
    // you could not see.
    const palettePos = model.modal?.kind === "open" ? model.paletteIndex : null;
    if (palettePos !== lastPaletteIndex) {
      lastPaletteIndex = palettePos;
      root.querySelector(".results .row.open")?.scrollIntoView({ block: "nearest" });
    }

    // The path box is uncontrolled while it has focus, so lit will not rewrite
    // what was typed into it. Once focus leaves, it has to agree with the note
    // that is actually open — otherwise a refused rename leaves it naming a
    // note you are not looking at.
    const field = root.querySelector<HTMLInputElement>(".pathfield");
    if (field !== null && document.activeElement !== field) {
      const shown = model.openPath ?? "";
      if (field.value !== shown) field.value = shown;
    }

    const editorKey = `${model.mode}|${model.preview}|${model.openPath ?? ""}`;
    const days = model.mode === "dump" ? dumpDays(model) : null;
    const body =
      days !== null
        ? composeDump(days)
        : model.openPath
          ? (model.notes.get(model.openPath)?.body ?? "")
          : "";

    const host = root.querySelector<HTMLElement>("#editor-host");
    if (host) {
      // lit rebuilds the host when the surrounding template changes shape, so
      // re-attach rather than assume. Moving the same node is a no-op.
      if (cm.dom.parentElement !== host) host.appendChild(cm.dom);

      // A new note gets a whole new state so undo stops at the note boundary.
      // Anything else — a pull, a rename rewriting links, a pasted image — is a
      // change dispatched into the state we have, and CodeMirror maps the
      // selection through it.
      if (editorKey !== lastEditorKey) {
        lastEditorKey = editorKey;
        cm.reset(body);
      } else if (days !== null) {
        // Through the split, not as text. Composing normalises whitespace, so
        // comparing the strings would rewrite the document on every keystroke —
        // and a blank line typed at the end of a day would be trimmed away
        // under the caret as it was typed. What matters is whether the document
        // still says what the files say.
        if (dumpEdits(cm.doc(), days).length > 0) cm.setDoc(body);
      } else if (cm.doc() !== body) {
        cm.setDoc(body);
      }

      if (dumpJump !== null && days !== null) {
        const jump = dumpJump;
        dumpJump = null;
        const section = dumpSections(days).find(day => day.path === jump.path);
        if (section) {
          const text = cm.doc().slice(section.from, section.to);
          const match = jump.query === "" ? -1 : text.toLowerCase().indexOf(jump.query);
          cm.focusAt(match < 0 ? section.start : section.from + match);
        }
      }

      const images = imageKey();
      if (images !== lastImageKey) {
        lastImageKey = images;
        cm.redecorate();
      }
    } else {
      lastEditorKey = editorKey;
    }

    // Undo and redo are the editor's history, not model state, so the buttons
    // cannot read them from a paint — but a lit button left lit with nothing
    // to undo is a lie the thumb discovers. Synced here, after the editor,
    // the way the path field is. No editor on screen means both dark: the
    // bin, the archive, settings, preview, and no note open.
    const editing = editorOnScreen();
    const undoButton = root.querySelector<HTMLButtonElement>("#undo-edit");
    if (undoButton !== null) undoButton.disabled = !editing || !cm.canUndo();
    const redoButton = root.querySelector<HTMLButtonElement>("#redo-edit");
    if (redoButton !== null) redoButton.disabled = !editing || !cm.canRedo();

    // Last, because everything above can still change which note is open.
    const url = urlFor(model);
    if (url !== lastUrl) {
      lastUrl = url;
      deps.navigate?.(url, titleFor(model));
    }
  };

  // The history panel asks for two things, in order: the list of revisions, then
  // the body of whichever one is selected. Both are read-only and neither
  // touches note state, so a failure shows in the panel and nowhere else.
  const napHistory = (): void => {
    const h = model.history;
    if (h === null || github === null || h.loading) return;
    if (h.revisions === null) {
      h.loading = true;
      track(actions.loadHistory(github, h.path).then(propose));
      return;
    }
    if (h.viewingSha !== null && h.viewingBody === null) {
      h.loading = true;
      track(actions.loadRevision(github, h.path, h.viewingSha).then(propose));
    }
  };

  const scheduleRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      paint();
    });
  };

  // Every automatic behaviour lives here, and every rule is a function of model
  // state rather than something a scheduler remembers.
  // The OS holds the alarms; the notes decide what they should be. Rebuilt
  // whenever the answer changes, which is the only way a reminder set on the
  // laptop becomes an alarm on the phone — the text arrives by sync, and this
  // turns it into something the OS will deliver.
  let lastReminderKey: string | null = null;
  let lastAlarmKey: string | null = null;
  const napReminders = () => {
    if (!model.hydrated || !remindersDeliverable()) return;
    const refs = guardedTasks(tasksInVault(model.notes, tasks).flatMap(group => group.refs));
    const key = reminderSetKey(refs);
    // Alarms are separate from notifications. The phone takes the whole set
    // and diffs it itself, so this runs every time the set changes — that is
    // what moves an alarm when its task is retimed, and cancels it when the
    // task is ticked or loses its `!`.
    //
    // Recorded before it is sent, unlike the notifications below, and on its
    // own key. Its warning is a proposal, a proposal runs nap, and nap is
    // here again: keyed on the notifications' "delivered" this re-sent the
    // set and re-raised the warning for as long as notification permission
    // was still being asked. A setting the warning names is picked up without
    // a re-send — the phone reschedules what it holds when exact alarms are
    // allowed — so there is nothing a retry would add.
    if (key !== lastAlarmKey) {
      lastAlarmKey = key;
      track(
        syncAlarms(refs, now(), knownShas(model.notes.values())).then((result) => {
          if (result.error !== null) propose({ kind: "alarmFailed", reason: result.error });
        }),
      );
    }
    if (key === lastReminderKey) return;
    // Recorded only once the OS has it. Permission is requested on boot and
    // the answer arrives later, so the first attempts here are refused —
    // caching the key on one of those would leave every reminder unscheduled
    // for the rest of the session.

    // Android hands the set to the OS; the web arms timers in this page. Both
    // report whether they took it, and only then is the set recorded.
    if (syncWebReminders(refs, now())) {
      lastReminderKey = key;
      return;
    }
    track(
      syncTaskReminders(refs, now()).then((delivered) => {
        if (delivered) lastReminderKey = key;
      }),
    );
  };

  // A recurring completion reserves its next alarm while staying checked.
  // The day boundary reopens it. Both transitions are idempotent ordinary
  // edits and use the same persistence/sync path as a manual tick.
  const napRepeats = (): boolean => {
    if (!model.hydrated) return false;
    for (const group of tasksInVault(model.notes, tasks)) {
      if (!group.refs.some((r) => (r.done && r.repeat !== null) || r.nextRepeatAt !== undefined)) continue;
      const body = model.notes.get(group.path)?.body;
      if (body === undefined) continue;
      const next = rollRepeats(body, group.path, now());
      if (next === body) continue;
      propose({ kind: "edited", path: group.path, body: next });
      return true;
    }
    return false;
  };

  const nap = () => {
    if (model.hydrated) {
      const edits = advanceTaskLinks(model.notes.values(), now(), tasksInVault(model.notes, tasks).flatMap(g => g.refs));
      if (edits.size > 0) { propose({ kind: "taskLinksAdvanced", edits }); return; }
    }
    // Persist completion metadata before deriving the future alarm set.
    if (napRepeats()) return;
    napReminders();
    // 0. Whatever the history panel is waiting for. Read-only, independent of
    //    the sync rules below, and it must not be gated behind them — a stalled
    //    push should not leave the panel spinning.
    napHistory();

    // 1. Get local edits onto the device before anything else. Losing a note to
    //    a closed tab is worse than syncing late.
    if (!model.persisting && !model.persistBlocked) {
      // Forgetting comes first: a record left behind is a note that returns from
      // the dead on the next reload, which is worse than a late save.
      if (model.forgotten.size > 0) {
        const paths = [...model.forgotten];
        model.persisting = true;
        track(actions.forget(db, paths).then(propose));
        return;
      }
      const dirty = [...model.notes.values()].filter((n) => n.dirty);
      if (dirty.length > 0) {
        model.persisting = true;
        track(actions.persist(db, dirty).then(propose));
        return;
      }
    }

    // 1b. An empty dump day is residue, never state: a day file is only ever
    //     created with something already in it. Left behind it is a file the
    //     dump cannot remove, because dumpEdits loops over the days that exist
    //     and only ever emits edits — deleting the heading empties the file and
    //     the next paint composes it straight back.
    //
    //     Today is exempt. nap() runs at the end of every propose, and both
    //     capture and the check-ins create the day file in one proposal before
    //     writing to it in the next — so an empty today is a file something is
    //     about to fill, and collecting it races work that has not happened
    //     yet. Step 1 above happens to intervene on that exact path today, by
    //     starting a persist and returning before this rule is reached; the
    //     exemption is here so the rule does not depend on that ordering.
    if (model.hydrated && !model.persisting) {
      const today = dumpPathOf(now());
      const residue = [...model.notes.values()].find(
        (n) =>
          !n.deleted &&
          isDumpPath(n.path) &&
          n.path !== today &&
          n.body.trim() === "",
      );
      if (residue !== undefined) {
        propose({ kind: "purged", path: residue.path });
        return;
      }
    }

    if (github === null || model.syncing || !model.hydrated) return;

    // 2. A network failure cools off. Unlike phase 1's latch, this expires on
    //    its own — nobody is typing while the train is in a tunnel.
    if (now() < model.retryAt) {
      if (!wakeScheduled) {
        wakeScheduled = true;
        schedule(Math.max(0, model.retryAt - now()), () => {
          wakeScheduled = false;
          propose({ kind: "woke" });
        });
      }
      return;
    }
    if (!model.online) return;

    // 3. Push before pulling. An unpushed edit is the only state that exists
    //    nowhere else — but not while it is still being typed into.
    const readyAt = (n: Note): number => (touched.get(n.path) ?? 0) + QUIET_MS;
    const waiting = [...model.notes.values()].filter((n) => n.pending && !n.dirty);
    // Per note, not per keystroke: a note being typed into must not hold up one
    // that was finished with a minute ago.
    const pending = waiting.find((n) => now() >= readyAt(n));
    if (pending === undefined && waiting.length > 0) {
      const soonest = Math.min(...waiting.map(readyAt));
      if (!wakeScheduled) {
        wakeScheduled = true;
        schedule(Math.max(0, soonest - now()), () => {
          wakeScheduled = false;
          propose({ kind: "woke" });
        });
      }
      return;
    }
    if (pending) {
      touched.delete(pending.path);
      model.syncing = true;
      // An attachment's bytes are not on the record, so they are fetched for
      // the push and thrown away again afterwards.
      track(
        actions
          .bodyToPush(db, pending)
          .then((body) => actions.push(github, pending, now, model.notes, body))
          .then(propose),
      );
      return;
    }

    // 4. Pull once per session, plus again immediately while a large first
    //    import still has batches to go.
    if (model.lastSyncedAt === null || model.pullRemaining > 0) {
      model.syncing = true;
      model.lastSyncedAt = now();
      track(
        actions
          .pull(github, model.notes)
          .then(async (p) => {
            if (p.kind === "pulled") await actions.storeBlobs(db, p.notes);
            return p;
          })
          .then(propose),
      );
    }
  };

  function propose(p: Proposal): void {
    // Backoff is bookkeeping about the loop rather than about notes, so it lives
    // here instead of leaking a clock into present().
    // Typing is what the quiet period measures, so it is recorded where the
    // proposal arrives rather than inferred from the note afterwards.
    if (p.kind === "edited") touched.set(p.path, now());
    // Done-ness outlives the reload, so it is written on every toggle. A write
    // here rather than in present() for the same reason as the touched map:
    // present() has no clock and should not be given one.
    if (p.kind === "syncFailed") {
      if (p.error.kind === "rateLimited") {
        // GitHub said exactly when it will answer again. Doubling from one
        // second towards a sixty-second cap would just burn requests against a
        // window that might be an hour wide.
        model.retryDelay = p.error.retryAfterMs;
        model.retryAt = now() + p.error.retryAfterMs;
      } else {
        model.retryDelay = Math.min(
          model.retryDelay === 0 ? FIRST_BACKOFF_MS : model.retryDelay * 2,
          MAX_BACKOFF_MS,
        );
        model.retryAt = now() + model.retryDelay;
      }
    }
    const taskHasDate = p.kind === "taskAdded" && model.modal?.kind === "newTask" && (model.modal.draft.date !== "" || Boolean(model.modal.draft.after));
    const previousHead = model.remoteHead;
    const rejection = present(model, p);
    if (rejection === null && p.kind === "pulled" && p.remaining === 0) {
      pulledAt = checkedAt = now();
    } else if (rejection === null && pulledAt !== null &&
        (p.kind === "pushed" || p.kind === "removed" || (p.kind === "headSeen" && p.head === previousHead))) {
      checkedAt = now();
    }
    if (rejection === null && p.kind === "dumpOpened") dumpJump = { path: p.path, query: model.query.trim().toLowerCase() };
    if (rejection === null && (p.kind === "hydrated" || p.kind === "resumed" || p.kind === "pulled")) track(receiveNote());
    if (rejection === null && (p.kind === "hydrated" || p.kind === "resumed")) track(receivePhotos());
    if (rejection === null && (p.kind === "hydrated" || p.kind === "resumed" || p.kind === "persisted")) track(receiveLookups());
    if (rejection === null && p.kind === "audioReconnect") connectAudio();
    if (rejection === null && p.kind === "audioRequested" && model.audio.snapshot !== null) {
      const snapshot = model.audio.snapshot;
      track(audioLibrary.execute(p.command, snapshot).then(result => {
        if (disposed) return;
        if (!result.ok) { propose({ kind: "audioFinished", error: result.error }); return; }
        if ("protocol" in result.value) {
          propose({ kind: "audioSnapshot", snapshot: result.value });
          propose({ kind: "audioFinished", error: null });
        } else propose({ kind: "audioFinished", error: null, confirmation: result.value });
      }).catch(() => propose({ kind: "audioFinished", error: { kind: "BRIDGE", message: "Audio could not complete the action. Please retry." } })));
    }
    if (rejection === null && ((p.kind === "modeChanged" && p.mode === "audio") || (p.kind === "resumed" && model.mode === "audio") || (p.kind === "audioSnapshot" && p.handshake && model.mode === "audio"))) {
      if (model.audio.snapshot !== null && model.audio.busy === 0) propose({ kind: "audioRequested", command: { action: "refresh" } });
    }
    if (p.kind === "audioStorageTestRequested" && rejection === null) {
      track(audioStorageTest.open().then((result) =>
        propose({ kind: "audioStorageTestFinished", error: result.ok ? null : result.error }),
      ));
    }
    if (taskHasDate && rejection === null) {
      track(askToRemind().then(() => propose({ kind: "woke" })));
    }
    // Self-update downloads follow the attachImage shape: the proposal moves
    // the state, the work after it is tracked, and whatever comes back is
    // another proposal. The installer itself is fire-and-forget — cancelling
    // it means nothing happened, which the idle state already describes.
    // Update goes permission, then download, then installer — each step a
    // proposal, so whatever stops always names itself in the banner.
    if (p.kind === "updateStarted" && rejection === null) {
      track(beginUpdate());
    }
    // Undo and redo act on the editor, not the model: the resulting change
    // reports back through onEdit like a keystroke, which is what persists it.
    if (p.kind === "undoEdit" && rejection === null) cm.undo();
    if (p.kind === "redoEdit" && rejection === null) cm.redo();
    if (p.kind === "updateOpenSettings" && rejection === null) {
      // No state change: the answer is the user coming back, which resumed
      // observes. A settings screen that fails to open is worth hearing about.
      track(
        openInstallSettings().catch((error: unknown) =>
          propose({ kind: "updateFailed", error: `Settings failed: ${String(error)}` }),
        ),
      );
    }
    if (p.kind === "updateDownloaded" && rejection === null) {
      track(
        installUpdate(p.path).catch((error: unknown) =>
          propose({ kind: "updateFailed", error: `Install failed: ${String(error)}` }),
        ),
      );
    }
    if (p.kind === "resumed" && model.update.status === "permission") {
      // Back from the settings screen: if the toggle was flipped, carry on
      // without making them tap Update again.
      track(beginUpdate());
    }
    if (rejection !== null && import.meta.env.DEV) {
      // A rejection used to vanish. It is almost always a bug in the caller —
      // proposing against a note that is gone — and finding it by watching the
      // UI do nothing is how an afternoon disappears.
      console.warn(`[notes] rejected ${p.kind}: ${rejection.reason}`);
    }
    scheduleRender();
    nap();
    // A launcher indicator is outside the note durability barrier: even a
    // native reply that never arrives must not delay inbox acknowledgements.
    void reportWidgetSync(widgetSyncSnapshot(model, checkedAt, github !== null, pulledAt)).catch(() => {});
  }

  // A test affordance. It settles the loop: an action's proposal can start
  // another action, so it drains until nothing is in flight.
  //
  // The production build gets a no-op, so a user never runs a forty-iteration
  // spin that can throw. Checking PROD rather than DEV matters: outside Vite —
  // under `bun test` — neither is defined, and the tests need the real thing.
  //
  // It must check every in-flight flag. Returning while a push or pull is still
  // running makes callers add their own wait afterwards, which is a flake
  // waiting for a slow day.
  const flush = async (): Promise<void> => {
    if (import.meta.env.PROD) return;
    for (let i = 0; i < 40; i += 1) {
      const observed = idle;
      await observed;
      await new Promise<void>((r) => queueMicrotask(() => r()));
      if (observed === idle && !model.persisting && !model.syncing) return;
    }
    throw new Error("Loop did not settle");
  };

  // Production durability barrier for a native inbox acknowledgement. Unlike
  // the test-only flush it runs in a release build too. Waiting is driven by
  // actual tracked actions, not a delay or a busy loop.
  const whenSaved = async (): Promise<boolean> => {
    while (!disposed) {
      const observed = idle;
      await observed;
      await new Promise<void>(resolve => queueMicrotask(resolve));
      if (model.persistBlocked) return false;
      if (observed === idle && !model.persisting)
        return model.hydrated && ![...model.notes.values()].some(n => n.dirty);
    }
    return false;
  };

  // The caret at the top, because the shortcut exists to start writing — not to
  // resume wherever the last visit left off.
  const enterEditor = () => cm.focusAt(0);

  const find = (): boolean => {
    if (!editorOnScreen()) return false;
    cm.find();
    return true;
  };

  function connectAudio(): void {
    void audioConnection?.disconnect();
    let first = true;
    const connectionGeneration = ++audioConnectionGeneration;
    const previous = model.audio.snapshot;
    audioConnection = audioLibrary.connect(snapshot => {
      if (!disposed && connectionGeneration === audioConnectionGeneration) { propose({ kind: "audioSnapshot", snapshot, handshake: first }); first = false; }
    }, error => { if (!disposed && connectionGeneration === audioConnectionGeneration) propose({ kind: "audioError", error }); }, previous);
    track(audioConnection.ready.then(result => {
      if (!disposed && connectionGeneration === audioConnectionGeneration && !result.ok) propose({ kind: "audioError", error: result.error });
    }));
  }
  propose({ kind: "audioSupported", supported: audioLibrary.supported });
  if (audioLibrary.supported) connectAudio();
  let stopPhotos: (() => void) | null = null;
  let stopLookups: (() => void) | null = null;
  let stopAlarmNotes: (() => void) | null = null;
  if (alarmNotes.supported) track(alarmNotes.listen(() => { track(receiveNote()); }).then(stop => {
    if (disposed) stop(); else stopAlarmNotes = stop;
  }).catch(() => { /* Older APKs do not have the note bridge. */ }));
  if (lookupInbox.supported) track(lookupInbox.listen(() => { track(receiveLookups()); }).then(stop => {
    if (disposed) stop(); else stopLookups = stop;
  }).catch(() => { if (!disposed) propose({ kind: "lookupFailed" }); }));
  if (photoShares.supported) track(photoShares.listen(() => { track(receivePhotos()); }).then(stop => {
    if (disposed) stop(); else stopPhotos = stop;
  }).catch((cause: unknown) => {
    if (!disposed) propose({ kind: "photoFailed", error: { kind: "photoImportFailed", cause: String(cause) } });
  }));
  const dispose = () => {
    disposed = true;
    stopPhotos?.();
    stopLookups?.();
    stopAlarmNotes?.();
    root.querySelectorAll("[data-photo-picker]").forEach(input => input.remove());
    void audioConnection?.disconnect();
  };
  return { model, propose, flush, whenSaved, enterEditor, find, dispose };
};

export const boot = async (
  deps: Deps,
  root: HTMLElement,
  want: string | null = null,
): Promise<Loop> => {
  const loop = createLoop(deps, root);
  loop.propose(await actions.hydrate(deps.db));
  // A cold load on a link to a particular note. Hydrating has just picked a
  // note of its own; this is the one that was actually asked for.
  //
  // Only if it is here. On a device that has not synced yet the note genuinely
  // does not exist, and an error toast for following your own bookmark reads
  // as the app being broken rather than as the vault being empty.
  if (want !== null && loop.model.notes.has(want)) {
    loop.propose({ kind: "opened", path: want });
  }
  return loop;
};
