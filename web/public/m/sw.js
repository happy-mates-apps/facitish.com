// Service worker for /m. Keeps the app shell and built assets cached, so the app opens
// offline and fast. API calls are never cached (they carry personal data).
const CACHE = "gaer-m-v1";
const SHELL = "/m/";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.add(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  // Navigations: network first, fall back to the cached shell (the SPA routes /m/* itself).
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(SHELL, res.clone()));
        return res;
      }).catch(() => caches.match(SHELL)),
    );
    return;
  }

  // Hashed build assets and icons: cache first.
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/m/")) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      })),
    );
  }
});
