import "./style.css";
import { render } from "lit-html";
import { openDb } from "./idb.ts";
import { boot } from "./loop.ts";
import { createGithub } from "./github.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { settingsView } from "./view-settings.ts";
import { canvasShrinker } from "./attachments.ts";
import { keyAction } from "./keys.ts";
import { syncCheckinNotifications } from "./notify.ts";
import { checkForUpdate } from "./update.ts";
import { historyMethod, pathFromUrl } from "./url.ts";

// Worker lifecycle has nothing to do with whether a vault is configured, so it
// runs before anything else. Putting it inside the configured branch left anyone
// on the settings screen stuck with a stale worker and no way out.
if ("serviceWorker" in navigator) {
  if (import.meta.env.PROD) {
    void navigator.serviceWorker.register("/sw.js");
  } else {
    // Never in dev. The worker is cache-first for assets, which is correct when
    // their URLs are content-hashed and catastrophic when they are not: Vite
    // serves modules from stable paths like /src/main.ts, so a cached copy is
    // returned forever and a rebuilt app never reaches the browser.
    //
    // Tearing down whatever a previous production build registered means a dev
    // reload heals itself instead of needing site data cleared by hand.
    void navigator.serviceWorker
      .getRegistrations()
      .then((registrations) =>
        Promise.all(registrations.map((r) => r.unregister())),
      )
      .then(() => caches.keys())
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))));
  }
}

const root = document.getElementById("app");
if (!root) throw new Error("#app is missing from index.html");

// The only place that reaches for ambient state. Everything below is handed what
// it needs (injected, not reached for).
const config = loadConfig(localStorage);

if (config === null) {
  render(
    settingsView((next) => {
      saveConfig(localStorage, next);
      location.reload();
    }),
    root,
  );
} else {
  // Read before the loop starts, because hydrating picks a note of its own and
  // the first paint writes that choice straight into the address bar.
  const wanted = pathFromUrl(location.pathname);

  // The loop reports where it is; how that meets the History API is decided
  // here, and only here.
  //
  let booted = false;
  let fromPop = false;
  const navigate = (url: string, title: string): void => {
    document.title = title;
    const method = historyMethod(url, { booted, fromPop });
    fromPop = false;
    if (url === location.pathname) return;
    history[method](null, "", url);
  };

  const loop = await boot(
    {
      db: await openDb(),
      shrink: canvasShrinker,
      github: createGithub(config),
      now: () => Date.now(),
      schedule: (ms, fire) => void setTimeout(fire, ms),
      config,
      navigate,
      saveConfig: (next) => {
        saveConfig(localStorage, next);
        // A reload is the honest way to adopt a new token: every client above
        // this point was built with the old one.
        location.reload();
      },
    },
    root,
    wanted,
  );

  booted = true;

  // No-op on the web. On Android this asks for notification permission once
  // and keeps the three daily check-ins scheduled.
  void syncCheckinNotifications(() =>
    loop.propose({ kind: "modeChanged", mode: "dump" }),
  );
  // No-op on the web (checkForUpdate gates on native inside). One quiet ask
  // per boot; offline or up to date resolves to nothing.
  void checkForUpdate(fetch).then((found) => {
    if (found !== null) loop.propose(found);
  });

  // Back and forward. The model decides whether the path names something
  // openable — it is the only thing that knows — and a path that names nothing
  // is left alone rather than corrected, so the button still works.
  addEventListener("popstate", () => {
    const path = pathFromUrl(location.pathname);
    if (path === null || path === loop.model.openPath) return;
    if (!loop.model.notes.has(path)) return;
    fromPop = true;
    loop.propose({ kind: "opened", path });
  });

  addEventListener("online", () => loop.propose({ kind: "online", online: true }));
  addEventListener("offline", () =>
    loop.propose({ kind: "online", online: false }),
  );

  // Without this the app pulls once per session, so a note written on the laptop
  // does not appear on the phone until a reload. Clearing the watermark is the
  // whole mechanism; nap() does the rest.
  // A dialog says aria-modal, and until now that was the only sense in which it
  // was. Tab walked straight out of it into the tab bar behind, where Enter
  // navigated the app while the question was still on screen. Single-letter
  // shortcuts are already refused while a modal is open; this is the same rule
  // for focus, which needs the DOM and so cannot live in keys.ts.
  addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Tab" || loop.model.modal === null) return;
    const dialog = document.querySelector<HTMLElement>("[role=dialog]");
    if (dialog === null) return;
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;
    const active = document.activeElement;
    // Wrap at whichever end the cycle is about to leave from.
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  });

  addEventListener("keydown", (event: KeyboardEvent) => {
    const action = keyAction(event, loop.model);
    if (action === null) return;
    event.preventDefault();

    switch (action.kind) {
      case "propose":
        loop.propose(action.proposal);
        return;
      case "focus":
        document.querySelector<HTMLElement>(action.selector)?.focus();
        return;
      case "enterEditor":
        loop.enterEditor();
        return;
      case "blur":
        // Leaving the field is what makes the single-letter shortcuts reachable
        // from a note you are writing in.
        (event.target as HTMLElement).blur();
        return;
    }
  });

  const resumed = () => loop.propose({ kind: "resumed" });
  // Without these the app pulls once per session, so a note written on the
  // laptop does not appear on the phone until a reload. Clearing the watermark
  // is the whole mechanism; nap() does the rest.
  addEventListener("focus", resumed);
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") resumed();
  });

}
