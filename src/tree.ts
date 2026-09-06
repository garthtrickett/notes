// Folders are path prefixes, so the tree is derived on render rather than
// stored. Nothing in the model knows what a folder is, which is why nesting is
// free to any depth.

import type { Note } from "./model.ts";

export type TreeNode =
  | {
      readonly kind: "folder";
      readonly name: string;
      readonly path: string;
      readonly children: readonly TreeNode[];
    }
  | { readonly kind: "note"; readonly name: string; readonly note: Note };

interface Building {
  readonly folders: Map<string, Building>;
  readonly notes: Note[];
}

const emptyBuilding = (): Building => ({ folders: new Map(), notes: [] });

const finish = (node: Building, prefix: string): TreeNode[] => {
  const folders: TreeNode[] = [...node.folders.entries()]
    .map(([name, child]) => {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      return {
        kind: "folder" as const,
        name,
        path,
        children: finish(child, path),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const notes: TreeNode[] = node.notes
    .map((note) => ({
      kind: "note" as const,
      name: note.path.slice(note.path.lastIndexOf("/") + 1),
      note,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Folders first, then notes. Both alphabetical.
  return [...folders, ...notes];
};

export const buildTree = (notes: readonly Note[]): TreeNode[] => {
  const root = emptyBuilding();

  for (const note of notes) {
    const segments = note.path.split("/").filter((s) => s !== "");
    if (segments.length === 0) continue;

    let cursor = root;
    // Every segment but the last is a folder.
    for (const segment of segments.slice(0, -1)) {
      let next = cursor.folders.get(segment);
      if (!next) {
        next = emptyBuilding();
        cursor.folders.set(segment, next);
      }
      cursor = next;
    }
    cursor.notes.push(note);
  }

  return finish(root, "");
};
