import { afterEach, beforeEach, expect, it } from "bun:test";
import { boot, type Loop } from "./loop.ts";
import { getAll, openDb, putMany } from "./idb.ts";
import { receiveAlarmAnswers } from "./alarm-inbox.ts";
import { tasksIn } from "./tasks.ts";
import { withTaskLink } from "./task-meta.ts";

let db: IDBDatabase, loop: Loop;
const now = new Date(2026, 9, 23, 8, 10).getTime();
const source = withTaskLink("- [ ] Japanese @2026-10-23 08:00! every day", { id: "japanese" }) + "\n";
const child = withTaskLink("- [ ] Today review", { id: "today", after: "japanese", alarm: true, ready: false }) + "\n";
const stamp = new Date(2026, 9, 23, 8).getTime();
const queued = [
  { kind: "done", path: "a.md", title: "Japanese", at: stamp, receipt: "done-receipt", taskId: "japanese", token: `at:${stamp}` },
  { kind: "activate", path: "b.md", title: "Today review", at: now + 60_000, sourcePath: "a.md", sourceId: "japanese", taskId: "today", token: `at:${stamp}`, receipt: "release-receipt" },
];
beforeEach(async () => {
  await new Promise<void>(resolve => { const r = indexedDB.deleteDatabase("notes"); r.onsuccess = () => resolve(); r.onerror = () => resolve(); });
  db = await openDb();
  await putMany(db, [["a.md", source], ["b.md", child]].map(([path, body]) => ({ path: path!, body: body!, baseSha: null, deleted: false, pending: false, encoding: "utf8" })));
  document.body.innerHTML = '<div id="app"></div>';
  loop = await boot({ db, github: null, shrink: async () => new ArrayBuffer(0), now: () => now, schedule: (_ms, f) => void queueMicrotask(f) }, document.getElementById("app")!);
  await loop.flush();
});
afterEach(() => { loop.dispose(); db.close(); });

it("acknowledges only after both notes and the rolled schedule are actually durable", async () => {
  let calls = 0;
  expect(await receiveAlarmAnswers(loop, async () => queued, async receipts => {
    calls++;
    expect(receipts).toEqual(["done-receipt", "release-receipt"]);
    const saved = await getAll(db);
    expect(tasksIn(saved.find(n => n.path === "a.md")!.body, "a.md")[0]?.remindAt).toBe(new Date(2026, 9, 24, 8).getTime());
    expect(tasksIn(saved.find(n => n.path === "b.md")!.body, "b.md")[0]?.link?.seen).toBe(`at:${stamp}`);
  })).toBe(true);
  expect(calls).toBe(1);
});

it("retains native answers on a failed multi-note save and retries without duplicates", async () => {
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value, key) {
    if (this.name === "notes") throw new DOMException("disk full", "QuotaExceededError");
    return original.call(this, value, key);
  };
  let acknowledgements = 0;
  try {
    expect(await receiveAlarmAnswers(loop, async () => queued, async () => { acknowledgements++; })).toBe(false);
    expect(acknowledgements).toBe(0);
    expect((await getAll(db)).find(n => n.path === "b.md")?.body).toBe(child);
  } finally { IDBObjectStore.prototype.put = original; }
  loop.propose({ kind: "resumed" });
  expect(await receiveAlarmAnswers(loop, async () => queued, async () => { acknowledgements++; })).toBe(true);
  expect(acknowledgements).toBe(1);
  expect(tasksIn((await getAll(db)).find(n => n.path === "b.md")!.body, "b.md")).toHaveLength(1);
});

it("replays safely after a lost acknowledgement without reopening a finished review", async () => {
  expect(await receiveAlarmAnswers(loop, async () => queued, async () => { throw Error("lost reply"); })).toBe(false);
  loop.propose({ kind: "edited", path: "b.md", body: loop.model.notes.get("b.md")!.body.replace("[ ]", "[x]") });
  await loop.flush();
  expect(await receiveAlarmAnswers(loop, async () => queued, async () => {})).toBe(true);
  expect(tasksIn((await getAll(db)).find(n => n.path === "b.md")!.body, "b.md")[0]?.done).toBe(true);
});
