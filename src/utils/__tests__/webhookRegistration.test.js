import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { refreshWebhookRegistration } from '../webhookRegistration'

// happy-dom doesn't expose a usable Storage API under vitest 4, so install an in-memory
// polyfill (same approach as analytics.test.js / webhookAlerts.test.js).
function makeLocalStorage() {
  const store = new Map()
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null },
    setItem(k, v) { store.set(String(k), String(v)) },
    removeItem(k) { store.delete(k) },
    clear() { store.clear() },
  }
}

// refreshWebhookRegistration is fire-and-forget over an async hash (crypto.subtle), so let the
// microtask/timer queue drain before asserting on the fetch spy.
const flush = () => new Promise((r) => setTimeout(r, 20))

const URL_A = 'https://discord.com/api/webhooks/111/aaa'
const URL_B = 'https://discord.com/api/webhooks/222/bbb'

describe('refreshWebhookRegistration — 24h throttle (#467 KV write budget)', () => {
  let nowValue
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal('localStorage', makeLocalStorage())
    nowValue = Date.parse('2026-05-28T00:00:00.000Z')
    vi.spyOn(Date, 'now').mockImplementation(() => nowValue)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('no-ops when no URL is given', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    refreshWebhookRegistration('', 'discord')
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POSTs on the first refresh for a webhook', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    refreshWebhookRegistration(URL_A, 'discord')
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/webhook\/ping$/)
    expect(JSON.parse(opts.body).type).toBe('discord')
  })

  it('skips a second refresh of the same webhook within 24h', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    refreshWebhookRegistration(URL_A, 'discord')
    await flush()
    nowValue += 23 * 60 * 60_000 // +23h, still inside the window
    refreshWebhookRegistration(URL_A, 'discord')
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes again once more than 24h has passed', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    refreshWebhookRegistration(URL_A, 'discord')
    await flush()
    nowValue += 25 * 60 * 60_000 // +25h, window expired
    refreshWebhookRegistration(URL_A, 'discord')
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('always refreshes a changed URL (different hash) even within 24h', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    refreshWebhookRegistration(URL_A, 'discord')
    await flush()
    refreshWebhookRegistration(URL_B, 'discord') // different hash, same instant
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
