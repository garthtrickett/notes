import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  attachmentPath,
  base64Of,
  dataUrlOf,
  insertAt,
  isAttachmentPath,
  isBinaryPath,
  MAX_BYTES,
  shortHash,
} from "./attachments.ts";
import { attach } from "./actions.ts";
import { createModel, present, visible, type Note } from "./model.ts";
import { renderMarkdown, sanitize } from "./render-markdown.ts";
import { getAll, openDb, putMany } from "./idb.ts";

const NOON = new Date("2026-09-06T14:32:00").getTime();

const note = (path: string, body = "", extra: Partial<Note> = {}): Note => ({
  path,
  body,
  baseSha: "sha-0",
  pending: false,
  deleted: false,
  dirty: false,
  encoding: "utf8",
  ...extra,
});

const bytes = (n: number, fill = 7): ArrayBuffer =>
  new Uint8Array(n).fill(fill).buffer;

describe("naming", () => {
  it("gives identical bytes the same path, so a repeat paste is one file", async () => {
    const a = attachmentPath(NOON, await shortHash(bytes(64)));
    const b = attachmentPath(NOON, await shortHash(bytes(64)));
    expect(a).toBe(b);
    expect(a).toMatch(/^attachments\/2026-09-06-[0-9a-f]{8}\.webp$/);
  });

  it("gives different bytes a different path", async () => {
    const a = await shortHash(bytes(64, 1));
    const b = await shortHash(bytes(64, 2));
    expect(a).not.toBe(b);
  });

  it("dates the file so it sorts", async () => {
    const later = new Date("2026-09-07T09:00:00").getTime();
    expect(attachmentPath(later, "abcd1234")).toContain("2026-09-07");
  });
});

describe("classification", () => {
  it("recognises images by extension, wherever they sit", () => {
    expect(isBinaryPath("attachments/a.webp")).toBe(true);
    expect(isBinaryPath("inbox/photo.PNG")).toBe(true);
    expect(isBinaryPath("inbox/a.md")).toBe(false);
  });

  it("treats anything under attachments as one", () => {
    expect(isAttachmentPath("attachments/whatever")).toBe(true);
    expect(isAttachmentPath("inbox/a.md")).toBe(false);
  });
});

describe("attach", () => {
  const host = note("inbox/a.md", "before after");

  it("adds the record and drops a reference at the cursor", async () => {
    const proposal = await attach(
      new Blob(["x"]),
      host,
      "before ".length,
      () => NOON,
      async () => bytes(128),
    );
    if (proposal.kind !== "attached") throw new Error(proposal.kind);
    expect(proposal.into).toBe("inbox/a.md");
    expect(proposal.body).toBe(`before ![](${proposal.path})after`);
    expect(proposal.base64).toBe(base64Of(bytes(128)));
  });

  it("refuses an image still too big after resizing", async () => {
    const proposal = await attach(
      new Blob(["x"]),
      host,
      0,
      () => NOON,
      async () => bytes(MAX_BYTES + 1),
    );
    // Git keeps binaries forever, so this has to fail before it is committed.
    expect(proposal.kind).toBe("failed");
    if (proposal.kind === "failed") {
      expect(proposal.message).toContain("not added");
    }
  });

  it("reports a resize that throws instead of losing the paste silently", async () => {
    const proposal = await attach(
      new Blob(["x"]),
      host,
      0,
      () => NOON,
      async () => {
        throw new Error("no canvas");
      },
    );
    expect(proposal.kind).toBe("failed");
  });

  it("adds nothing to the model when it is refused", () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [host] });
    present(m, { kind: "failed", message: "too big" });
    expect(m.notes.size).toBe(1);
  });
});

describe("the attached proposal", () => {
  it("lands the bytes and the reference together", () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [note("inbox/a.md", "text")] });
    present(m, {
      kind: "attached",
      path: "attachments/2026-09-06-abcd1234.webp",
      base64: "AAAA",
      into: "inbox/a.md",
      body: "text![](attachments/2026-09-06-abcd1234.webp)",
    });

    const record = m.notes.get("attachments/2026-09-06-abcd1234.webp");
    expect(record?.encoding).toBe("base64");
    expect(record?.body).toBe("AAAA");
    expect(record?.pending).toBe(true);
    // A note must never point at an attachment that was not added.
    expect(m.notes.get("inbox/a.md")?.body).toContain("![](attachments/");
    expect(m.notes.get("inbox/a.md")?.pending).toBe(true);
  });

  it("is rejected when the host note is gone", () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [] });
    present(m, {
      kind: "attached",
      path: "attachments/x.webp",
      base64: "AAAA",
      into: "ghost.md",
      body: "x",
    });
    expect(m.notes.size).toBe(0);
  });

  it("keeps attachments out of the visible note list", () => {
    const m = createModel();
    present(m, {
      kind: "hydrated",
      notes: [note("inbox/a.md"), note("attachments/x.webp", "AAAA", { encoding: "base64" })],
    });
    expect(visible(m).length).toBe(2); // still records...
    // ...but the view filters them, which is what isAttachmentPath is for.
    expect(visible(m).filter((n) => !isAttachmentPath(n.path)).map((n) => n.path)).toEqual([
      "inbox/a.md",
    ]);
  });
});

describe("storage", () => {
  let db: IDBDatabase | undefined;
  beforeEach(async () => {
    db?.close();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase("notes");
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
    db = await openDb();
  });
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("round-trips base64 unchanged", async () => {
    const payload = base64Of(bytes(4096, 200));
    await putMany(db as IDBDatabase, [
      {
        path: "attachments/a.webp",
        body: payload,
        baseSha: null,
        pending: true,
        deleted: false,
        encoding: "base64",
      },
    ]);
    const [stored] = await getAll(db as IDBDatabase);
    expect(stored?.body).toBe(payload);
    expect(stored?.encoding).toBe("base64");
  });
});

describe("rendering an attachment", () => {
  const resolve = (src: string) =>
    src === "attachments/a.webp" ? dataUrlOf("AAAA", "attachments/a.webp") : null;

  it("resolves a relative source to the local copy", () => {
    const fragment = renderMarkdown(
      "![](attachments/a.webp)",
      document,
      resolve,
    );
    const el = document.createElement("div");
    el.append(fragment);
    // Rendered from the device, so it works offline and in a private repo.
    expect(el.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/webp;base64,AAAA",
    );
  });

  it("leaves an unknown source visibly broken rather than dropping it", () => {
    const fragment = renderMarkdown("![](attachments/missing.webp)", document, resolve);
    const el = document.createElement("div");
    el.append(fragment);
    expect(el.querySelector("img")).not.toBeNull();
  });

  it("leaves an absolute source alone", () => {
    const fragment = renderMarkdown("![](https://example.com/x.png)", document, resolve);
    const el = document.createElement("div");
    el.append(fragment);
    expect(el.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/x.png",
    );
  });
});

describe("the sanitizer and data URLs", () => {
  const clean = (html: string): string => {
    const template = document.createElement("template");
    template.innerHTML = html;
    sanitize(template.content);
    return template.innerHTML;
  };

  it("permits a base64 image", () => {
    expect(clean('<img src="data:image/webp;base64,AAAA">')).toBe(
      '<img src="data:image/webp;base64,AAAA">',
    );
  });

  it("still refuses data:text/html, which is the reason not to allow data: wholesale", () => {
    expect(clean('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>')).toBe(
      "<a>x</a>",
    );
  });

  it("refuses a data URL in an href even for an image type", () => {
    expect(clean('<a href="data:image/webp;base64,AAAA">x</a>')).toBe("<a>x</a>");
  });
});

describe("insertAt", () => {
  it("inserts at the cursor", () => {
    expect(insertAt("ab", 1, "-X-")).toBe("a-X-b");
  });

  it("clamps a cursor past the end", () => {
    expect(insertAt("ab", 99, "!")).toBe("ab!");
  });
});
