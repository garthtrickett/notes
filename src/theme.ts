// Appearance is a device preference, separate from the vault and its sync.
export type Theme = "dark" | "light";

export const THEME_KEY = "notes.theme";

export const loadTheme = (storage: Pick<Storage, "getItem">): Theme => {
  try {
    return storage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
};

export const saveTheme = (storage: Pick<Storage, "setItem">, theme: Theme): void => {
  try {
    storage.setItem(THEME_KEY, theme);
  } catch {
    // A blocked/full store must not prevent switching for this session.
  }
};

export const applyTheme = (theme: Theme, page: Document): void => {
  page.documentElement.dataset.theme = theme;
  // Browser/PWA chrome follows the same surface as the page. CSS owns colors.
  const background = page.defaultView?.getComputedStyle(page.documentElement).getPropertyValue("--bg").trim();
  if (background) page.querySelector('meta[name="theme-color"]')?.setAttribute("content", background);
};
