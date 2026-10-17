import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getAll, openDb } from "./idb.ts";
import { boot, type Loop } from "./loop.ts";
import { tasksIn } from "./tasks.ts";

let db: IDBDatabase;
let root: HTMLElement;
const settle = async (loop: Loop) => {
  await loop.flush();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
};
const button = (label: string) => [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
const field = (name: string) => root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
const fill = async (loop: Loop, name: string, value: string) => {
  field(name).value = value;
  field(name).dispatchEvent(new Event(name === "repeat" ? "change" : "input", { bubbles: true }));
  await settle(loop);
};
const start = async () => {
  const loop = await boot({ db, github: null, shrink: async () => new ArrayBuffer(0),
    now: () => new Date(2026, 9, 17, 9).getTime(), schedule: (_ms, fire) => void queueMicrotask(fire) }, root);
  loop.propose({ kind: "modeChanged", mode: "tasks" });
  await settle(loop);
  button("New task").click();
  await settle(loop);
  return loop;
};
const submit = async (loop: Loop) => {
  root.querySelector(".task-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle(loop);
};

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("notes");
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
  db = await openDb();
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app")!;
});
afterEach(() => db.close());

describe("task creation dialog", () => {
  it("is available in an empty vault, creates and persists Markdown offline, and stays in Tasks", async () => {
    const loop = await start();
    expect(document.activeElement).toBe(field("title"));
    expect(field("alarm").disabled).toBe(true);
    await fill(loop, "title", "Buy milk");
    await submit(loop);
    expect(loop.model.modal).toBeNull();
    expect(loop.model.mode).toBe("tasks");
    expect(root.querySelector(".task-title")?.textContent).toContain("Buy milk");
    expect((await getAll(db)).map((n) => ({ path: n.path, body: n.body, pending: n.pending }))).toEqual([
      { path: "reminders.md", body: "- [ ] Buy milk\n", pending: true },
    ]);
    const box = root.querySelector<HTMLInputElement>(".taskgroup input[type=checkbox]")!;
    box.click();
    await settle(loop);
    expect(loop.model.notes.get("reminders.md")?.body).toBe("- [x] Buy milk\n");
  });

  it("saves all reminder fields into a new chosen note", async () => {
    const loop = await start();
    await fill(loop, "title", "Water plants");
    await fill(loop, "description", "Check the soil first.\nUse a small jug.");
    await fill(loop, "date", "2026-10-21");
    await fill(loop, "time", "09:30");
    field("alarm").click();
    await settle(loop);
    await fill(loop, "repeat", "week");
    await fill(loop, "path", "personal/plants");
    await submit(loop);
    const expected = "- [ ] Water plants @2026-10-21 09:30! every week\n    Check the soil first.\n    Use a small jug.\n";
    expect(loop.model.notes.get("personal/plants.md")?.body).toBe(expected);
    expect((await getAll(db)).find((n) => n.path === "personal/plants.md")?.body).toBe(expected);
    expect(tasksIn(expected, "personal/plants.md")[0]).toMatchObject({ alarm: true, repeat: "week" });
  });

  it("appends to the latest note body while retaining the draft through background paints", async () => {
    const loop = await start();
    await fill(loop, "title", "Call Mum");
    loop.propose({ kind: "created", path: "reminders.md" });
    loop.propose({ kind: "edited", path: "reminders.md", body: "Existing words\n- [ ] Old task\n" });
    loop.propose({ kind: "modeChanged", mode: "tasks" });
    loop.propose({ kind: "woke" });
    await settle(loop);
    expect(field("title").value).toBe("Call Mum");
    await submit(loop);
    expect(loop.model.notes.get("reminders.md")?.body).toBe("Existing words\n- [ ] Old task\n\n- [ ] Call Mum\n");
  });

  it("keeps entered fields on a path error, then allows correction", async () => {
    const loop = await start();
    await fill(loop, "title", "Keep this text");
    await fill(loop, "path", "../bad.md");
    await submit(loop);
    expect(root.querySelector(".task-form-error")?.textContent).toContain("not a usable path");
    expect(field("title").value).toBe("Keep this text");
    expect(loop.model.notes.size).toBe(0);
    await fill(loop, "path", "good.md");
    await submit(loop);
    expect(loop.model.notes.get("good.md")?.body).toBe("- [ ] Keep this text\n");
  });

  it("does not hide a task inside an unclosed code fence", async () => {
    const loop = await start();
    loop.propose({ kind: "created", path: "reminders.md" });
    loop.propose({ kind: "edited", path: "reminders.md", body: "```\nunfinished" });
    await fill(loop, "title", "Visible task");
    await submit(loop);
    expect(loop.model.notes.get("reminders.md")?.body).toBe("```\nunfinished");
    expect(root.querySelector(".task-form-error")?.textContent).toContain("code block");
  });

  it("clears the dependent alarm and repeat when the date is removed", async () => {
    const loop = await start();
    await fill(loop, "title", "Plain task");
    await fill(loop, "date", "2026-10-21");
    field("alarm").click();
    await settle(loop);
    await fill(loop, "repeat", "day");
    await fill(loop, "date", "");
    expect(field("alarm").checked).toBe(false);
    expect(field("alarm").disabled).toBe(true);
    await submit(loop);
    expect(loop.model.notes.get("reminders.md")?.body).toBe("- [ ] Plain task\n");
  });

  it("cancels without writing and opens a fresh form next time", async () => {
    const loop = await start();
    await fill(loop, "title", "Discard this");
    button("Cancel").click();
    await settle(loop);
    expect(loop.model.modal).toBeNull();
    expect(await getAll(db)).toHaveLength(0);
    button("New task").click();
    await settle(loop);
    expect(field("title").value).toBe("");
  });
});
