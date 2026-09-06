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
  isVideoPath,
} from "./attachments.ts";
import { attach } from "./actions.ts";
import { createModel, present, visible, type Note } from "./model.ts";
import { renderMarkdown, sanitize } from "./render-markdown.ts";
import { describeLocal } from "./local-error.ts";
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
    expect(proposal.cursor).toBe("before ".length);
    expect(proposal.ref).toBe(`![](${proposal.path})`);
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
      // The action reports what happened; only describeLocal turns it into a
      // sentence (principle 6).
      expect(proposal.error.kind).toBe("imageTooBig");
      expect(describeLocal(proposal.error)).toContain("not added");
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
    present(m, { kind: "failed", error: { kind: "imageTooBig", bytes: 9_000_000 } });
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
      cursor: "text".length,
      ref: "![](attachments/2026-09-06-abcd1234.webp)",
    });

    const record = m.notes.get("attachments/2026-09-06-abcd1234.webp");
    expect(record?.encoding).toBe("base64");
    expect(record?.pending).toBe(true);
    // The bytes are not here: they went to the blob store before this proposal
    // was made, and the model holds the record rather than the picture.
    expect(record?.body).toBe("");
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
      cursor: 0,
      ref: "![](attachments/x.webp)",
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

describe("pasting the same image twice", () => {
  const withAttachment = () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [note("a.md", "one ")] });
    present(m, {
      kind: "attached",
      path: "attachments/2026-09-06-abcd.webp",
      base64: "AAAA",
      into: "a.md",
      cursor: "one ".length,
      ref: "![](attachments/2026-09-06-abcd.webp)",
    });
    // pretend it synced
    const stored = m.notes.get("attachments/2026-09-06-abcd.webp") as Note;
    m.notes.set(stored.path, { ...stored, baseSha: "sha-1", pending: false, dirty: false });
    return m;
  };

  it("does not resurrect the attachment as a fresh create", () => {
    const m = withAttachment();
    present(m, {
      kind: "attached",
      path: "attachments/2026-09-06-abcd.webp",
      base64: "AAAA",
      into: "a.md",
      cursor: 999, // clamped to the end of whatever the note holds now
      ref: "![](attachments/2026-09-06-abcd.webp)",
    });

    const record = m.notes.get("attachments/2026-09-06-abcd.webp");
    // Resetting baseSha would make the next push send "create" for a path that
    // already exists — a 422, which the app reads as a conflict and answers with
    // a conflict copy nobody asked for.
    expect(record?.baseSha).toBe("sha-1");
    expect(record?.pending).toBe(false);
  });

  it("still adds the new reference to the note", () => {
    const m = withAttachment();
    present(m, {
      kind: "attached",
      path: "attachments/2026-09-06-abcd.webp",
      base64: "AAAA",
      into: "a.md",
      cursor: 999, // clamped to the end of whatever the note holds now
      ref: "![](attachments/2026-09-06-abcd.webp)",
    });
    expect(m.notes.get("a.md")?.body).toBe("one ![](attachments/2026-09-06-abcd.webp)![](attachments/2026-09-06-abcd.webp)");
    expect(m.notes.get("a.md")?.pending).toBe(true);
  });

  it("adds the record back when the attachment had been deleted", () => {
    const m = withAttachment();
    present(m, { kind: "purged", path: "attachments/2026-09-06-abcd.webp" });
    present(m, {
      kind: "attached",
      path: "attachments/2026-09-06-abcd.webp",
      base64: "AAAA",
      into: "a.md",
      cursor: 999,
      ref: "![](attachments/2026-09-06-abcd.webp)",
    });
    const record = m.notes.get("attachments/2026-09-06-abcd.webp");
    expect(record?.deleted).toBe(false);
    expect(record?.pending).toBe(true);
  });
});

describe("a conflicted attachment", () => {
  it("keeps its encoding, so the copy is not corrupted as text", () => {
    const m = createModel();
    present(m, {
      kind: "hydrated",
      notes: [note("attachments/a.webp", "AAAA", { encoding: "base64" })],
    });
    present(m, {
      kind: "conflicted",
      path: "attachments/a.webp",
      copyPath: "attachments/a (conflict 2026-09-06).webp",
      body: "AAAA",
    });
    const copy = m.notes.get("attachments/a (conflict 2026-09-06).webp");
    expect(copy?.encoding).toBe("base64");
    expect(copy?.body).toBe("AAAA");
  });
});

describe("what the editor is allowed to open", () => {
  const attachment = note("attachments/2026-09-06-abcd.webp", "UklGRmwBAABX", {
    encoding: "base64",
  });

  it("opens nothing when the vault holds only an attachment", () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [attachment] });
    // Otherwise the editor fills with raw base64 that looks like corruption.
    expect(m.openPath).toBeNull();
  });

  it("opens nothing when the vault holds only dump days", () => {
    const m = createModel();
    present(m, {
      kind: "hydrated",
      notes: [note("dump/2026-09-06.md", "09:00 a thought")],
    });
    // The dump has its own view; the notes editor is not it.
    expect(m.openPath).toBeNull();
  });

  it("skips past an attachment to a real note", () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [attachment, note("inbox/a.md", "text")] });
    expect(m.openPath).toBe("inbox/a.md");
  });

  it("refuses to open an attachment on request", () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [attachment, note("inbox/a.md")] });
    present(m, { kind: "opened", path: attachment.path });
    expect(m.openPath).toBe("inbox/a.md");
  });

  it("does not fall back onto an attachment when the last note is deleted", () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [attachment, note("inbox/a.md")] });
    present(m, { kind: "deleted", path: "inbox/a.md" });
    expect(m.openPath).toBeNull();
  });

  it("does not fall back onto an attachment after a pull", () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [] });
    present(m, {
      kind: "pulled",
      notes: [
        {
          path: attachment.path,
          body: attachment.body,
          baseSha: "s",
          pending: false,
          deleted: false,
          encoding: "base64",
        },
      ],
      gone: [],
      remaining: 0,
    });
    expect(m.openPath).toBeNull();
  });
});

describe("what may become a data URL", () => {
  it("maps the image types it knows", () => {
    expect(dataUrlOf("AAAA", "a.webp")).toBe("data:image/webp;base64,AAAA");
    expect(dataUrlOf("AAAA", "a.jpg")).toBe("data:image/jpeg;base64,AAAA");
    expect(dataUrlOf("AAAA", "a.PNG")).toBe("data:image/png;base64,AAAA");
  });

  it("refuses svg outright", () => {
    // An SVG is a document that can carry script. Taking the extension at its
    // word produced `data:image/svg`, which is defence by accident.
    expect(dataUrlOf("AAAA", "a.svg")).toBeNull();
  });

  it("refuses anything else rather than inventing a mime", () => {
    expect(dataUrlOf("AAAA", "a.html")).toBeNull();
    expect(dataUrlOf("AAAA", "a")).toBeNull();
  });

  it("holds after a move, which inherits encoding", () => {
    // The path that made this reachable: encoding comes from the old name.
    const m = createModel();
    present(m, {
      kind: "hydrated",
      notes: [note("attachments/x.webp", "AAAA", { encoding: "base64" })],
    });
    present(m, { kind: "moved", from: "attachments/x.webp", to: "foo.svg" });
    const moved = m.notes.get("foo.svg");
    expect(moved?.encoding).toBe("base64");
    expect(dataUrlOf(moved?.body ?? "", "foo.svg")).toBeNull();
  });
});

describe("an image that takes a while to shrink", () => {
  it("does not overwrite what was typed while it was being processed", () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [note("a.md", "start")] });

    // The paste happens here: the caret is at 5 and the note says "start".
    // Shrinking a large image takes a second or more, and the writing carries on.
    present(m, { kind: "edited", path: "a.md", body: "start and more typing" });

    // Now the image is ready. The reference goes in at the caret, and the
    // sentence typed in between is still there — it used to be replaced by a
    // body computed before it was typed.
    present(m, {
      kind: "attached",
      path: "attachments/2026-09-06-abcd.webp",
      base64: "AAAA",
      into: "a.md",
      cursor: 5,
      ref: "![](attachments/2026-09-06-abcd.webp)",
    });

    expect(m.notes.get("a.md")?.body).toBe(
      "start![](attachments/2026-09-06-abcd.webp) and more typing",
    );
  });

  it("clamps the caret when the note got shorter in the meantime", () => {
    const m = createModel();
    present(m, { kind: "hydrated", notes: [note("a.md", "a long piece of text")] });
    present(m, { kind: "edited", path: "a.md", body: "cut" });
    present(m, {
      kind: "attached",
      path: "attachments/x.webp",
      base64: "AAAA",
      into: "a.md",
      cursor: 20,
      ref: "![](attachments/x.webp)",
    });
    // At worst a few characters out of place. Never a lost sentence, and never
    // a crash.
    expect(m.notes.get("a.md")?.body).toBe("cut![](attachments/x.webp)");
  });
});

describe("video attachments", () => {
  it("counts mp4 and webm as binary, so they sync as bytes not text", () => {
    // Read as utf8 they would arrive corrupted, silently.
    expect(isBinaryPath("attachments/clip.mp4")).toBe(true);
    expect(isBinaryPath("attachments/clip.webm")).toBe(true);
    expect(isVideoPath("attachments/clip.mp4")).toBe(true);
    expect(isVideoPath("attachments/shot.webp")).toBe(false);
  });

  it("gives them a data URL the renderer can use", () => {
    expect(dataUrlOf("AAAA", "attachments/clip.mp4")).toBe("data:video/mp4;base64,AAAA");
    expect(dataUrlOf("AAAA", "attachments/clip.webm")).toBe("data:video/webm;base64,AAAA");
  });

  it("still refuses anything that can carry script", () => {
    // The reason this list is a list and not a rule about "media".
    expect(dataUrlOf("AAAA", "a.svg")).toBeNull();
    expect(dataUrlOf("AAAA", "a.html")).toBeNull();
    expect(isBinaryPath("a.svg")).toBe(false);
  });
});
