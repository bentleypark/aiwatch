// AIWatch Service Worker — stale-while-revalidate for static assets
// Version: bump CACHE_NAME on each deploy that changes static assets

const CACHE_NAME = 'aiwatch-v1'
const STATIC_ASSETS = ['/', '/index.html', '/manifest.json']

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  )
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') return

  const url = event.request.url

  // Always network — never cache these paths
  // /is-*: Edge SSR pages need freshness for SEO
  // /api/*: real-time status data
  if (url.includes('/is-') || url.includes('/api/')) return

  // Only cache same-origin requests
  if (new URL(event.request.url).origin !== self.location.origin) return

  // stale-while-revalidate: serve cache immediately, update in background
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((networkRes) => {
          if (networkRes.ok) {
            const clone = networkRes.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
          }
          return networkRes
        })
        .catch(() => cached || new Response('Offline', { status: 503, statusText: 'Service Unavailable' }))
      return cached || fetchPromise
    })
  )
})
