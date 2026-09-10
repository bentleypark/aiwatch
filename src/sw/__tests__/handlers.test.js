// #1386 — the SW's fetch handler, driven against stub globals.
//
// `policy.test.js` proves the two decisions are right. This file proves the handlers ASK them — a
// green pure function is not a green call site (#966/#1268). Each of the three write paths
// (navigation, stale-while-revalidate, install precache) has a case that fails when its
// `mayCache` gate is removed or its call site is deleted.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const ORIGIN = 'https://ai-watch.dev'

// A Cache Storage stub backed by a Map. `openDelay` defers `open()` past the current microtask so a
// `clone()` moved out of the synchronous path would throw "body already used" here, as it does in a
// browser — the invariant `index.js` documents but nothing enforced.
function makeCaches({ openDelay = 0 } = {}) {
  const stores = new Map()
  // A real Cache resolves a relative string key against the SW scope; the handler's offline fallback
  // asks for the bare string '/index.html', so a stub that keyed on the raw string would report a
  // miss the browser would not.
  const key = (req) => new URL(typeof req === 'string' ? req : req.url, ORIGIN).href
  const open = vi.fn(async (name) => {
    if (openDelay) await new Promise((r) => setTimeout(r, openDelay))
    if (!stores.has(name)) stores.set(name, new Map())
    const store = stores.get(name)
    return {
      put: vi.fn(async (req, res) => {
        // A real Cache reads the body here; a consumed one rejects — which is what makes the
        // clone-placement test above a real assertion. What is stored is a fresh response over the
        // same text, so a later read of the cache entry is not competing with this one.
        const body = await res.text()
        store.set(key(req), response(body, res.headers.get('content-type')))
      }),
      addAll: vi.fn(async () => {}),
      match: vi.fn(async (req) => store.get(key(req))),
    }
  })
  return {
    stores,
    api: {
      open,
      keys: vi.fn(async () => [...stores.keys()]),
      delete: vi.fn(async (k) => stores.delete(k)),
      match: vi.fn(async (req) => {
        const url = key(req)
        for (const store of stores.values()) if (store.has(url)) return store.get(url)
        return undefined
      }),
    },
  }
}

// Minimal stand-ins for Request/Response — only the members the handler touches.
const request = (url, { method = 'GET', mode = 'no-cors', destination = '' } = {}) => ({
  method,
  url: url.startsWith('http') ? url : ORIGIN + url,
  mode,
  destination,
})

function response(body, contentType, { ok = true, type = 'basic' } = {}) {
  let used = false
  const res = {
    ok,
    type,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    async text() {
      if (used) throw new TypeError('body already used')
      used = true
      return body
    },
    async json() {
      return JSON.parse(await res.text())
    },
    // Throws once the body has been read, like the real thing — which is what makes the
    // clone-placement test an assertion rather than a name.
    clone() {
      if (used) throw new TypeError('Response body is already used')
      return response(body, contentType, { ok, type })
    },
    body,
  }
  return res
}

async function loadHandlers(cachesApi) {
  const listeners = {}
  vi.stubGlobal('self', {
    addEventListener: (type, fn) => { listeners[type] = fn },
    location: { origin: ORIGIN },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
  })
  vi.stubGlobal('caches', cachesApi)
  vi.resetModules()
  await import('../index.js')
  return listeners
}

// Drives one fetch event and resolves to whatever the handler answered with, or `null` when it
// declined to respond (the bypass path).
async function dispatch(onFetch, req) {
  let responded = null
  onFetch({ request: req, respondWith: (p) => { responded = p }, waitUntil: () => {} })
  return responded === null ? null : await responded
}

// Lets the un-awaited cache write inside `cacheIfAllowed` settle before assertions.
const settle = () => new Promise((r) => setTimeout(r, 5))

// Runs the install listener to completion by awaiting whatever it hands to `waitUntil`.
async function install(onInstall) {
  const held = []
  onInstall({ waitUntil: (p) => held.push(p) })
  await Promise.all(held)
}

describe('install handler', () => {
  let cachesStub

  beforeEach(() => {
    vi.unstubAllGlobals()
    cachesStub = makeCaches()
  })

  // Serves the manifest, then whatever `bodies` says for each asset URL.
  const server = (assets, bodies) =>
    vi.fn(async (url) => {
      if (url === '/asset-manifest.json') {
        return response(JSON.stringify({ version: 'abc12345', assets }), 'application/json')
      }
      const entry = bodies[url]
      if (!entry) return response('', 'text/plain', { ok: false })
      return response(entry.body, entry.type)
    })

  it('precaches the manifest assets into the versioned cache', async () => {
    const { install: onInstall } = await loadHandlers(cachesStub.api)
    vi.stubGlobal('fetch', server(['/assets/a.js'], { '/assets/a.js': { body: 'export{}', type: 'text/javascript' } }))

    await install(onInstall)

    expect(cachesStub.stores.has('aiwatch-abc12345')).toBe(true)
    expect(await cachesStub.api.match('/assets/a.js')).toBeTruthy()
  })

  // The precache is the one write path `mayCache` would never see if it used `addAll`, which admits
  // on status alone — the same rule that produced #1386 on the fetch path.
  it('refuses a manifest asset the server answers with HTML', async () => {
    const { install: onInstall } = await loadHandlers(cachesStub.api)
    vi.stubGlobal('fetch', server(['/assets/a.js'], { '/assets/a.js': { body: '<!doctype html>', type: 'text/html' } }))

    await install(onInstall)

    expect(await cachesStub.api.match('/assets/a.js')).toBeUndefined()
  })

  // `addAll` is all-or-nothing: one 404 would reject install, drop `activeCacheName` to the
  // 5-entry fallback, and `activate` would then delete the healthy versioned cache.
  it('keeps the versioned cache when a single asset fails', async () => {
    const { install: onInstall } = await loadHandlers(cachesStub.api)
    vi.stubGlobal('fetch', server(['/assets/a.js', '/assets/gone.js'], {
      '/assets/a.js': { body: 'export{}', type: 'text/javascript' },
    }))

    await install(onInstall)

    expect(cachesStub.stores.has('aiwatch-abc12345')).toBe(true)
    expect(cachesStub.stores.has('aiwatch-static-v1')).toBe(false)
    expect(await cachesStub.api.match('/assets/a.js')).toBeTruthy()
    expect(await cachesStub.api.match('/assets/gone.js')).toBeUndefined()
  })

  it('falls back to the static cache only when the manifest itself is unreadable', async () => {
    const { install: onInstall } = await loadHandlers(cachesStub.api)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))

    await install(onInstall)

    expect(cachesStub.stores.has('aiwatch-static-v1')).toBe(true)
  })
})

describe('fetch handler', () => {
  let cachesStub

  beforeEach(() => {
    vi.unstubAllGlobals()
    cachesStub = makeCaches()
  })

  it('declines to respond on a bypassed path, leaving it to the network', async () => {
    const { fetch: onFetch } = await loadHandlers(cachesStub.api)
    vi.stubGlobal('fetch', vi.fn())
    expect(await dispatch(onFetch, request('/api/status'))).toBeNull()
  })

  // The defect. Under the old handler this HTML was written under the script URL.
  it('does not cache HTML answered under a script request', async () => {
    const { fetch: onFetch } = await loadHandlers(cachesStub.api)
    const html = response('<!doctype html>', 'text/html; charset=utf-8')
    vi.stubGlobal('fetch', vi.fn(async () => html))

    await dispatch(onFetch, request('/assets/index-old.js', { destination: 'script' }))
    await settle()

    expect(await cachesStub.api.match(request('/assets/index-old.js'))).toBeUndefined()
  })

  it('caches a real script answered under a script request', async () => {
    const { fetch: onFetch } = await loadHandlers(cachesStub.api)
    vi.stubGlobal('fetch', vi.fn(async () => response('export{}', 'text/javascript')))

    await dispatch(onFetch, request('/assets/index-new.js', { destination: 'script' }))
    await settle()

    expect(await cachesStub.api.match(request('/assets/index-new.js'))).toBeTruthy()
  })

  // The clone must be taken synchronously, before `caches.open` resolves.
  it('clones before the cache opens, so the page still gets a readable body', async () => {
    const slow = makeCaches({ openDelay: 5 })
    const { fetch: onFetch } = await loadHandlers(slow.api)
    vi.stubGlobal('fetch', vi.fn(async () => response('export{}', 'text/javascript')))

    const res = await dispatch(onFetch, request('/assets/index-new.js', { destination: 'script' }))
    await expect(res.text()).resolves.toBe('export{}') // the page's copy is untouched
    await settle()
    await new Promise((r) => setTimeout(r, 10))
    expect(await slow.api.match(request('/assets/index-new.js'))).toBeTruthy()
  })

  describe('navigations', () => {
    const nav = () => request('/', { mode: 'navigate', destination: 'document' })

    it('answers from the network even when a cached document exists', async () => {
      const { fetch: onFetch } = await loadHandlers(cachesStub.api)
      const cache = await cachesStub.api.open('aiwatch-old')
      await cache.put(nav(), response('STALE', 'text/html'))
      vi.stubGlobal('fetch', vi.fn(async () => response('FRESH', 'text/html')))

      const res = await dispatch(onFetch, nav())
      expect(await res.text()).toBe('FRESH')
    })

    // The navigation branch has its own `cacheIfAllowed` call; without a case here, deleting it
    // left every suite green.
    it('caches the document it fetched, so the app shell survives going offline', async () => {
      const { fetch: onFetch } = await loadHandlers(cachesStub.api)
      vi.stubGlobal('fetch', vi.fn(async () => response('FRESH', 'text/html')))

      await dispatch(onFetch, nav())
      await settle()

      expect(await cachesStub.api.match(nav())).toBeTruthy()
    })

    it('does not cache a document answered with the wrong type', async () => {
      const { fetch: onFetch } = await loadHandlers(cachesStub.api)
      vi.stubGlobal('fetch', vi.fn(async () => response('not html', 'application/json')))

      await dispatch(onFetch, nav())
      await settle()

      expect(await cachesStub.api.match(nav())).toBeUndefined()
    })

    it('falls back to the cached document when the network fails', async () => {
      const { fetch: onFetch } = await loadHandlers(cachesStub.api)
      const cache = await cachesStub.api.open('aiwatch-old')
      await cache.put(nav(), response('CACHED SHELL', 'text/html'))
      expect(await cachesStub.api.match(nav())).toBeTruthy() // the stub really seeded
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))

      const res = await dispatch(onFetch, nav())
      expect(await res.text()).toBe('CACHED SHELL')
    })

    it('falls back to the precached /index.html when the request itself is not cached', async () => {
      const { fetch: onFetch } = await loadHandlers(cachesStub.api)
      const cache = await cachesStub.api.open('aiwatch-old')
      await cache.put(ORIGIN + '/index.html', response('APP SHELL', 'text/html'))
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))

      const res = await dispatch(onFetch, request('/deep-link', { mode: 'navigate', destination: 'document' }))
      expect(await res.text()).toBe('APP SHELL')
    })

    it('answers 503 offline when nothing is cached at all', async () => {
      const { fetch: onFetch } = await loadHandlers(cachesStub.api)
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))

      const res = await dispatch(onFetch, nav())
      expect(res.status).toBe(503)
    })
  })
})
