// Alfred's service worker: fast repeat loads and a friendly offline screen.
// It never caches API responses, sign-in, or pages with personal data.
const VERSION = "alfred-v3";
const STATIC_CACHE = `${VERSION}-static`;
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/alfred.png", "/android-chrome-192x192.png"];

// One registration owns the origin. Push handlers add no fetch cache and never
// receive payment details; subscriptions still require an explicit settings tap.
importScripts("/alfred-push-sw.js");

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))))
      // Navigation preload starts the page request while the worker boots, so a cold
      // launch of the installed app doesn't wait for the worker before hitting the network.
      .then(() => self.registration.navigationPreload?.enable())
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Pages always come from the network so balances and messages are fresh; offline gets the fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      Promise.resolve(event.preloadResponse)
        .then((preloaded) => preloaded || fetch(request))
        .catch(() => caches.match(OFFLINE_URL)),
    );
    return;
  }

  // Build assets are content-hashed, so they are safe to serve from cache forever.
  const immutable = url.pathname.startsWith("/_next/static/");
  const icon = /\.(png|ico|svg|woff2)$/.test(url.pathname) && !url.pathname.startsWith("/api/");
  // Optimized copies of Alfred's own public images (the loading mark) are keyed by
  // source, width and quality, so they're as stable as the icons themselves.
  const optimizedIcon = url.pathname === "/_next/image" && (url.searchParams.get("url") || "").startsWith("/");
  if (immutable || icon || optimizedIcon) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
  }
});
