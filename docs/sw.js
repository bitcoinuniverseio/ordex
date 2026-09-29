// Ordex Documentation Service Worker v1.2.0
// Caches static pages, scripts, and search indexes for offline use.
// Strictly NEVER caches:
// - /api/docs/ask
// - /api/docs/feedback
// - /api/docs/events
// - User-entered credentials or custom gateway URLs

/* IMPLEMENTATION-HANDOFF [OX-S12]
 * Defect OX-S-D12; coverage OX-S-C1500..OX-S-C1505. Fixed cache name serves stale releases, root absolute
 * precache paths ignore /ordex base, activate deletes other apps' origin caches, and any same-origin GET
 * outside /api/docs may be cached including gateway data.
 * 1. Generate a build-hashed static-asset manifest under the configured base/scope; precache only validated
 * public static files and versioned search/worker bundles. Never cache authenticated/API/MCP/gateway responses
 * or requests carrying credentials, even when same-origin and response.type is basic.
 * 2. Scope cache ownership with an Ordex/base namespace and delete only obsolete owned caches after a complete
 * install. Respect actual update policy, handle failed precache explicitly and preserve a coherent old release
 * until the new manifest is ready.
 * 3. Make offline navigation fallback route-aware and return valid Response objects. Show which offline
 * capabilities are installed/available rather than claiming the full site works before assets were cached.
 * 4. Coordinate OfflineStatus registration path from import.meta.env.BASE_URL and expose install/update
 * failures. Test fresh install under /ordex and root deployment, offline direct navigation/search/lab,
 * update/rollback, failed asset and coexistence with another app cache; assert API responses are never cache
 * hits.
 * Dependencies: OX-S07 browser worker bundles, OX-S10/11 public routes. PROPOSED NEW tests/e2e/offline.test.js
 * needs real browser service worker lifecycle; component mocks do not verify it. Rollback cache
 * manifest/service worker together and preserve only owned static caches.
 */
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
