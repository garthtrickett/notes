import "./style.css";
import { render } from "lit-html";
import { openDb } from "./idb.ts";
import { boot } from "./loop.ts";
import { createGithub } from "./github.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { settingsView } from "./view.ts";
import { canvasShrinker } from "./attachments.ts";

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
// it needs (principle 5).
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
  const loop = await boot(
    {
      db: await openDb(),
      shrink: canvasShrinker,
      github: createGithub(config),
      now: () => Date.now(),
      schedule: (ms, fire) => void setTimeout(fire, ms),
    },
    root,
  );

  addEventListener("online", () => loop.propose({ kind: "online", online: true }));
  addEventListener("offline", () =>
    loop.propose({ kind: "online", online: false }),
  );

  // Without this the app pulls once per session, so a note written on the laptop
  // does not appear on the phone until a reload. Clearing the watermark is the
  // whole mechanism; nap() does the rest.
  const resumed = () => loop.propose({ kind: "resumed" });
  addEventListener("focus", resumed);
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") resumed();
  });

}
