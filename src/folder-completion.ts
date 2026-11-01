// Folders are inferred from note paths, just like the tree. Complete only the
// current level so accepting a suggestion never skips past a choice.
export interface NotePathDraft {
  readonly path: string;
  readonly index: number;
}

export const emptyNotePath: NotePathDraft = { path: "", index: 0 };

export const folderCompletions = (paths: Iterable<string>, raw: string): string[] => {
  const prefix = raw.trimStart().replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  const depth = prefix.split("/").length - 1;
  const folders = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    if (parts.length <= depth + 1) continue;
    const folder = `${parts.slice(0, depth + 1).join("/")}/`;
    if (folder.toLowerCase().startsWith(prefix.toLowerCase())) folders.add(folder);
  }
  return [...folders].sort((a, b) => a.localeCompare(b));
};
