// #375 — pin the fetch contract so a future API_BASE refactor can't silently
// break the 90d archive merge. Tests target the exported `fetchArchive` helper
// rather than the React hook itself: useEffect/state behavior is exercised
// end-to-end by the Playwright suite (network-request assertion on 90d filter).
//
// Tests intentionally keep `fetch` mocked at the module level since `fetchArchive`
// is a pure function around `fetch` + a process-wide cache. Cache is reset between
// tests via the `_resetArchiveCacheForTests` helper to avoid order-dependent flakes.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchArchive, _resetArchiveCacheForTests } from '../useMonthlyArchives'

describe('fetchArchive (#375)', () => {
  let originalFetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    _resetArchiveCacheForTests()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('returns parsed JSON on 200 OK', async () => {
    const payload = { period: '2026-04', services: { mistral: { incidentList: [] } } }
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload })
    const result = await fetchArchive('2026-04-success')
    expect(result).toEqual(payload)
  })

  it('treats 404 as "archive does not exist" — returns null without throwing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 })
    const result = await fetchArchive('2025-01-not-archived')
    expect(result).toBeNull()
  })

  it('logs and resolves to null on transient HTTP error (5xx)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 502 })
    const result = await fetchArchive('2026-04-502')
    expect(result).toBeNull()
    // Operator-visible signal so a silent failure ("90d merge stopped working")
    // still leaves a console breadcrumb. UI itself degrades to live-only.
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls[0][0]).toContain('2026-04-502')
  })

  it('logs and resolves to null on network error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused'))
    const result = await fetchArchive('2026-04-err')
    expect(result).toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  it('returns the same promise on repeat calls within the same session (cache hit)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ period: '2026-04-cache' }) })
    globalThis.fetch = fetchSpy
    const a = fetchArchive('2026-04-cache-key')
    const b = fetchArchive('2026-04-cache-key')
    expect(a).toBe(b)
    await a
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('purges the cache on rejection so the next call retries (does not pin the failure)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchSpy = vi.fn()
      .mockRejectedValueOnce(new Error('first call fails'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ period: '2026-04-retry' }) })
    globalThis.fetch = fetchSpy
    const first = await fetchArchive('2026-04-retry-key')
    expect(first).toBeNull()
    const second = await fetchArchive('2026-04-retry-key')
    expect(second).toEqual({ period: '2026-04-retry' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
