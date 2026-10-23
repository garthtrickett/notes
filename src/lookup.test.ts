import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendLookup, appendWidgetCapture, parseLookupCaptures, type LookupCapture } from "./lookup-capture.ts";
import { nativeLookupInbox, type LookupInbox } from "./lookup.ts";
import { boot, type Loop } from "./loop.ts";
import { deleteMany, getAll, getBlob, lookupImported, openDb, putMany, photoImportPath, LOOKUP_IMPORTS_STORE } from "./idb.ts";
import { createModel, present } from "./model.ts";
import { appendEntry } from "./dump.ts";

const capture: LookupCapture = { id: "12345678-1234-4123-8123-123456789abc", day: "2026-10-23", time: "03:15", text: "Why is the sky blue?" };
const path = "dump/2026-10-23.md";
const jot: LookupCapture = { ...capture, id: "aaaaaaaa-1234-4123-8123-123456789abc", kind: "jot", text: "Remember to pack my ID" };
describe("Jotted Down capture", () => {
  it("reuses Jotted Down separately from Lookup in either section order", () => {
    for (const base of [appendLookup("", capture), "10:00 A thought\n\n## Jotted Down\n\n- Existing jot\n\n## Lookup\n\n- Existing question\n"]) {
      const next = appendWidgetCapture(base, jot);
      const again = appendWidgetCapture(next, { ...jot, text: "A second thought" });
      expect(again.match(/^## Jotted Down$/gm)).toHaveLength(1);
      expect(again.match(/^## Lookup$/gm)).toHaveLength(1);
      expect(again).toContain("- 03:15 Remember to pack my ID");
      expect(again).toContain("A second thought");
      const section = again.slice(again.indexOf("## Jotted Down"));
      expect(section.indexOf(jot.text)).toBeGreaterThan(0);
      if (section.includes("## Lookup")) expect(section.indexOf(jot.text)).toBeLessThan(section.indexOf("## Lookup"));
    }
  });
  it("keeps ordinary captures outside either widget section and ignores fenced headings", () => {
    for (const base of [appendWidgetCapture("", jot), appendLookup(appendWidgetCapture("", jot), capture), appendWidgetCapture(appendLookup("", capture), jot)]) {
      expect(appendEntry(base, "An ordinary capture", Date.parse("2026-10-23T12:00:00"))).toStartWith("12:00 An ordinary capture\n\n## ");
    }
    const fenced = "```md\n## Jotted Down\n```\n\n## Other\nKeep this\n";
    const next = appendWidgetCapture(fenced, jot);
    expect(next).toStartWith(fenced.trimEnd());
    expect(next).toEndWith("## Jotted Down\n\n- 03:15 Remember to pack my ID\n");
    expect(appendWidgetCapture("An unfinished block\n```\n", jot)).toStartWith("An unfinished block\n\n## Jotted Down");
  });
  it("preserves the new kind through parsing while old captures stay Lookup and unknown kinds are rejected", () => {
    expect(parseLookupCaptures({ captures: [capture, jot] })).toEqual([capture, jot]);
    expect(parseLookupCaptures({ captures: [{ ...capture, kind: "lookup" }] })).toEqual([capture]);
    expect(() => parseLookupCaptures({ captures: [{ ...capture, kind: "elsewhere" }] })).toThrow();
    expect(appendWidgetCapture("", capture)).toBe(appendLookup("", capture));
  });
});
describe("Lookup capture", () => {
  it("adds a section to an empty day and reuses it for later questions", () => {
    const first = appendLookup("", capture);
    expect(first).toStartWith("## Lookup\n\n- 03:15 Why is the sky blue?");
    const second = appendLookup(first, { ...capture, id: "aaaaaaaa-1234-4123-8123-123456789abc", text: "Another question" });
    expect(second.match(/## Lookup/g)).toHaveLength(1);
    expect(second).toContain("Another question");
    expect(second).not.toContain(capture.id);
  });
  it("inserts before the next section and preserves surrounding notes", () => {
    const body = "10:00 An ordinary thought\n\n## Lookup\n\n- Existing question\n\n## Food\nLunch\n";
    const next = appendLookup(body, capture);
    expect(next).toStartWith("10:00 An ordinary thought\n\n## Lookup\n\n- Existing question\n");
    expect(next.indexOf(capture.text)).toBeLessThan(next.indexOf("## Food"));
    expect(next).toEndWith("## Food\nLunch\n");
  });
  it("ignores fenced headings and keeps multiline input inside one list entry", () => {
    const next = appendLookup("```md\n## Lookup\n```\n", { ...capture, text: "a\n## injected\n<!-- marker -->" });
    expect(next).toContain("```\n\n## Lookup\n");
    expect(next).toContain("a ## injected &lt;!-- marker --&gt;");
  });
  it("parses the native boundary and rejects malformed dates, duplicate IDs and oversized questions", async () => {
    expect(parseLookupCaptures({ captures: [capture] })).toEqual([capture]);
    for (const bad of [{ ...capture, day: "2026-02-31" }, { ...capture, id: "../../oops" }, { ...capture, time: "24:00" }, { ...capture, text: " " }, { ...capture, text: "x".repeat(2001) }])
      expect(() => parseLookupCaptures({ captures: [bad] })).toThrow();
    expect(() => parseLookupCaptures({ captures: [capture, capture] })).toThrow();
    expect(nativeLookupInbox().supported).toBe(false);
    expect(await nativeLookupInbox().pending()).toEqual([]);
  });
  it("keeps ordinary captures outside Lookup and unfinished code intact", () => {
    const body = appendLookup("", capture);
    expect(appendEntry(body, "A normal thought", Date.parse("2026-10-23T14:00:00"))).toStartWith("14:00 A normal thought\n\n## Lookup");
    const unfinished = "Original thought\n```md\n## Lookup\n";
    const added = appendLookup(unfinished, capture);
    expect(added).toEndWith("\n```md\n## Lookup\n");
    expect(added.indexOf(capture.text)).toBeLessThan(added.indexOf("```"));
  });
  it("keeps the original capture day, current editor, SHA and unsaved dump edits", () => {
    const model = createModel();
    present(model, { kind: "hydrated", notes: [{ path, body: "My current edits", baseSha: "sha", pending: true, deleted: false, dirty: true, encoding: "utf8" }] });
    model.mode = "notes"; model.openPath = "other.md";
    present(model, { kind: "lookupCaptured", capture });
    expect(model.notes.get(path)?.body).toStartWith("My current edits\n\n## Lookup");
    expect(model.notes.get(path)?.baseSha).toBe("sha");
    expect(model.notes.get(path)?.dirty).toBe(true);
    expect(model.openPath).toBe("other.md");
    expect(model.mode).toBe("notes");
  });
});

describe("durable widget delivery", () => {
  let db: IDBDatabase;
  let loop: Loop | undefined;
  beforeEach(async () => {
    await new Promise<void>(resolve => { const r = indexedDB.deleteDatabase("notes"); r.onsuccess = () => resolve(); });
    db = await openDb();
    document.body.innerHTML = '<div id="app"></div>';
  });
  afterEach(() => { loop?.dispose(); loop = undefined; db.close(); });
  const start = async (port: LookupInbox) => {
    loop = await boot({ db, lookupInbox: port, github: null, now: () => Date.parse("2026-10-25T12:00:00Z"),
      schedule: (_ms, fire) => void queueMicrotask(fire), shrink: file => file.arrayBuffer() }, document.getElementById("app")!);
    await loop.flush();
    return loop;
  };
  const inbox = () => {
    let waiting: readonly LookupCapture[] = [capture];
    let changed = () => {};
    let acks = 0;
    const port = { supported: true, pending: async () => waiting,
      acknowledge: async () => {
        expect(await lookupImported(db, capture.id)).toBe(true);
        expect((await getAll(db)).find(n => n.path === path)?.body).toContain(capture.text);
        acks++; waiting = [];
      }, listen: async (callback: () => void) => { changed = callback; return () => { changed = () => {}; }; } } satisfies LookupInbox;
    return { port, emit: () => changed(), set: (value: readonly LookupCapture[]) => { waiting = value; }, acks: () => acks };
  };
  it("cold-imports offline into the capture day and acknowledges only after ordinary durable persistence", async () => {
    const source = inbox();
    const loop = await start(source.port);
    expect(loop.model.notes.get(path)?.body).toContain("## Lookup");
    expect(loop.model.notes.get(path)?.dirty).toBe(false);
    expect(loop.model.notes.get(path)?.pending).toBe(true);
    expect(source.acks()).toBe(1);
  });
  it("imports mixed jots and questions into their capture day, with durable independent acknowledgments", async () => {
    let waiting: readonly LookupCapture[] = [capture, jot];
    const source: LookupInbox = { supported: true, pending: async () => waiting,
      listen: async () => () => {}, acknowledge: async id => {
        expect(await lookupImported(db, id)).toBe(true);
        const saved = (await getAll(db)).find(n => n.path === path)!;
        expect(saved.body).toContain(id === jot.id ? jot.text : capture.text);
        waiting = waiting.filter(c => c.id !== id);
      } };
    const loop = await start(source);
    expect(loop.model.notes.get(path)?.body).toContain("## Jotted Down");
    expect(loop.model.notes.get(path)?.body).toContain("## Lookup");
    expect(loop.model.notes.has("dump/2026-10-25.md")).toBe(false);
    expect(waiting).toHaveLength(0);
    loop.propose({ kind: "resumed" }); await loop.flush();
    expect(loop.model.notes.get(path)?.body.match(/Remember to pack my ID/g)).toHaveLength(1);
  });
  it("retries a jot after a lost acknowledgement without duplicating or stealing the current draft", async () => {
    let waiting = true;
    let failAck = true;
    const source: LookupInbox = { supported: true, pending: async () => waiting ? [jot] : [],
      listen: async () => () => {}, acknowledge: async id => {
        if (failAck) throw new Error("Bridge lost");
        expect(await lookupImported(db, id)).toBe(true); waiting = false;
      } };
    const loop = await start(source);
    loop.propose({ kind: "created", path: "my-draft.md" });
    loop.propose({ kind: "edited", path: "my-draft.md", body: "My newest draft" });
    failAck = false;
    loop.propose({ kind: "resumed" }); await loop.flush();
    expect(loop.model.openPath).toBe("my-draft.md");
    expect(loop.model.notes.get("my-draft.md")?.body).toBe("My newest draft");
    expect(loop.model.notes.get(path)?.body.match(/Remember to pack my ID/g)).toHaveLength(1);
    expect(waiting).toBe(false);
  });
  it("a warm capture preserves other drafts and subsequent typing while save is in flight", async () => {
    const source = inbox(); source.set([]);
    const loop = await start(source.port);
    loop.propose({ kind: "created", path });
    loop.propose({ kind: "edited", path, body: "existing thought" });
    source.set([capture]); source.emit();
    await loop.flush();
    const body = loop.model.notes.get(path)!.body;
    loop.propose({ kind: "edited", path, body: body + "a newer thought\n" });
    source.emit(); await loop.flush();
    expect((await getAll(db)).find(n => n.path === path)?.body).toEndWith("a newer thought\n");
    expect(loop.model.notes.get(path)!.lookupCaptures).toEqual([capture.id]);
  });
  it("a lost acknowledgment cannot resurrect a deliberately deleted dump or duplicate a renamed entry", async () => {
    const source = inbox(); let calls = 0;
    source.port.acknowledge = async () => { calls++; throw new Error("bridge lost"); };
    const loop = await start(source.port);
    expect(calls).toBe(1);
    loop.propose({ kind: "renamed", from: path, to: "my-research.md" });
    await loop.flush();
    loop.propose({ kind: "resumed" }); await loop.flush();
    expect(loop.model.notes.has(path)).toBe(false);
    expect([...loop.model.notes.values()].filter(n => n.body.includes(capture.text))).toHaveLength(1);
    await deleteMany(db, ["my-research.md"]);
    loop.dispose();
    await start(source.port);
    expect((await getAll(db)).find(n => n.path === path)).toBeUndefined();
    expect(await lookupImported(db, capture.id)).toBe(true);
  });
  it("writes the receipt atomically with the note and retains it after deletion", async () => {
    const body = appendLookup("", capture);
    await putMany(db, [{ path, body, encoding: "utf8", baseSha: null, pending: true, deleted: false, lookupCaptures: [capture.id] }]);
    expect(await lookupImported(db, capture.id)).toBe(true);
    await deleteMany(db, [path]);
    expect(await lookupImported(db, capture.id)).toBe(true);
  });
  it("a failed receipt write rolls back the question, keeps the native copy and retries without duplication", async () => {
    const source = inbox();
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (this.name === LOOKUP_IMPORTS_STORE) throw new DOMException("disk full", "QuotaExceededError");
      return put.call(this, value, key);
    };
    try {
      await start(source.port);
      expect(source.acks()).toBe(0);
      expect(await lookupImported(db, capture.id)).toBe(false);
      expect(await getAll(db)).toEqual([]);
      expect(loop!.model.persistBlocked).toBe(true);
    } finally { IDBObjectStore.prototype.put = put; }
    loop!.propose({ kind: "resumed" }); await loop!.flush();
    expect(source.acks()).toBe(1);
    expect((await getAll(db))[0]!.lookupCaptures).toEqual([capture.id]);
  });
  it("typing before an import save reports completion preserves both the question and the newer edit", async () => {
    const source = inbox(); source.set([]);
    const loop = await start(source.port);
    const transaction = db.transaction.bind(db);
    let injected = false;
    Object.defineProperty(db, "transaction", { configurable: true, value: (...args: Parameters<IDBDatabase["transaction"]>) => {
      const tx = transaction(...args);
      if (!injected && args[1] === "readwrite" && loop.model.notes.get(path)?.lookupCaptures?.includes(capture.id)) {
        injected = true;
        tx.addEventListener("complete", () => {
          loop.propose({ kind: "edited", path, body: loop.model.notes.get(path)!.body + "new typing during save\n" });
        });
      }
      return tx;
    } });
    try {
      source.set([capture]); source.emit(); await loop.flush();
      expect(injected).toBe(true);
      const note = (await getAll(db)).find(n => n.path === path)!;
      expect(note.body).toEndWith("new typing during save\n");
      expect(note.lookupCaptures).toEqual([capture.id]);
      expect(note.body).not.toContain(capture.id);
    } finally { delete (db as unknown as { transaction?: unknown }).transaction; }
  });
  it("upgrades a version-3 vault preserving edits, photo bytes and prior photo receipts", async () => {
    db.close();
    await new Promise<void>(resolve => { const r = indexedDB.deleteDatabase("notes"); r.onsuccess = () => resolve(); });
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("notes", 3);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("notes", { keyPath: "path" });
        r.result.createObjectStore("blobs"); r.result.createObjectStore("photo-imports");
      };
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    const note = { path, body: "Unsynced thought", encoding: "utf8" as const, baseSha: "old-sha", pending: true, deleted: false };
    const tx = old.transaction(["notes", "blobs", "photo-imports"], "readwrite");
    tx.objectStore("notes").put(note);
    tx.objectStore("blobs").put("picture bytes", "attachments/picture.webp");
    tx.objectStore("photo-imports").put("inbox/photo.md", capture.id);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    old.close(); db = await openDb();
    expect(db.version).toBe(4);
    expect(await getAll(db)).toEqual([note]);
    expect(await getBlob(db, "attachments/picture.webp")).toBe("picture bytes");
    expect(await photoImportPath(db, capture.id)).toBe("inbox/photo.md");
    expect(await lookupImported(db, capture.id)).toBe(false);
  });
});
