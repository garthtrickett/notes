import { html, svg } from "lit-html";
import type { Theme } from "./theme.ts";

export const themeButton = (theme: Theme, toggle: () => void) => html`
  <button type="button" class="theme-button"
    title=${theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
    aria-label=${theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
    @keydown=${(event: KeyboardEvent) => {
      // Space activates this focused button; the app-wide Space shortcut must
      // not replace that native action with the new-note dialog.
      if (event.key === " ") event.stopPropagation();
    }}
    @click=${toggle}>
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
      stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      ${theme === "dark"
        ? svg`<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>`
        : svg`<path d="M20.5 14A9 9 0 0 1 10 3.5 9 9 0 1 0 20.5 14Z"/>`}
    </svg>
    ${theme === "dark" ? "Light" : "Dark"}
  </button>`;
