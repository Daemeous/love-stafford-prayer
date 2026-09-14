/* Offline support for the Love Stafford Prayer Network app. Same pattern
   as the Leaflet Map family's sw.js (see that repo's comments for the full
   reasoning) — app shell (index.html/core.js/styles.css) is always
   network-first so a device never gets stuck on a stale version, OSM tiles
   and CDN libs are cached aggressively, and Google Sheets/Apps Script/auth
   requests are never intercepted. */

const CACHE_VERSION = "v1";
const SHELL_CACHE = `prayer-shell-${CACHE_VERSION}`;
const LIB_CACHE = `prayer-libs-${CACHE_VERSION}`;
const TILE_CACHE = `prayer-tiles-${CACHE_VERSION}`;
const TILE_CACHE_MAX = 1000;

const SHELL_ASSETS = ["./", "./index.html"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  const keep = new Set([SHELL_CACHE, LIB_CACHE, TILE_CACHE]);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !keep.has(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isTileRequest(url) { return /(^|\.)tile\.openstreetmap\.org$/.test(new URL(url).hostname); }
function isCdnLibRequest(url) {
  return /^(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|accounts\.google\.com)$/
    .test(new URL(url).hostname);
}
function isAppDataRequest(url) {
  return /(^|\.)google\.com$|(^|\.)googleapis\.com$/.test(new URL(url).hostname);
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  while (keys.length > maxEntries) await cache.delete(keys.shift());
}

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = request.url;
  if (isAppDataRequest(url)) return;

  if (isTileRequest(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const resp = await fetch(request);
        if (resp.ok || resp.type === "opaque") { cache.put(request, resp.clone()); trimCache(TILE_CACHE, TILE_CACHE_MAX); }
        return resp;
      } catch (e) { return cached || Response.error(); }
    })());
    return;
  }

  if (isCdnLibRequest(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(LIB_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const resp = await fetch(request);
        if (resp.ok || resp.type === "opaque") cache.put(request, resp.clone());
        return resp;
      } catch (e) { return cached || Response.error(); }
    })());
    return;
  }

  if (request.mode === "navigate" || new URL(url).pathname.endsWith(".html") || new URL(url).pathname.endsWith(".js") || new URL(url).pathname.endsWith(".css")) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const resp = await fetch(request, { cache: "no-store" });
        if (resp.ok || resp.type === "opaque") cache.put(request, resp.clone());
        return resp;
      } catch (e) {
        const cached = await cache.match(request);
        return cached || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(request);
    const network = fetch(request).then(resp => { if (resp.ok) cache.put(request, resp.clone()); return resp; }).catch(() => cached);
    return cached || network;
  })());
});
