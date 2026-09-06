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
