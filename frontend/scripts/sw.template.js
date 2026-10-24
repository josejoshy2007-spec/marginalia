/* Marginalia service worker: the whole app is precached so it opens offline. Study data lives in
   IndexedDB, not here. Requests to Gemini are never cached. */
const VERSION = "__VERSION__";
const BASE = "__BASE__";
const FILES = "__FILES__";
const CACHE = `marginalia-${VERSION}`;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("marginalia-") && k !== CACHE).map((k) => caches.delete(k))))
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
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
