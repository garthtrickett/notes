// Only linked tasks need a durable identity. The Markdown remains the record;
// offsets still identify an ordinary checkbox within a single paint.
export interface TaskLink {
  readonly id: string;
  readonly after?: string;
  readonly alarm?: boolean;
  readonly ready?: boolean;
  readonly seen?: string;
  readonly completed?: string;
  readonly round?: number;
}
const META = /\s*<!-- notes-task (\{[^\r\n]*\}) -->\s*$/;
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const TOKEN = /^[a-zA-Z0-9:._-]{1,128}$/;
export const stripTaskMeta = (raw: string): string => raw.replace(META, "");
export const taskMetaSuffix = (raw: string): string => META.exec(raw)?.[0]?.trim() ?? "";
export const readTaskLink = (raw: string): TaskLink | undefined => {
  const match = META.exec(raw);
  if (!match) return undefined;
  try {
    const value: unknown = JSON.parse(match[1]!);
    if (!value || typeof value !== "object") return undefined;
    const v = value as Record<string, unknown>;
    if (typeof v.id !== "string" || !ID.test(v.id)) return undefined;
    if (v.after !== undefined && (typeof v.after !== "string" || !ID.test(v.after))) return undefined;
    for (const key of ["seen", "completed"]) if (v[key] !== undefined && (typeof v[key] !== "string" || !TOKEN.test(v[key] as string))) return undefined;
    for (const key of ["ready", "alarm"]) if (v[key] !== undefined && typeof v[key] !== "boolean") return undefined;
    if (v.round !== undefined && (typeof v.round !== "number" || !Number.isSafeInteger(v.round) || v.round < 0)) return undefined;
    return v as unknown as TaskLink;
  } catch { return undefined; }
};
export const withTaskLink = (raw: string, link: TaskLink): string =>
  `${stripTaskMeta(raw).trimEnd()} <!-- notes-task ${JSON.stringify(link)} -->`;
export const taskWaiting = (ref: { readonly link?: TaskLink; readonly invalidLink?: boolean }): boolean =>
  ref.invalidLink === true || (ref.link?.after !== undefined && ref.link.ready !== true);
