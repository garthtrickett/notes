import "./style.css";
import { html, render } from "lit-html";
import { applyTheme, loadTheme, saveTheme, type Theme } from "./theme.ts";
import { themeButton } from "./view-theme.ts";
import { openDb } from "./idb.ts";
import { boot } from "./loop.ts";
import { createGithub } from "./github.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { settingsView } from "./view-settings.ts";
import { canvasShrinker } from "./attachments.ts";
import { keyAction } from "./keys.ts";
import { acknowledgeAlarmAnswers, onAlarmAnswered, onNotificationTap, syncCheckinNotifications, takeAlarmAnswers, watchVault } from "./notify.ts";
import { receiveAlarmAnswers } from "./alarm-inbox.ts";
import { checkForUpdate, updateCheckDue } from "./update.ts";
import { historyMethod, pathFromUrl } from "./url.ts";
import { emptyLocation, loadLocation, parseLocation, saveLocation, type ViewLocation } from "./view-location.ts";
import { nativeWidgetSyncReporter } from "./widget-sync.ts";

// Half a minute: fast enough that the other screen feels live, slow enough that
// 120 requests an hour is nothing against GitHub's 5000 and nothing against a
// battery. Only paid while the tab is visible.
const POLL_MS = 30_000;

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
const theme = loadTheme(localStorage);
applyTheme(theme, document);
const changeTheme = (next: Theme) => {
  applyTheme(next, document);
  saveTheme(localStorage, next);
};

if (config === null) {
  void nativeWidgetSyncReporter(null)({ state: "unknown", checkedAt: null, pulledAt: null });
  let setupTheme = theme;
  const paintSetup = () => render(html`
    <div class="setup-appearance">${themeButton(setupTheme, () => {
      setupTheme = setupTheme === "dark" ? "light" : "dark";
      changeTheme(setupTheme);
      paintSetup();
    })}</div>
    ${settingsView((next) => {
      saveConfig(localStorage, next);
      location.reload();
    })}`,
    root,
  );
  paintSetup();
} else {
  // Read the explicit URL and this tab's preference before any startup paint.
  const wanted = pathFromUrl(location.pathname);

  // The loop reports where it is; how that meets the History API is decided
  // here, and only here.
  //
  let booted = false;
  let fromPop = false;
  const navigate = (url: string, title: string, view: ViewLocation): void => {
    document.title = title;
    const method = url === location.pathname ? "replaceState" : historyMethod(url, { booted, fromPop });
    fromPop = false;
    history[method]({ ...history.state, notesView: view }, "", url);
  };

  const github = createGithub(config);

  const loop = await boot(
    {
      theme,
      onThemeChanged: changeTheme,
      initialView: loadLocation(sessionStorage, localStorage, config) ?? emptyLocation,
      onViewChanged: (view) => saveLocation(sessionStorage, localStorage, config, view),
      db: await openDb(),
      shrink: canvasShrinker,
      github,
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

  window.addEventListener("pagehide", event => { if (!event.persisted) loop.dispose(); });

  booted = true;

  // Registered before anything else that can await: a tap on a closed app is
  // what launched it, and the event is on its way already.
  void onNotificationTap({
    note: (path) => loop.propose({ kind: "openRequested", path }),
    dump: () => loop.propose({ kind: "modeChanged", mode: "dump" }),
  });
  // Done and Snooze pressed on the alarm screen while the app was closed are
  // waiting on the phone; so is one pressed with the app open behind the
  // alarm, which the phone announces. The model holds them until the notes
  // they edit have loaded.
  const takeAnswers = () => {
    void receiveAlarmAnswers(loop, takeAlarmAnswers, acknowledgeAlarmAnswers);
  };
  takeAnswers();
  onAlarmAnswered(takeAnswers);
  // Lets the phone keep alarms current with the app closed. No-op on the web.
  void watchVault(config);
  // No-op on the web. On Android this asks for notification permission once
  // and keeps the three daily check-ins scheduled.
  void syncCheckinNotifications();
  // No-op on the web (checkForUpdate gates on native inside). Asked on boot,
  // again on every return to the foreground, and on the poll while open, so a
  // new build is offered without closing the app. Throttled, because GitHub's
  // unauthenticated limit is shared with the head poll. Offline or up to date
  // resolves to nothing.
  let lastUpdateCheck: number | null = null;
  const askForUpdate = () => {
    const at = Date.now();
    if (!updateCheckDue(lastUpdateCheck, at)) return;
    lastUpdateCheck = at;
    void checkForUpdate(fetch).then((found) => {
      if (found !== null) loop.propose(found);
    });
  };
  askForUpdate();

  // Back and forward restore both note links and the specific view at the root.
  // A missing note can wait for sync without selecting an unrelated note.
  addEventListener("popstate", (event: PopStateEvent) => {
    const path = pathFromUrl(location.pathname);
    const saved = parseLocation(event.state?.notesView);
    const view: ViewLocation = path === null ? (saved ?? emptyLocation)
      : { mode: "notes", openPath: path, preview: saved?.preview ?? false };
    fromPop = true;
    loop.propose({ kind: "viewRestored", location: view });
    // An identical/unsupported history view may not need another paint callback.
    // Never let its Back flag affect a later, unrelated navigation.
    queueMicrotask(() => { fromPop = false; });
  });

  // WebViews can miss connectivity events while backgrounded. Re-read the
  // browser hint when visible; remote reachability is proved by sync itself.
  const refreshConnectivity = () => {
    if (navigator.onLine !== loop.model.online) {
      loop.propose({ kind: "online", online: navigator.onLine });
    }
  };
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
    if (event.defaultPrevented || event.key !== "Tab" || loop.model.modal === null) return;
    const dialog = document.querySelector<HTMLElement>("[role=dialog]");
    if (dialog === null) return;
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => el.offsetParent !== null && el.tabIndex >= 0);
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

  // Ctrl+F / Cmd+F opens the editor's find wherever focus is, as long as a
  // note or the dump is on screen. Inside the editor its own keymap has
  // already taken the key, which is the defaultPrevented check.
  addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.shiftKey) return;
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return;
    if (loop.find()) event.preventDefault();
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

  // Both screens open at once is the case focus cannot serve: neither window
  // ever loses focus, so neither ever pulls. There is no server to push from,
  // so the device has to ask — but asking with the tree costs ~150KB to nearly
  // always learn nothing moved. Ask for the branch head instead, a few hundred
  // bytes, and let the reducer decide whether that is worth a pull.
  //
  // Seeded once here so the first tick has something to compare against and
  // does not read "nobody has looked yet" as a change.
  const pollHead = () => {
    void github.head().then((head) => {
      if (head.ok) loop.propose({ kind: "headSeen", head: head.value });
    });
  };
  pollHead();
  // Visible only: a backgrounded phone must not be woken every half minute for
  // a branch nobody is looking at, and coming back to it fires focus anyway.
  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    refreshConnectivity();
    loop.propose({ kind: "woke" }); // Local day rollover also works offline.
    if (!loop.model.online || loop.model.syncing) return;
    pollHead();
    askForUpdate();
  }, POLL_MS);

  const resumed = () => {
    refreshConnectivity();
    takeAnswers();
    askForUpdate();
    loop.propose({ kind: "resumed" });
  };
  // Without these the app pulls once per session, so a note written on the
  // laptop does not appear on the phone until a reload. Clearing the watermark
  // is the whole mechanism; nap() does the rest.
  addEventListener("focus", resumed);
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") resumed();
  });

}
