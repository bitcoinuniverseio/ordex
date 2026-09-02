// Ordex Documentation Service Worker v1.2.0
// Caches static pages, scripts, and search indexes for offline use.
// Strictly NEVER caches:
// - /api/docs/ask
// - /api/docs/feedback
// - /api/docs/events
// - User-entered credentials or custom gateway URLs

const CACHE_NAME = 'ordex-docs-cache-v1.2.0';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/styles.css',
  '/favicon.svg',
  '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Exclude all worker dynamic endpoints and non-GET requests
  if (
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/api/docs/')
  ) {
    return;
  }

  // Cache-first with network fallback for static assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});
