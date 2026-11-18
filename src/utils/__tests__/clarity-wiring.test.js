import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../clarity.js', () => ({ initClarity: vi.fn(), clearClarityCookies: vi.fn() }))

let analytics
let clarity

function makeLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial))
  return { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
}

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('VITE_GA4_ID', '')
  clarity = await import('../clarity.js')
  vi.mocked(clarity.initClarity).mockClear()
  vi.mocked(clarity.clearClarityCookies).mockClear()
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

async function load(consent) {
  vi.stubGlobal('localStorage', makeLocalStorage(consent === null ? {} : { 'aiwatch-cookie-consent': consent }))
  analytics = await import('../analytics.js')
}

describe('Clarity call sites in analytics.js (#2024)', () => {
  test.each([['granted'], ['denied'], [null]])('boot passes the stored consent (%s) to initClarity, even with no GA4 id', async (consent) => {
    await load(consent)
    analytics.initConsentDefault()
    expect(clarity.initClarity).toHaveBeenCalledWith(consent)
  })

  test('banner Accept loads Clarity', async () => {
    await load(null)
    analytics.setConsent(true)
    expect(clarity.initClarity).toHaveBeenCalledWith('granted')
    expect(clarity.clearClarityCookies).not.toHaveBeenCalled()
  })

  test('banner Essential Only clears Clarity cookies and does not load it', async () => {
    await load(null)
    analytics.setConsent(false)
    expect(clarity.clearClarityCookies).toHaveBeenCalled()
    expect(clarity.initClarity).not.toHaveBeenCalled()
  })
})
