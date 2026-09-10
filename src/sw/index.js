// AIWatch Service Worker — precache build assets, then network-first for navigations and
// stale-while-revalidate for everything else it caches.
// Cache name is auto-derived from asset-manifest.json version on install.
//
// #1386 — this used to be a hand-written `public/sw.js`. It is now built from source so its two
// decisions can live in `./policy.js` as pure functions and be unit-tested: the SW is registered in
// production only (#432), which puts every line here out of reach of a dev-server e2e.
import { BYPASS, NETWORK_FIRST, routeFor, mayCache } from './policy.js'

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
        // Precached entry by entry, not `addAll`. Two reasons, both consequences of #1386.
        // `addAll` is all-or-nothing AND admits on status alone: one asset that 404s would reject
        // the whole install, drop `activeCacheName` to the 5-entry fallback, and `activate` would
        // then delete the healthy versioned cache — a whole-cache downgrade from one transient
        // fetch. And a 200 that is not what it claims to be would be stored unexamined, which is
        // the one write path `mayCache` would never see.
        return caches.open(activeCacheName).then((cache) =>
          Promise.all(
            [...STATIC_ASSETS, ...manifest.assets].map((url) =>
              fetch(url)
                .then((res) => {
                  // Absolute, because `mayCache` reads the URL's extension and a relative one has
                  // no origin to resolve against.
                  const href = new URL(url, self.location.origin).href
                  return mayCache({ url: href, destination: '' }, res) ? cache.put(url, res) : null
                })
                .catch(() => null)
            )
          )
        )
      })
      .catch(() => {
        // Only reached when the manifest itself is unreadable — an individual asset can no longer
        // get us here.
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

const offline = () => new Response('Offline', { status: 503, statusText: 'Service Unavailable' })

// Never throws and never rejects. Both callers invoke it inside a `.then` whose `.catch` is the
// OFFLINE fallback, so an exception escaping here would be read as "the network failed" and answered
// with a stale cached document — the precise outcome this file exists to prevent. A failed cache
// write must degrade to "not cached", nothing more.
//
// The write is not awaited — the page must not wait on it — and its rejection is handled, since a
// `QuotaExceededError` from `put` would otherwise surface only as an unhandled rejection in the SW's
// own console. It is offered to `event.waitUntil` where the event is still active.
function cacheIfAllowed(event, request, response) {
  let write
  try {
    if (!mayCache(request, response)) return
    // Clone synchronously — the caller returns `response` to the page, which consumes the body.
    const clone = response.clone()
    write = getActiveCacheName()
      .then((name) => caches.open(name))
      .then((c) => c.put(request, clone))
      .catch(() => {})
  } catch {
    return
  }
  try {
    event.waitUntil(write)
  } catch {
    // Throws when the event is no longer active — a stale-while-revalidate cache hit settles
    // `respondWith` before its background revalidation returns, so that write is never held. It
    // still proceeds; it just is not protected from the SW being terminated.
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  const route = routeFor(request, self.location.origin)
  if (route === BYPASS) return

  if (route === NETWORK_FIRST) {
    // Navigations: network wins, cache answers only when the network does not.
    event.respondWith(
      fetch(request)
        .then((networkRes) => {
          cacheIfAllowed(event, request, networkRes)
          return networkRes
        })
        .catch(() =>
          caches
            .match(request)
            .then((cached) => cached || caches.match('/index.html'))
            .then((cached) => cached || offline())
            // A rejecting Cache Storage must still produce a response — `respondWith` on a rejected
            // promise is a network error in the page, which for a navigation is the browser's own
            // error page rather than the app shell.
            .catch(() => offline())
        )
    )
    return
  }

  // stale-while-revalidate: serve cache immediately, update in background
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request)
        .then((networkRes) => {
          cacheIfAllowed(event, request, networkRes)
          return networkRes
        })
        .catch(() => cached || offline())
      return cached || fetchPromise
    })
  )
})
