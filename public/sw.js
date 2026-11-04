// Alfred's service worker: fast repeat loads and a friendly offline screen.
// It never caches API responses, sign-in, or pages with personal data.
const VERSION = "alfred-v4";
const STATIC_CACHE = `${VERSION}-static`;
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/alfred.png", "/android-chrome-192x192.png"];
const NAVIGATION_TIMEOUT_MS = 10_000;

// One registration owns the origin. Push handlers add no fetch cache and never
// cache payment details; subscriptions still require an explicit settings tap.
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
    event.respondWith(navigationResponse(event));
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

async function navigationResponse(event) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Navigation unavailable.')); }, NAVIGATION_TIMEOUT_MS);
  });
  try {
    // Reuse the browser's preload rather than sending a duplicate request.
    // This bounds the wait for response headers without buffering or caching a
    // private streaming document. Chat separately handles its content loading.
    return await Promise.race([
      Promise.resolve(event.preloadResponse).then(preloaded => {
        if (preloaded) return preloaded;
        if (controller.signal.aborted) throw new Error('Navigation unavailable.');
        return fetch(event.request, { signal: controller.signal });
      }),
      deadline,
    ]);
  } catch {
    // This public page is returned at the original URL, so Try again preserves
    // the notification's safe payment locator and normal authentication flow.
    try {
      const fallback = await caches.match(OFFLINE_URL);
      if (fallback) return fallback;
    } catch {}
    return new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Alfred could not connect</title><main><h1>Alfred couldn’t connect</h1><p>Your connection may be offline or slow. Please try again.</p><button type="button" onclick="location.reload()">Try again</button></main></html>', {
      status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } finally { clearTimeout(timer); }
}
