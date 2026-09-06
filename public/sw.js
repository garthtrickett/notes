// A hand-rolled shell cache, deliberately not vite-plugin-pwa.
//
// The usual reason for the plugin is precaching hashed filenames from the build
// manifest. That is avoidable: hashed asset names are immutable, so caching them
// as they are requested is correct and needs no build step.

const CACHE = "notes-shell-v2";

// Take over straight away rather than waiting for every tab to close, so a fix
// to this file reaches people on their next reload.
self.addEventListener("install", () => void self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

// The clone has to happen synchronously, before this response is handed back and
// its body consumed. Awaiting caches.open() first means clone() throws "body is
// already used" and nothing is ever cached — silently, because the page still
// works while there is a network.
const cachePut = (request, response) => {
  if (!response || !response.ok) return response;
  const copy = response.clone();
  void caches.open(CACHE).then((cache) => cache.put(request, copy));
  return response;
};

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never the GitHub API

  // Navigations are network-first, so a deploy is picked up whenever there is a
  // network, and the app still opens when there is not.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => cachePut(request, response))
        .catch(
          async () =>
            (await caches.match(request)) ??
            (await caches.match("/")) ??
            new Response("Offline and not cached yet.", {
              status: 503,
              headers: { "Content-Type": "text/plain" },
            }),
        ),
    );
    return;
  }

  // Cache-first is only safe where the URL is content-hashed, which is exactly
  // the build output and nothing else. Anything served from a stable path can
  // change under the same URL, so serving a cached copy would pin it forever.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ?? fetch(request).then((response) => cachePut(request, response)),
      ),
    );
    return;
  }

  // Everything else: fresh when there is a network, cached when there is not.
  event.respondWith(
    fetch(request)
      .then((response) => cachePut(request, response))
      .then((response) => response ?? caches.match(request))
      .catch(() => caches.match(request)),
  );
});
