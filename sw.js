'use strict';

// Makes Mailboard installable and shows the last-seen page when offline.
// Always network-first, so new versions load as soon as they're deployed.
// Only the app page itself is cached; Gmail data never touches this cache.

const CACHE = 'mailboard-shell';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(async (c) => {
            // Drop older versions of the same file (app.js?v=… changes every deploy).
            const path = new URL(req.url).pathname;
            for (const k of await c.keys()) if (new URL(k.url).pathname === path) await c.delete(k);
            await c.put(req, copy);
          });
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: req.mode === 'navigate' })
        .then((hit) => hit || Response.error())),
  );
});
