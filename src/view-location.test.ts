import { expect, test } from "bun:test";
import { emptyLocation, loadLocation, parseLocation, saveLocation, type ViewLocation } from "./view-location.ts";

const storage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};
const vault = { owner: "Me", repo: "Vault", branch: "main", token: "never-store-this" };
const dump: ViewLocation = { ...emptyLocation, mode: "dump", openPath: "reference.md" };
const tasks: ViewLocation = { ...emptyLocation, mode: "tasks" };

test("two existing tabs restore independently while a fresh process uses the last device view", () => {
  const one = storage(), two = storage(), device = storage();
  saveLocation(one, device, vault, dump);
  saveLocation(two, device, vault, tasks);
  expect(loadLocation(one, device, vault)).toEqual(dump);
  expect(loadLocation(two, device, vault)).toEqual(tasks);
  expect(loadLocation(storage(), device, vault)).toEqual(tasks);
});

test("view preferences stay scoped to the vault and branch, independently of token rotation", () => {
  const tab = storage(), device = storage();
  saveLocation(tab, device, vault, dump);
  expect(loadLocation(tab, device, { ...vault, token: "changed" })).toEqual(dump);
  expect(loadLocation(tab, device, { ...vault, repo: "other" })).toBeNull();
  expect(loadLocation(tab, device, { ...vault, branch: "other" })).toBeNull();
});

test("invalid and inaccessible preferences cannot prevent startup or editing", () => {
  for (const value of [null, [], {}, { ...dump, mode: "bogus" }, { ...dump, preview: "yes" }, { ...dump, openPath: 1 }]) {
    expect(parseLocation(value)).toBeNull();
  }
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const device = storage();
  saveLocation(blocked, device, vault, dump);
  expect(loadLocation(blocked, device, vault)).toEqual(dump);
  expect(() => saveLocation(blocked, blocked, vault, dump)).not.toThrow();
  expect(loadLocation({ getItem: () => "bad JSON" }, blocked, vault)).toBeNull();
});
