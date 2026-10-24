// The vault's open work, as a pure function of file bodies.
//
// A task is whatever the renderer calls one: a lezer Task node, parsed with
// the same markdownLanguage the decorations use. No regex, no second grammar
// for the two to disagree on — something is a task here exactly when it
// paints as one there. Toggling is one flipped character fed back through
// the ordinary edited proposal, so the model, the loop and sync never learn
// that tasks exist.

import { markdownLanguage } from "@codemirror/lang-markdown";
import type { Note } from "./model.ts";
import { isArchivePath, isTrashPath } from "./paths.ts";
import { alarmWanted, nextOccurrence, reminderIn, repeatIn, titleWithout, withReminder, stampOf } from "./reminders.ts";
import { readRepeatMeta, withRepeatMeta } from "./repeat-meta.ts";
import { readTaskLink, taskWaiting, type TaskLink } from "./task-meta.ts";

export interface TaskRef {
  // Vault path of the file holding the box.
  readonly path: string;
  // Offset of the Task node in that file's body.
  readonly from: number;
  // Offset of the character to flip (" " <-> "x").
  readonly marker: number;
  readonly done: boolean;
  // Display-only: the item's first line, marker and reminder stamp stripped.
  readonly title: string;
  // When it wants bringing up again, read out of the same line. Null is the
  // ordinary case; nothing is stored anywhere else.
  readonly remindAt: number | null;
  // Whether the reminder asked for a clock alarm as well as a notification.
  readonly alarm: boolean;
  // How often it comes back — "day", "mon,wed,fri" — or null for a one-off.
  readonly repeat: string | null;
  // Future occurrence already reserved by a completed, still-visible row.
  readonly nextRepeatAt?: number;
  // Where the title starts in the file, so a reminder can be written back
  // without rescanning. Same bargain as `marker`: good for one paint.
  readonly titleFrom: number;
  readonly titleTo: number;
  readonly link?: TaskLink;
  readonly invalidLink?: boolean;
}

// Every task in one file. Identity is (path, from), good only for the paint
// that computed it: offsets die on the next keystroke, so refs are scanned,
// rendered and proposed within one pass and never stored.
export const tasksIn = (body: string, path: string): TaskRef[] => {
  const refs: TaskRef[] = [];
  const tree = markdownLanguage.parser.parse(body);
  tree.iterate({
    enter: (node) => {
      if (node.name !== "Task") return;
      let marker = node.node.firstChild;
      while (marker !== null && marker.name !== "TaskMarker") {
        marker = marker.nextSibling;
      }
      if (marker === null) return;
      // The grammar guarantees "[x]": bracket, mark, bracket. decorate.ts
      // reads the same middle character to decide done.
      const at = marker.from + 1;
      let end = body.indexOf("\n", marker.to);
      if (end === -1) end = body.length;
      const raw = body.slice(marker.to, end);
      const link = readTaskLink(raw);
      const stamp = reminderIn(raw), repeat = repeatIn(raw), completion = readRepeatMeta(raw);
      const nextAt = completion ? reminderIn(completion.next) : null;
      const pending = completion && stamp !== null && completion.stamp === stampOf(stamp) && completion.repeat === repeat && nextAt !== null && nextAt > stamp;
      refs.push({
        path,
        from: node.from,
        marker: at,
        done: body[at] !== " ",
        title: titleWithout(raw),
        remindAt: reminderIn(raw),
        alarm: alarmWanted(raw),
        repeat,
        ...(pending ? { nextRepeatAt: nextAt as number } : {}),
        titleFrom: marker.to,
        titleTo: end,
        ...(link === undefined ? (raw.includes("<!-- notes-task") ? { invalidLink: true } : {}) : { link }),
      });
    },
  });
  return refs;
};

// Every note holding at least one box: open work first, done-only notes
// last, alphabetical inside each band. Dump days are ordinary files here —
// no composing, no sections: each day's stored body scans and flips on its
// own, so the toggle never touches the editor's composite document. Trash,
// archive and tombstones are not triage: ticking a box in a deleted file is
// editing nowhere, and dot-paths would sort above everything live.
export const tasksInVault = (
  notes: ReadonlyMap<string, Note>,
  cache: TaskCache,
): { path: string; refs: TaskRef[] }[] => {
  const groups: { path: string; refs: TaskRef[] }[] = [];
  for (const [path, note] of notes) {
    if (note.deleted || isTrashPath(path) || isArchivePath(path)) continue;
    const refs = cache.forNote(path, note.body);
    if (refs.length > 0) groups.push({ path, refs });
  }
  const open = (g: { refs: TaskRef[] }): number =>
    g.refs.some((r) => !r.done) ? 0 : 1;
  groups.sort(
    (a, b) => open(a) - open(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return groups;
};

// Flip one box. The bracket guard is the whole race policy: a ref scanned
// before an unpainted edit no longer points at brackets, so the flip refuses
// and the edited proposal arrives a no-change, which present() already
// answers with null. A double tap therefore cannot flap.
export const flipTask = (body: string, ref: TaskRef): string => {
  if (!ref.done && taskWaiting(ref)) return body;
  if (body[ref.marker - 1] !== "[" || body[ref.marker + 1] !== "]") return body;
  const next = body[ref.marker] === " " ? "x" : " ";
  return body.slice(0, ref.marker) + next + body.slice(ref.marker + 1);
};

// Set, move or clear one task's reminder. The same bargain as flipTask: the
// slice is checked against what was scanned, so a ref taken before an unpainted
// edit refuses rather than writing over whatever is there now.
export const setReminder = (
  body: string,
  ref: TaskRef,
  at: number | null,
  alarm = false,
): string => {
  const raw = body.slice(ref.titleFrom, ref.titleTo);
  // The same bargain as flipTask: a ref scanned before an unpainted edit no
  // longer describes what is at those offsets, and must refuse rather than
  // write over whatever is there now. Compared through the same reading that
  // produced the ref, because the raw slice carries whitespace the title does
  // not.
  if (titleWithout(raw) !== ref.title || reminderIn(raw) !== ref.remindAt) return body;
  const lead = /^\s*/.exec(raw)?.[0] ?? "";
  // No guard needed on clearing: withReminder returns the bare title before it
  // looks at the alarm, so an alarm cannot outlive the reminder it was on.
  const next = withReminder(raw.trim(), at, alarm);
  return body.slice(0, ref.titleFrom) + lead + next + body.slice(ref.titleTo);
};

// Scheduling uses the next occurrence while the completed row stays checked.
// Both web/native notifications and the dependency graph use this projection.
export const scheduledTask = (ref: TaskRef): TaskRef => ref.done && ref.nextRepeatAt !== undefined
  ? { ...ref, done: false, remindAt: ref.nextRepeatAt } : ref;

const replaceRepeat = (body: string, ref: TaskRef, completion: Parameters<typeof withRepeatMeta>[1]): string =>
  body.slice(0, ref.titleFrom) + withRepeatMeta(body.slice(ref.titleFrom, ref.titleTo), completion) + body.slice(ref.titleTo);

export const completeRepeat = (body: string, ref: TaskRef, completedAt: number): string => {
  const ticked = ref.done ? body : flipTask(body, ref);
  if (ref.repeat === null || ref.remindAt === null || ref.link?.after) return ticked;
  const end = new Date(completedAt); end.setHours(23, 59, 59, 999);
  const next = nextOccurrence(ref.remindAt, ref.repeat, end.getTime());
  return next === null ? ticked : replaceRepeat(ticked, ref, {
    stamp: stampOf(ref.remindAt), repeat: ref.repeat, next: stampOf(next),
  });
};

// Used for day rollover and an alarm answer for the reserved next occurrence.
export const reopenRepeat = (body: string, ref: TaskRef, at: number): string => {
  const clean = replaceRepeat(body, ref, null);
  const current = tasksIn(clean, ref.path).find(r => r.from === ref.from);
  if (!current) return body;
  return setReminder(current.done ? flipTask(clean, current) : clean, current, at, current.alarm);
};

// Last offset first. Daily completions stay checked until the next local day;
// weekly/monthly completions wait for their next scheduled day. Missed dates
// stay as one overdue occurrence, never a backlog or an immediate reset.
export const rollRepeats = (body: string, path: string, now: number): string => {
  let next = body;
  for (const ref of tasksIn(body, path).reverse()) {
    if (ref.nextRepeatAt !== undefined && !ref.done) { next = replaceRepeat(next, ref, null); continue; }
    if (!ref.done || ref.repeat === null || ref.remindAt === null || ref.link?.after) continue;
    if (ref.nextRepeatAt === undefined) { next = completeRepeat(next, ref, now); continue; }
    const reopen = new Date(ref.nextRepeatAt); reopen.setHours(0, 0, 0, 0);
    if (now < reopen.getTime()) continue;
    // Keep the reserved stamp even after a long absence. A queued native Done
    // for that occurrence must still match when the WebView returns. There is
    // still only one row; its next completion skips the missed days.
    next = reopenRepeat(next, ref, ref.nextRepeatAt);
  }
  return next;
};

export interface TaskCache {
  readonly forNote: (path: string, body: string) => TaskRef[];
}

// Paints happen per keystroke while bodies are immutable strings, so per-path
// identity is the entire invalidation protocol. The vault bounds the map.
export const createTaskCache = (): TaskCache => {
  const notes = new Map<string, { body: string; refs: TaskRef[] }>();
  return {
    forNote: (path, body) => {
      const hit = notes.get(path);
      if (hit !== undefined && hit.body === body) return hit.refs;
      const refs = tasksIn(body, path);
      notes.set(path, { body, refs });
      return refs;
    },
  };
};
