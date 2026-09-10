import { describe, it, expect } from 'vitest'
import { BYPASS, NETWORK_FIRST, STALE_WHILE_REVALIDATE, routeFor, mayCache } from '../policy.js'

const ORIGIN = 'https://ai-watch.dev'

// Only the fields the SW actually reads. The real Request carries the same ones.
const req = (url, { method = 'GET', mode = 'no-cors', destination = '' } = {}) => ({
  method,
  url: url.startsWith('http') ? url : ORIGIN + url,
  mode,
  destination,
})

const res = (contentType, { ok = true, type = 'basic' } = {}) => ({
  ok,
  type,
  headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
})

describe('routeFor', () => {
  it('bypasses non-GET requests', () => {
    expect(routeFor(req('/', { method: 'POST', mode: 'navigate' }), ORIGIN)).toBe(BYPASS)
  })

  it('bypasses cross-origin requests', () => {
    expect(routeFor(req('https://api.github.com/repos/x/y'), ORIGIN)).toBe(BYPASS)
  })

  it.each(['/is-claude-down', '/api/status', '/reports/2026-03/'])(
    'bypasses the always-network path %s',
    (path) => {
      expect(routeFor(req(path, { mode: 'navigate' }), ORIGIN)).toBe(BYPASS)
    }
  )

  // The regression this fix exists for: served cache-first, the document names asset hashes from a
  // build that no longer exists, and the page renders blank.
  it('sends navigations to the network first', () => {
    expect(routeFor(req('/', { mode: 'navigate', destination: 'document' }), ORIGIN)).toBe(NETWORK_FIRST)
  })

  // Deliberate, not an oversight: a chunk whose name contains one of the never-cache prefixes is
  // handed to the network. Over-bypass costs a cache entry; it can never cache the wrong thing.
  it('over-bypasses an asset whose name contains a never-cache prefix', () => {
    expect(routeFor(req('/assets/reports-BLrweZ9s.js', { destination: 'script' }), ORIGIN)).toBe(BYPASS)
  })

  it('revalidates hashed assets in the background', () => {
    expect(routeFor(req('/assets/index-D_6fVe87.js', { destination: 'script' }), ORIGIN)).toBe(
      STALE_WHILE_REVALIDATE
    )
    expect(routeFor(req('/assets/index-Du56x5t1.css', { destination: 'style' }), ORIGIN)).toBe(
      STALE_WHILE_REVALIDATE
    )
  })
})

describe('mayCache', () => {
  // #1386 — vercel.json's SPA catch-all answers a deleted build asset with index.html at HTTP 200.
  // Caching that under the script URL is what turns one bad load into a permanently blank page:
  // the next load never reaches the network and replays the HTML as the module script.
  it('refuses HTML served under a script request', () => {
    expect(mayCache(req('/assets/index-old.js', { destination: 'script' }), res('text/html; charset=utf-8'))).toBe(false)
  })

  it('refuses HTML served under a stylesheet request', () => {
    expect(mayCache(req('/assets/index-old.css', { destination: 'style' }), res('text/html; charset=utf-8'))).toBe(false)
  })

  it('caches a real script', () => {
    expect(mayCache(req('/assets/index-new.js', { destination: 'script' }), res('application/javascript; charset=utf-8'))).toBe(true)
    expect(mayCache(req('/assets/index-new.js', { destination: 'script' }), res('text/javascript'))).toBe(true)
  })

  it('caches a real stylesheet and a real document', () => {
    expect(mayCache(req('/assets/index-new.css', { destination: 'style' }), res('text/css'))).toBe(true)
    expect(mayCache(req('/', { destination: 'document' }), res('text/html; charset=utf-8'))).toBe(true)
  })

  it('constrains nothing for destinations with no strict MIME check', () => {
    expect(mayCache(req('/favicon.png', { destination: 'image' }), res('image/png'))).toBe(true)
    expect(mayCache(req('/asset-manifest.json', { destination: '' }), res('application/json'))).toBe(true)
  })

  it('constrains a worker script, which browsers MIME-check like any other script', () => {
    expect(mayCache(req('/w.js', { destination: 'worker' }), res('text/html'))).toBe(false)
    expect(mayCache(req('/w.js', { destination: 'worker' }), res('text/javascript'))).toBe(true)
  })

  // `destination` is the one input this guard cannot verify. An unrecognised value must not fall
  // through to the unconstrained path for a URL that plainly names a build asset — that would
  // restore the pre-#1386 status-only rule silently, on that browser only.
  it('falls back to the URL when the destination is unrecognised', () => {
    expect(mayCache(req('/assets/index-old.js', { destination: 'nonsense' }), res('text/html'))).toBe(false)
    expect(mayCache(req('/assets/index-old.css', { destination: '' }), res('text/html'))).toBe(false)
    expect(mayCache(req('/assets/index-new.mjs', { destination: '' }), res('text/javascript'))).toBe(true)
  })

  it('refuses a script response that declares no content-type', () => {
    expect(mayCache(req('/assets/index-new.js', { destination: 'script' }), res(null))).toBe(false)
  })

  it('refuses a non-ok response', () => {
    expect(mayCache(req('/assets/index-new.js', { destination: 'script' }), res('text/javascript', { ok: false }))).toBe(false)
  })

  it('refuses an opaque response', () => {
    expect(mayCache(req('/assets/index-new.js', { destination: 'script' }), res('text/javascript', { type: 'opaque' }))).toBe(false)
  })
})
