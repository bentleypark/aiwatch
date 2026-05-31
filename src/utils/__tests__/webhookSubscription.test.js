import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  hashWebhookUrl,
  getLocalSubStatus,
  subscribeWebhook,
  updateWebhookFilters,
  unsubscribeWebhook,
  reconcileSubscription,
} from '../webhookSubscription'

// happy-dom (vitest 4) doesn't expose a usable Storage API, so install an in-memory polyfill —
// same approach as webhookRegistration.test.js / analytics.test.js. crypto.subtle IS available.
function makeLocalStorage() {
  const store = new Map()
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null },
    setItem(k, v) { store.set(String(k), String(v)) },
    removeItem(k) { store.delete(k) },
    clear() { store.clear() },
  }
}

const URL1 = 'https://discord.com/api/webhooks/111/aaa'
const SETTINGS = { alertCondition: 'down', alertTarget: 'all', alertServices: ['claude'], alertIncidents: true }

beforeEach(() => {
  vi.restoreAllMocks()
  vi.stubGlobal('localStorage', makeLocalStorage())
})
afterEach(() => vi.unstubAllGlobals())

// vi.spyOn reuses the existing spy when fetch is already mocked, so a second mockFetch() in the same
// test would keep the FIRST call in .mock.calls[0]. mockReset() clears the call history (and impl)
// before re-applying, so each mockFetch starts fresh and .mock.calls[0] is the next real call.
function mockFetch(status, body) {
  const spy = vi.spyOn(globalThis, 'fetch')
  spy.mockReset()
  spy.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body ?? {},
  })
  return spy
}

describe('hashWebhookUrl', () => {
  it('produces a stable 64-char hex SHA-256, never the raw URL', async () => {
    const h = await hashWebhookUrl(URL1)
    expect(h).toMatch(/^[a-f0-9]{64}$/)
    expect(h).not.toContain(URL1)
    expect(await hashWebhookUrl(URL1)).toBe(h) // deterministic
  })
})

describe('getLocalSubStatus', () => {
  it("defaults to 'none' for an unknown / empty url", async () => {
    expect(await getLocalSubStatus('')).toBe('none')
    expect(await getLocalSubStatus(URL1)).toBe('none')
  })
})

describe('subscribeWebhook', () => {
  it("on success marks the url 'pending' locally and POSTs url+filters", async () => {
    const f = mockFetch(200, { ok: true, hash: 'x', status: 'sent' })
    const res = await subscribeWebhook(URL1, SETTINGS)
    expect(res.ok).toBe(true)
    expect(res.status).toBe('sent')
    expect(await getLocalSubStatus(URL1)).toBe('pending')
    // body carried the raw url + normalized filters
    const body = JSON.parse(f.mock.calls[0][1].body)
    expect(body.url).toBe(URL1)
    expect(body.filters).toEqual(SETTINGS)
    expect(f.mock.calls[0][0]).toContain('/api/webhook/subscribe')
  })
  it("honors an already-confirmed server response (status 'confirmed' → local 'confirmed')", async () => {
    mockFetch(200, { ok: true, hash: 'x', status: 'confirmed' })
    await subscribeWebhook(URL1, SETTINGS)
    expect(await getLocalSubStatus(URL1)).toBe('confirmed')
  })
  it('on failure does not change local status and surfaces the error', async () => {
    mockFetch(403, { error: 'Webhook URL not allowed' })
    const res = await subscribeWebhook(URL1, SETTINGS)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('Webhook URL not allowed')
    expect(await getLocalSubStatus(URL1)).toBe('none')
  })
  it('on network error returns ok:false without throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'))
    const res = await subscribeWebhook(URL1, SETTINGS)
    expect(res.ok).toBe(false)
    expect(await getLocalSubStatus(URL1)).toBe('none')
  })
})

describe('updateWebhookFilters', () => {
  it('POSTs hash (not url) + filters to /update', async () => {
    const f = mockFetch(200, { ok: true })
    const res = await updateWebhookFilters(URL1, SETTINGS)
    expect(res.ok).toBe(true)
    const body = JSON.parse(f.mock.calls[0][1].body)
    expect(body.hash).toBe(await hashWebhookUrl(URL1))
    expect(body.url).toBeUndefined() // URL never sent on update
    expect(body.filters).toEqual(SETTINGS)
    expect(f.mock.calls[0][0]).toContain('/api/webhook/update')
  })
})

describe('unsubscribeWebhook', () => {
  it('POSTs hash to /unsubscribe and clears local status on success', async () => {
    mockFetch(200, { ok: true, status: 'confirmed' })
    await subscribeWebhook(URL1, SETTINGS)
    expect(await getLocalSubStatus(URL1)).toBe('confirmed')

    const f = mockFetch(200, { ok: true })
    const res = await unsubscribeWebhook(URL1)
    expect(res.ok).toBe(true)
    expect(await getLocalSubStatus(URL1)).toBe('none')
    const body = JSON.parse(f.mock.calls[0][1].body)
    expect(body.hash).toBe(await hashWebhookUrl(URL1))
    expect(f.mock.calls[0][0]).toContain('/api/webhook/unsubscribe')
  })
  it('does NOT clear local status when the server delete fails (privacy: no false "removed")', async () => {
    mockFetch(200, { ok: true, status: 'confirmed' })
    await subscribeWebhook(URL1, SETTINGS)
    expect(await getLocalSubStatus(URL1)).toBe('confirmed')

    mockFetch(500, { error: 'kv down' })
    const res = await unsubscribeWebhook(URL1)
    expect(res.ok).toBe(false)
    expect(await getLocalSubStatus(URL1)).toBe('confirmed') // still subscribed — user can retry
  })
})

describe('reconcileSubscription', () => {
  it("returns {ok, status:'confirmed', filtersSynced:true} and pushes filters via /update when the server reports confirmed", async () => {
    // subscribe probe returns confirmed (PR1 short-circuits an already-confirmed channel, no re-send)
    const f = mockFetch(200, { ok: true, status: 'confirmed' })
    expect(await reconcileSubscription(URL1, SETTINGS)).toEqual({ ok: true, status: 'confirmed', filtersSynced: true })
    expect(await getLocalSubStatus(URL1)).toBe('confirmed')
    // two POSTs: subscribe (probe) then update (push filters)
    const paths = f.mock.calls.map((c) => c[0])
    expect(paths.some((p) => p.includes('/api/webhook/subscribe'))).toBe(true)
    expect(paths.some((p) => p.includes('/api/webhook/update'))).toBe(true)
  })
  it("returns filtersSynced:false when confirmed but the deferred /update push fails (caller must surface, not claim in-sync)", async () => {
    // The subscribe probe says confirmed; the follow-up /update fails (e.g. 404 row pruned, or 500).
    // Status is still authoritatively 'confirmed', but filtersSynced=false tells the caller the
    // filter edit did NOT land — so it shows an error instead of a silent "✓ Filters in sync".
    const spy = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, status: 'confirmed' }) }) // subscribe probe
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: 'Subscription not found' }) }) // update fails
    vi.stubGlobal('fetch', spy)
    expect(await reconcileSubscription(URL1, SETTINGS)).toEqual({ ok: true, status: 'confirmed', filtersSynced: false })
  })
  it("returns {ok, status:'pending'} and does NOT push filters when still unconfirmed server-side", async () => {
    const f = mockFetch(200, { ok: true, status: 'pending' })
    expect(await reconcileSubscription(URL1, SETTINGS)).toEqual({ ok: true, status: 'pending' })
    expect(f.mock.calls.every((c) => !c[0].includes('/api/webhook/update'))).toBe(true)
  })
  it('returns {ok:false} on a failed probe — does NOT report a status, so the caller keeps pending', async () => {
    mockFetch(500, { error: 'kv down' })
    const res = await reconcileSubscription(URL1, SETTINGS)
    expect(res.ok).toBe(false)
    expect(res.status).toBeUndefined() // crucially: no status → caller won't flip pending → none
  })
  it('returns {ok:false} for an empty url without calling fetch', async () => {
    const f = mockFetch(200, { ok: true, status: 'confirmed' })
    expect((await reconcileSubscription('', SETTINGS)).ok).toBe(false)
    expect(f).not.toHaveBeenCalled()
  })
})
