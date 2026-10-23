import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { nativeAlarmNotes, type AlarmNoteInbox, type AlarmNoteRequest } from "./alarm-note.ts";
import { boot, type Loop } from "./loop.ts";
import { openDb, putMany } from "./idb.ts";
import { renderMarkdown } from "./render-markdown.ts";
import fixture from "./alarm-lines.fixture.json";

const path = "reminders/gmail/example.md";
const note = (path: string, body = "Original email body") => ({ path, body, encoding: "utf8" as const, baseSha: "sha", pending: false, deleted: false });
describe("opening an alarm's note", () => {
  let db: IDBDatabase;
  let loop: Loop;
  beforeEach(async () => {
    await new Promise<void>(resolve => { const r = indexedDB.deleteDatabase("notes"); r.onsuccess = () => resolve(); });
    db = await openDb();
    document.body.innerHTML = '<div id="app"></div>';
  });
  afterEach(() => { loop?.dispose(); db.close(); });
  const inbox = () => {
    let request: AlarmNoteRequest | null = { id: "first", path };
    let changed = () => {};
    const acks: string[] = [];
    const port: AlarmNoteInbox = {
      supported: true,
      pending: async () => request,
      acknowledge: async id => { acks.push(id); if (request?.id === id) request = null; },
      listen: async listener => { changed = listener; return () => { changed = () => {}; }; },
    };
    return { port, acks, set: (value: AlarmNoteRequest | null) => { request = value; changed(); } };
  };
  const start = async (port: AlarmNoteInbox) => {
    loop = await boot({ db, alarmNotes: port, github: null, now: () => Date.parse("2026-10-23T12:00:00Z"),
      schedule: (_ms, fire) => void queueMicrotask(fire), shrink: file => file.arrayBuffer() }, document.getElementById("app")!);
    await loop.flush();
  };
  it("opens a cold-start request after hydration without editing its alarm task", async () => {
    const body = "- [ ] Read this Gmail note in Notes @2026-10-24 16:30!\n\nActual email.";
    await putMany(db, [note(path, body)]);
    const source = inbox();
    await start(source.port);
    expect(loop.model.openPath).toBe(path);
    expect(loop.model.mode).toBe("notes");
    expect(loop.model.notes.get(path)?.body).toBe(body);
    expect(source.acks).toEqual(["first"]);
  });
  it("keeps a missing note pending until a later sync actually brings its body", async () => {
    const source = inbox();
    await start(source.port);
    expect(source.acks).toEqual([]);
    loop.propose({ kind: "pulled", notes: [note(path)], gone: [], remaining: 0 });
    await loop.flush();
    expect(loop.model.openPath).toBe(path);
    expect(source.acks).toEqual(["first"]);
  });
  it("opens warm taps from Audio while retaining unsaved edits in another note", async () => {
    await putMany(db, [note(path), note("draft.md")]);
    const source = inbox(); source.set(null);
    await start(source.port);
    loop.propose({ kind: "edited", path: "draft.md", body: "My latest edits" });
    loop.propose({ kind: "modeChanged", mode: "audio" });
    source.set({ id: "warm", path }); await loop.flush();
    expect(loop.model.mode).toBe("notes");
    expect(loop.model.openPath).toBe(path);
    expect(loop.model.notes.get("draft.md")?.body).toBe("My latest edits");
    expect(source.acks).toEqual(["warm"]);
  });
  it("retries a lost acknowledgement without repeatedly navigating back", async () => {
    await putMany(db, [note(path), note("other.md")]);
    const source = inbox(); const ack = source.port.acknowledge;
    source.port.acknowledge = async () => { throw new Error("Bridge disconnected"); };
    await start(source.port);
    expect(loop.model.openPath).toBe(path);
    loop.propose({ kind: "openRequested", path: "other.md" });
    source.port.acknowledge = ack;
    loop.propose({ kind: "resumed" }); await loop.flush();
    expect(loop.model.openPath).toBe("other.md");
    expect(source.acks).toEqual(["first"]);
    source.set({ id: "newer", path }); await loop.flush();
    expect(loop.model.openPath).toBe(path);
  });
  it("has no native side effects in the browser", async () => {
    const web = nativeAlarmNotes();
    expect(web.supported).toBe(false);
    expect(await web.pending()).toBeNull();
    await web.acknowledge("unused");
  });
  it("renders copied messages as text without embedded images, links or task controls", () => {
    const sample = fixture.cases.find(c => c.name.startsWith("checker original"))!;
    const rendered = renderMarkdown(sample.body, document);
    expect(rendered.querySelectorAll("img, a")).toHaveLength(0);
    expect(rendered.textContent).toContain("![image](https://invalid/tracker)");
    expect(rendered.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  });
});
