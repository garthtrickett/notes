// The form is a writer for the existing task syntax, not a second task store.
import { reminderIn, stampOf } from "./reminders.ts";
import { err, ok, type Result } from "./result.ts";

export interface TaskDraft {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly date: string;
  readonly time: string;
  readonly alarm: boolean;
  readonly repeat: string;
  readonly after?: string;
}

export const emptyTaskDraft: TaskDraft = {
  path: "reminders.md", title: "", description: "", date: "", time: "09:00", alarm: false, repeat: "", after: "",
};

export const TASK_REPEATS = [
  ["", "Does not repeat"], ["day", "Every day"], ["weekday", "Every weekday"],
  ["week", "Every week"], ["month", "Every month"], ["year", "Every year"],
] as const;

export const taskMarkdown = (draft: TaskDraft): Result<string, string> => {
  const title = draft.title.trim();
  if (title === "") return err("Give the task a title.");
  if (/[\r\n]/.test(title)) return err("Keep the title on one line; use Description for details.");
  if (reminderIn(title) !== null) return err("Use the due date fields instead of an @date in the title.");
  if (/<!--\s*notes-task/.test(title) || /<!--\s*notes-task/.test(draft.description)) return err("Use the task controls to set task links.");
  if (draft.after && (draft.date !== "" || draft.repeat !== "")) return err("A follow-up uses its predecessor’s completion instead of a due date or repeat.");
  let stamp = "";
  if (draft.date === "") {
    if ((draft.alarm && !draft.after) || draft.repeat !== "") return err("Choose a due date for an alarm or repeating task.");
  } else {
    const time = draft.time || "09:00";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date) || !/^\d{2}:\d{2}$/.test(time)) {
      return err("Choose a valid due date and time.");
    }
    const at = new Date(`${draft.date}T${time}:00`);
    // Date silently rolls invalid days and daylight-saving gaps forward.
    const two = (n: number) => String(n).padStart(2, "0");
    const actual = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`;
    if (Number.isNaN(at.getTime()) || actual !== `${draft.date}T${time}`) {
      return err("That date or time does not exist. Choose another.");
    }
    if (!TASK_REPEATS.some(([rule]) => rule === draft.repeat)) return err("Choose a repeat option from the list.");
    stamp = ` ${stampOf(at.getTime(), draft.alarm)}`;
    if (draft.repeat !== "") stamp += ` every ${draft.repeat}`;
  }
  const description = draft.description.replace(/\r\n?/g, "\n").trim();
  const details = description === "" ? "" : "\n" + description.split("\n").map((line) => `    ${line}`).join("\n");
  return ok(`- [ ] ${title}${stamp}${details}\n`);
};
