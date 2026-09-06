import "./style.css";
import { render } from "lit-html";
import { openDb } from "./idb.ts";
import { boot } from "./loop.ts";
import { createGithub } from "./github.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { settingsView } from "./view.ts";

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
  const refresh = () => loop.propose({ kind: "refresh" });
  addEventListener("focus", refresh);
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });

  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js");
  }
}
