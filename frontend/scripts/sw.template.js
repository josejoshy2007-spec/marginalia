/* Marginalia service worker: the whole app is precached so it opens offline. Study data lives in
   IndexedDB, not here. Requests to Gemini are never cached. */
const VERSION = "__VERSION__";
const BASE = "__BASE__";
const FILES = "__FILES__";
const CACHE = `marginalia-${VERSION}`;
// The on-device search model + WASM runtime: versioned by their content, not by the app release, so a normal
// update does not re-download ~55 MB, but a changed model replaces the old copy.
const MODEL_CACHE = `search-model-__MODEL_VERSION__`;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => (k.startsWith("marginalia-") && k !== CACHE) || (k.startsWith("search-model") && k !== MODEL_CACHE)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return; // Gemini etc. go to the network
  if (e.request.mode === "navigate") {
    // App shell: network first (picks up updates), cached page when offline.
    e.respondWith(fetch(e.request).catch(() => caches.match(`${BASE}/`).then((r) => r || caches.match(e.request))));
    return;
  }
  if (/\/(models|ort)\//.test(url.pathname)) {
    // The on-device search model and its WASM runtime (~55 MB): kept after first use, so search works offline.
    e.respondWith(
      caches.open(MODEL_CACHE).then((c) =>
        c.match(e.request).then((hit) => hit || fetch(e.request).then((res) => (res.ok && c.put(e.request, res.clone()), res))),
      ),
    );
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
