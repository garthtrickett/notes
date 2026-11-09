import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { applyTheme, loadTheme, saveTheme, THEME_KEY } from "./theme.ts";

afterEach(() => {
  localStorage.removeItem(THEME_KEY);
  document.documentElement.removeAttribute("data-theme");
});

test("appearance survives a new session and rejects unrecognized stored values", () => {
  expect(loadTheme(localStorage)).toBe("dark");
  saveTheme(localStorage, "light");
  expect(loadTheme(localStorage)).toBe("light");
  saveTheme(localStorage, "dark");
  expect(loadTheme(localStorage)).toBe("dark");
  localStorage.setItem(THEME_KEY, "system");
  expect(loadTheme(localStorage)).toBe("dark");
});

test("unavailable storage leaves appearance usable for the current session", () => {
  expect(loadTheme({ getItem() { throw new Error("blocked"); } })).toBe("dark");
  expect(() => saveTheme({ setItem() { throw new Error("full"); } }, "light")).not.toThrow();
  applyTheme("light", document);
  expect(document.documentElement.dataset.theme).toBe("light");
});

test("the pre-paint script uses the same saved preference as boot", () => {
  const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const script = index.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("no pre-paint script");
  for (const value of ["light", "dark", "invalid"]) {
    localStorage.setItem(THEME_KEY, value);
    new Function("document", "localStorage", script)(document, localStorage);
    expect(document.documentElement.dataset.theme).toBe(loadTheme(localStorage));
  }
  expect(() => new Function("document", "localStorage", script)(document, {
    getItem() { throw new Error("blocked"); },
  })).not.toThrow();
});
