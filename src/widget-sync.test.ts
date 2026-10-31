import { describe, expect, it } from "bun:test";
import { createModel, type Note } from "./model.ts";
import { serialWidgetSyncReporter, widgetSyncSnapshot, type WidgetSyncSnapshot } from "./widget-sync.ts";

const ready = () => ({ ...createModel(), hydrated: true, online: true, lastSyncedAt: 100 });

describe("widget note sync", () => {
  it("requires a completed remote check, not a pull-start watermark", () => {
    const model = ready();
    expect(widgetSyncSnapshot(model, null, true, null).state).toBe("unknown");
    expect(widgetSyncSnapshot(model, 100, true, null).state).toBe("unknown");
    expect(widgetSyncSnapshot(model, 100, true, 100)).toEqual({ state: "synced", checkedAt: 100, pulledAt: 100 });
    expect(widgetSyncSnapshot(model, 100, false, 100).state).toBe("unknown");
    model.pullRemaining = 1;
    expect(widgetSyncSnapshot(model, 100, true, 100).state).toBe("unknown");
  });

  it("cannot call unpersisted or unpushed records synced", () => {
    const model = ready();
    const note: Note = { path: "a.md", body: "private", baseSha: "sha", pending: true, dirty: false, deleted: false, encoding: "utf8" };
    model.notes.set(note.path, note);
    expect(widgetSyncSnapshot(model, 100, true, 100).state).toBe("pending");
    model.notes.set(note.path, { ...note, dirty: true, pending: false });
    expect(widgetSyncSnapshot(model, 100, true, 100).state).toBe("pending");
    model.notes.clear(); model.forgotten.add("removed.md");
    expect(widgetSyncSnapshot(model, 100, true, 100).state).toBe("pending");
  });

  it("reports network, save and import problems without publishing their contents", () => {
    const model = ready();
    model.syncing = true;
    expect(widgetSyncSnapshot(model, 100, true, 100).state).toBe("syncing");
    model.syncError = { kind: "auth" };
    expect(widgetSyncSnapshot(model, 100, true, 100).state).toBe("error");
    model.syncError = { kind: "offline" };
    expect(widgetSyncSnapshot(model, 100, true, 100).state).toBe("offline");
    model.persistBlocked = true;
    expect(widgetSyncSnapshot(model, 100, true, 100)).toEqual({ state: "error", checkedAt: 100, pulledAt: 100 });
  });

  it("serialises slow writes and coalesces waiting reports to the newest state", async () => {
    const writes: WidgetSyncSnapshot[] = [];
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const report = serialWidgetSyncReporter(async value => {
      writes.push(value);
      if (writes.length === 1) await blocked;
    });
    void report({ state: "synced", checkedAt: 100, pulledAt: 100 });
    await Promise.resolve();
    void report({ state: "syncing", checkedAt: 100, pulledAt: 100 });
    const done = report({ state: "pending", checkedAt: 100, pulledAt: 100 });
    release(); await done;
    expect(writes.map(value => value.state)).toEqual(["synced", "pending"]);
    await report({ state: "pending", checkedAt: 100, pulledAt: 100 });
    expect(writes).toHaveLength(2);
  });

  it("a failed status bridge cannot reject sync, and can retry the same status", async () => {
    let writes = 0;
    const report = serialWidgetSyncReporter(async () => { if (++writes === 1) throw new Error("Unavailable"); });
    await report({ state: "pending", checkedAt: null, pulledAt: null });
    await report({ state: "pending", checkedAt: null, pulledAt: null });
    expect(writes).toBe(2);
  });
});
