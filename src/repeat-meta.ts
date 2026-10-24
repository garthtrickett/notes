// A completed occurrence keeps its actual checkbox ticked. This small suffix
// carries the next local-time alarm through sync/reload, without another store.
import { stripTaskMeta, taskMetaSuffix } from "./task-meta.ts";
export interface RepeatCompletion { readonly stamp: string; readonly repeat: string; readonly next: string }
const META = /\s*<!-- notes-repeat (\{[^\r\n]*?\}) -->(?=\s*(?:<!-- notes-task \{[^\r\n]*?\} -->)?\s*$)/;
export const stripRepeatMeta = (raw: string): string => raw.replace(META, "");
export const readRepeatMeta = (raw: string): RepeatCompletion | undefined => {
  const match = META.exec(raw); if (!match) return undefined;
  try {
    const value: unknown = JSON.parse(match[1]!);
    if (typeof value !== "object" || value === null) return undefined;
    const v = value as Record<string, unknown>;
    if (typeof v.stamp !== "string" || typeof v.next !== "string" || typeof v.repeat !== "string") return undefined;
    if (![v.stamp, v.next].every(s => /^@\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?$/.test(s))) return undefined;
    return { stamp: v.stamp, repeat: v.repeat, next: v.next };
  } catch { return undefined; }
};
export const withRepeatMeta = (raw: string, completion: RepeatCompletion | null): string => {
  const task = taskMetaSuffix(raw), bare = stripRepeatMeta(stripTaskMeta(raw)).trimEnd();
  return bare + (completion ? ` <!-- notes-repeat ${JSON.stringify(completion)} -->` : "") + (task ? ` ${task}` : "");
};
