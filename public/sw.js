// AIWatch Service Worker — precache build assets + stale-while-revalidate
// Cache name is auto-derived from asset-manifest.json version on install

const STATIC_ASSETS = ['/', '/index.html', '/manifest.json', '/favicon.png', '/asset-manifest.json']
const FALLBACK_CACHE = 'aiwatch-static-v1'

// Module-scoped variable set during install to avoid re-fetching manifest
let activeCacheName = null

self.addEventListener('install', (e) => {
  e.waitUntil(
    fetch('/asset-manifest.json')
      .then((res) => res.json())
      .then((manifest) => {
        activeCacheName = 'aiwatch-' + manifest.version
        return caches.open(activeCacheName).then((cache) =>
          cache.addAll([...STATIC_ASSETS, ...manifest.assets])
        )
      })
      .catch(() => {
        activeCacheName = FALLBACK_CACHE
        return caches.open(FALLBACK_CACHE).then((cache) => cache.addAll(STATIC_ASSETS))
      })
  )
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      // Keep the newest aiwatch-* cache (the one just installed)
      const aiwatchCaches = keys.filter((k) => k.startsWith('aiwatch-')).sort()
      const keep = activeCacheName || aiwatchCaches[aiwatchCaches.length - 1] || FALLBACK_CACHE
      return Promise.all(
        keys.filter((k) => k !== keep).map((k) => caches.delete(k))
      )
    })
  )
  self.clients.claim()
})

// Find the active aiwatch cache name from existing caches
async function getActiveCacheName() {
  if (activeCacheName) return activeCacheName
  const keys = await caches.keys()
  const aiwatchCaches = keys.filter((k) => k.startsWith('aiwatch-')).sort()
  return aiwatchCaches[aiwatchCaches.length - 1] || FALLBACK_CACHE
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return

  const url = event.request.url

  // Always network — never cache these paths
  if (url.includes('/is-') || url.includes('/api/')) return

  // Only cache same-origin requests
  if (new URL(url).origin !== self.location.origin) return

  // stale-while-revalidate: serve cache immediately, update in background
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((networkRes) => {
          if (networkRes.ok) {
            const clone = networkRes.clone()
            getActiveCacheName().then((name) =>
              caches.open(name).then((c) => c.put(event.request, clone))
            )
          }
          return networkRes
        })
        .catch(() => cached || new Response('Offline', { status: 503, statusText: 'Service Unavailable' }))
      return cached || fetchPromise
    })
  )
})
