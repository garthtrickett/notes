// What is a legal note path, and why a given one is not.
//
// Git has no notion of an empty directory: a folder exists only because files
// sit under it. So `inbox` and `inbox/a.md` cannot both exist — one name cannot
// be a file and a directory at once. The Contents API will happily accept the
// second write and leave the repo in a state the app then reads as a conflict,
// so the check belongs here, before anything is proposed.

export type PathProblem =
  | { readonly kind: "empty" }
  | { readonly kind: "exists" }
  | { readonly kind: "unsafe" }
  | { readonly kind: "isFolder"; readonly folder: string }
  | { readonly kind: "underFile"; readonly file: string };

// Trims, strips leading and duplicate slashes, and defaults the extension —
// typing `inbox/idea` should give you `inbox/idea.md`, not an extensionless file
// that later collides with a folder of the same name.
export const normalizePath = (raw: string): string => {
  const cleaned = raw
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
  if (cleaned === "") return "";
  const base = cleaned.slice(cleaned.lastIndexOf("/") + 1);
  return base.includes(".") ? cleaned : `${cleaned}.md`;
};

export const pathProblem = (
  path: string,
  existing: Iterable<string>,
): PathProblem | null => {
  if (path === "") return { kind: "empty" };

  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    return { kind: "unsafe" };
  }

  const paths = [...existing];
  if (paths.includes(path)) return { kind: "exists" };

  // The name is already a folder, because something lives under it.
  if (paths.some((p) => p.startsWith(`${path}/`))) {
    return { kind: "isFolder", folder: path };
  }

  // A parent of the new path is already a file.
  for (let i = 1; i < segments.length; i += 1) {
    const parent = segments.slice(0, i).join("/");
    if (paths.includes(parent)) return { kind: "underFile", file: parent };
  }

  return null;
};

export const describeProblem = (
  problem: PathProblem,
  path: string,
): string => {
  switch (problem.kind) {
    case "empty":
      return "A note needs a name.";
    case "exists":
      return `${path} already exists.`;
    case "unsafe":
      return `${path} is not a usable path.`;
    case "isFolder":
      return `${problem.folder} is a folder, and git cannot have a file and a folder with the same name. Try ${problem.folder}/a-name.md.`;
    case "underFile":
      return `${problem.file} is a note, so nothing can live inside it. Rename that note first.`;
  }
};

// Two folders the note tree does not show. Deleting moves a note into `.trash/`
// and archiving into `.archive/`, which makes both of them renames — an
// operation this vault already has, with sync, conflict handling and tombstones
// already worked out. The alternative, a flag on the record, would have been a
// second kind of existence for the rest of the app to remember.
//
// They live in the vault, so a note deleted on the laptop is in the bin on the
// phone. A flag in IndexedDB would not have been.
export const TRASH = ".trash";
export const ARCHIVE = ".archive";

const isUnder = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(`${folder}/`);

export const isTrashPath = (path: string): boolean => isUnder(path, TRASH);
export const isArchivePath = (path: string): boolean => isUnder(path, ARCHIVE);
export const isFiledPath = (path: string): boolean =>
  isTrashPath(path) || isArchivePath(path);

// Filing keeps the whole original path, so restoring is the prefix removed and
// nothing has to be remembered anywhere.
export const filedPath = (folder: string, path: string): string =>
  `${folder}/${path}`;

export const unfiledPath = (path: string): string =>
  path.replace(/^\.(trash|archive)\//, "");

// Deleting the same note twice would otherwise collide in the bin, and the
// second delete would be refused for a reason that reads like a bug.
export const uniquePath = (
  path: string,
  taken: (candidate: string) => boolean,
): string => {
  if (!taken(path)) return path;
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const hasExt = dot > slash;
  const stem = hasExt ? path.slice(0, dot) : path;
  const ext = hasExt ? path.slice(dot) : "";
  for (let n = 2; n <= 999; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
};

