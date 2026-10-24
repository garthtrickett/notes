// Task ordering and recurrence live here, not in click handlers. All callers
// (editor, Tasks, sync, and queued Android answers) use the same Markdown.
import { tasksIn, scheduledTask, type TaskRef } from "./tasks.ts";
import { isFiledPath } from "./paths.ts";
import { withReminder } from "./reminders.ts";
import { withTaskLink, type TaskLink } from "./task-meta.ts";
import { err, ok, type Result } from "./result.ts";

type TaskNote = { readonly path: string; readonly body: string; readonly deleted: boolean; readonly encoding: string };
export const taskRefs = (notes: Iterable<TaskNote>): TaskRef[] => [...notes]
  .filter(n => !n.deleted && n.encoding === "utf8" && !isFiledPath(n.path))
  .flatMap(n => tasksIn(n.body, n.path));
export const taskChoice = (ref: TaskRef): string => JSON.stringify([ref.path, ref.from, ref.title]);

export const dependencyProblem = (ref: TaskRef, refs: readonly TaskRef[]): string | null => {
  if (ref.invalidLink) return "Task link could not be read";
  if (!ref.link) return null;
  if (ref.link.after && ref.repeat !== null) return "A follow-up uses its predecessor’s repeat";
  const seen = new Set<string>();
  let id: string | undefined = ref.link.id;
  while (id !== undefined) {
    if (seen.has(id)) return "Circular task dependency";
    seen.add(id);
    const found = refs.filter(r => r.link?.id === id);
    if (found.length === 0) return "Predecessor missing or archived";
    if (found.length !== 1) return "Duplicate task link; resolve the copied task";
    id = found[0]!.link?.after;
  }
  return null;
};
export const guardedTasks = (refs: readonly TaskRef[]): TaskRef[] => refs.map(ref =>
  dependencyProblem(ref, refs) === null ? ref : { ...ref, invalidLink: true });

const rewrite = (body: string, ref: TaskRef, link: TaskLink, readyAt?: number): string => {
  let raw = body.slice(ref.titleFrom, ref.titleTo);
  if (readyAt !== undefined) raw = withReminder(raw, link.alarm ? readyAt : null, link.alarm);
  const lead = /^\s*/.exec(raw)?.[0] || " ";
  const result = body.slice(0, ref.titleFrom) + lead + withTaskLink(raw.trim(), link) + body.slice(ref.titleTo);
  // Activation reopens a finished follow-up; it never marks it done.
  return readyAt === undefined ? result : result.slice(0, ref.marker) + " " + result.slice(ref.marker + 1);
};

export const linkTask = (
  notes: Iterable<TaskNote>, target: TaskRef, predecessorChoice: string, alarm: boolean,
  newId: () => string = () => crypto.randomUUID(),
): Result<Map<string, string>, string> => {
  const all = [...notes], refs = taskRefs(all);
  const current = refs.find(r => taskChoice(r) === taskChoice(target));
  const predecessor = refs.find(r => taskChoice(r) === predecessorChoice);
  if (!current || !predecessor || predecessor.done) return err("That task changed. Choose an unfinished predecessor again.");
  if (taskChoice(current) === taskChoice(predecessor)) return err("A task cannot follow itself.");
  if (dependencyProblem(predecessor, refs)) return err("Fix the predecessor’s task link first.");
  const source = predecessor.link ?? { id: newId() };
  const link: TaskLink = { id: current.link?.id ?? newId(), after: source.id, alarm, ready: false,
    ...(source.completed ? { seen: source.completed } : {}) };
  // Check prospective cycles too; relevant when changing an existing link.
  const prospective = refs.map(r => r === current ? { ...r, link } : r === predecessor ? { ...r, link: source } : r);
  if (dependencyProblem({ ...current, link }, prospective)) return err("That would create a circular or ambiguous task dependency.");
  const edits = new Map<string, string>();
  // Last offset first when both live in the same note.
  const replacements: [TaskRef, TaskLink][] = [[predecessor, source], [current, link]];
  for (const [ref, meta] of replacements.sort((a, b) => b[0].from - a[0].from)) {
    const body = edits.get(ref.path) ?? all.find(n => n.path === ref.path)!.body;
    edits.set(ref.path, rewrite(body, ref, meta));
  }
  return ok(edits);
};

// A timestamp identifies a repeating occurrence, not the time the app happened
// to notice the tick. Thus two devices observing the same tick release once.
export const completionToken = (ref: TaskRef): string => ref.link?.after
  ? ref.link.seen ?? "once" : ref.repeat !== null && ref.remindAt !== null ? `at:${ref.remindAt}` : ref.link?.round ? `once:${ref.link.round}` : "once";
export const nextTaskMinute = (now: number): number => (Math.floor(now / 60_000) + 1) * 60_000;

export const advanceTaskLinks = (notes: Iterable<TaskNote>, now: number, scanned?: readonly TaskRef[]): Map<string, string> => {
  const all = [...notes], edits = new Map<string, string>();
  const currentNotes = () => all.map(n => ({ ...n, body: edits.get(n.path) ?? n.body }));
  const initial = scanned ?? taskRefs(all);
  if (!initial.some(r => r.link)) return edits;
  // Record completions before calendar repeats reopen. Iteration reparses after
  // edits so a metadata write never invalidates another task's offsets.
  for (const original of initial) {
    if (original.link?.completed && !original.done && original.repeat === null && !original.link.after && !dependencyProblem(original, initial)) {
      const ref = taskRefs(currentNotes()).find(r => r.link?.id === original.link!.id)!;
      const body = edits.get(ref.path) ?? all.find(n => n.path === ref.path)!.body;
      const { completed: _completed, ...link } = ref.link!;
      edits.set(ref.path, rewrite(body, ref, { ...link, round: (link.round ?? 0) + 1 }));
      continue;
    }
    if (!original.link || !original.done || dependencyProblem(original, initial)) continue;
    if (original.link.after && !original.link.ready) continue;
    const token = completionToken(original);
    if (original.link.completed === token) continue;
    const ref = taskRefs(currentNotes()).find(r => r.link?.id === original.link!.id)!;
    const body = edits.get(ref.path) ?? all.find(n => n.path === ref.path)!.body;
    edits.set(ref.path, rewrite(body, ref, { ...ref.link!, completed: token }));
  }
  const refs = edits.size > 0 ? taskRefs(currentNotes()) : initial;
  for (const original of refs) {
    const meta = original.link;
    if (!meta?.after || dependencyProblem(original, refs)) continue;
    const parent = refs.find(r => r.link?.id === meta.after)!;
    const token = parent.link?.completed;
    if (!token || token === meta.seen) continue;
    const ref = taskRefs(currentNotes()).find(r => r.link?.id === meta.id)!;
    const body = edits.get(ref.path) ?? all.find(n => n.path === ref.path)!.body;
    // An unfinished follow-up remains one task even if the predecessor is
    // completed again. Consume the occurrence without moving its reminder.
    const active = meta.ready && !original.done;
    const updated = { ...meta, seen: token, ready: true };
    edits.set(ref.path, rewrite(body, ref, updated, active ? undefined : nextTaskMinute(now)));
  }
  return edits;
};

// Android records this before ringing a follow-up with the app closed. Replaying
// an old activation cannot reopen a task the user has already finished.
export const activateTask = (body: string, path: string, taskId: string, sourceId: string, token: string, at: number, title: string): string => {
  const matches = tasksIn(body, path).filter(r => r.link?.id === taskId);
  if (matches.length !== 1) return body;
  const ref = matches[0]!, meta = ref.link!;
  if (meta.after !== sourceId || meta.seen === token || ref.title !== title) return body;
  if (meta.seen?.startsWith("at:") && token.startsWith("at:") && Number(token.slice(3)) < Number(meta.seen.slice(3))) return body;
  return rewrite(body, ref, { ...meta, seen: token, ready: true }, at);
};

export const nativeTaskLinks = (refs: readonly TaskRef[]) => guardedTasks(refs)
  .filter(r => r.link && !r.invalidLink)
  .map(scheduledTask)
  .map(r => ({ ...r.link!, title: r.title, path: r.path, done: r.done, stamp: r.remindAt ?? 0, repeat: r.repeat !== null }))
  .sort((a, b) => a.id.localeCompare(b.id));
