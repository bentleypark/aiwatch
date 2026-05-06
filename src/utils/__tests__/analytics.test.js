import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

// happy-dom doesn't expose a usable Storage API in vitest 4's environment integration,
// so we install a minimal in-memory polyfill on window.localStorage. Same shape as the
// browser API: getItem/setItem/removeItem/clear/length/key.
function makeLocalStorage() {
  const store = new Map()
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null },
    setItem(k, v) { store.set(String(k), String(v)) },
    removeItem(k) { store.delete(k) },
    clear() { store.clear() },
    get length() { return store.size },
    key(i) { return Array.from(store.keys())[i] ?? null },
  }
}

// `IS_ENABLED` is captured from `import.meta.env.VITE_GA4_ID` at module evaluation time.
// We stub the env and reset module cache in beforeEach so each test runs against a fresh
// import of analytics.js with `IS_ENABLED === true`.
let analytics

function clearCookies() {
  document.cookie.split(';').forEach((c) => {
    const name = c.split('=')[0].trim()
    if (!name) return
    document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`
  })
}

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('VITE_GA4_ID', 'G-TESTONLY')
  vi.stubGlobal('localStorage', makeLocalStorage())
  clearCookies()
  delete window.gtag
  delete window.dataLayer
  analytics = await import('../analytics.js')
})

afterEach(() => {
  // Don't let stubbed globals/env leak into other test files in the same vitest worker.
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('setConsent(false) — banner Essential Only', () => {
  test('writes "denied" to localStorage', () => {
    analytics.setConsent(false)
    expect(localStorage.getItem('aiwatch-cookie-consent')).toBe('denied')
  })

  test('calls window.gtag with all four denied signals (Privacy Policy "Advertising" section contract)', () => {
    window.gtag = vi.fn()
    analytics.setConsent(false)
    expect(window.gtag).toHaveBeenCalledWith('consent', 'update', {
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    })
  })

  test('removes _ga / _gid / _gcl_au cookies', () => {
    document.cookie = '_ga=GA1.1.foo; path=/'
    document.cookie = '_gid=GA1.1.bar; path=/'
    document.cookie = '_gcl_au=1.1.baz; path=/'
    expect(document.cookie).toContain('_ga=')
    analytics.setConsent(false)
    expect(document.cookie).not.toContain('_ga=GA1')
    expect(document.cookie).not.toContain('_gid=GA1')
    expect(document.cookie).not.toContain('_gcl_au=1.1')
  })

  test('does not throw when localStorage.setItem is unavailable', () => {
    vi.stubGlobal('localStorage', {
      ...makeLocalStorage(),
      setItem() { throw new Error('quota') },
    })
    expect(() => analytics.setConsent(false)).not.toThrow()
  })
})

describe('setConsent(true) — Accept-failure gating (#352, mirrors inline banner)', () => {
  test('does NOT call initGA when localStorage.setItem throws', () => {
    vi.stubGlobal('localStorage', {
      ...makeLocalStorage(),
      setItem() { throw new Error('quota') },
    })
    // Spy on script-tag injection — initGA() appends a <script src="googletagmanager"> tag.
    const before = document.querySelectorAll('script[src*="googletagmanager"]').length
    analytics.setConsent(true)
    const after = document.querySelectorAll('script[src*="googletagmanager"]').length
    expect(after, 'initGA must NOT inject gtag.js when consent persistence failed').toBe(before)
  })

  test('DOES call initGA when localStorage.setItem succeeds', () => {
    window.gtag = vi.fn() // initGA calls gtag('consent','update',{...granted}) — stub it
    const before = document.querySelectorAll('script[src*="googletagmanager"]').length
    analytics.setConsent(true)
    const after = document.querySelectorAll('script[src*="googletagmanager"]').length
    expect(after).toBeGreaterThan(before)
  })

  test('returns false when Accept persistence fails so the banner can stay visible', () => {
    vi.stubGlobal('localStorage', {
      ...makeLocalStorage(),
      setItem() { throw new Error('quota') },
    })
    expect(analytics.setConsent(true)).toBe(false)
  })

  test('returns true when Accept persists successfully', () => {
    window.gtag = vi.fn()
    expect(analytics.setConsent(true)).toBe(true)
  })

  test('returns true on Essential-Only even when setItem throws (default-deny is safe)', () => {
    vi.stubGlobal('localStorage', {
      ...makeLocalStorage(),
      setItem() { throw new Error('quota') },
    })
    expect(analytics.setConsent(false)).toBe(true)
  })
})

describe('initConsentDefault() — boot reconciliation', () => {
  test('queues consent default with all four denied signals', () => {
    analytics.initConsentDefault()
    expect(window.dataLayer).toBeDefined()
    const consentCall = window.dataLayer.find(
      (args) => args[0] === 'consent' && args[1] === 'default'
    )
    expect(consentCall).toBeDefined()
    expect(consentCall[2]).toEqual({
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    })
  })

  test('clears stale cookies when consent is already "denied" in localStorage (manual revoke path)', () => {
    localStorage.setItem('aiwatch-cookie-consent', 'denied')
    document.cookie = '_ga=GA1.1.stale; path=/'
    document.cookie = '_gcl_au=1.1.stale; path=/'
    analytics.initConsentDefault()
    expect(document.cookie).not.toContain('_ga=GA1')
    expect(document.cookie).not.toContain('_gcl_au=1.1')
  })

  test('does NOT clear cookies when consent is "granted" (user accepted, cookies are theirs to keep)', () => {
    localStorage.setItem('aiwatch-cookie-consent', 'granted')
    document.cookie = '_ga=GA1.1.kept; path=/'
    analytics.initConsentDefault()
    expect(document.cookie).toContain('_ga=GA1')
  })

  test('does NOT clear cookies when consent key is absent (first visit — banner will handle)', () => {
    document.cookie = '_ga=GA1.1.firstvisit; path=/'
    analytics.initConsentDefault()
    expect(document.cookie).toContain('_ga=GA1')
  })
})

describe('hasConsent()', () => {
  test('returns null when key is absent', () => {
    expect(analytics.hasConsent()).toBe(null)
  })

  test('returns "granted" / "denied" round-trip via setConsent', () => {
    // setConsent(true) calls initGA → window.gtag(...). Stub gtag so the chain doesn't
    // throw; we only assert localStorage round-trip here.
    window.gtag = vi.fn()
    analytics.setConsent(true)
    expect(analytics.hasConsent()).toBe('granted')
    analytics.setConsent(false)
    expect(analytics.hasConsent()).toBe('denied')
  })

  test('does not throw when localStorage.getItem is unavailable', () => {
    vi.stubGlobal('localStorage', {
      ...makeLocalStorage(),
      getItem() { throw new Error('disabled') },
    })
    expect(() => analytics.hasConsent()).not.toThrow()
    expect(analytics.hasConsent()).toBe(null)
  })
})
