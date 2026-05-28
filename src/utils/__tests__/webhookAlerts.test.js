import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  shouldRelay,
  selectFeedEntriesToRelay,
  runWebhookAlerts,
  __resetRelayFirstRun,
} from '../webhookAlerts'
import { SETTINGS_STORAGE_KEY } from '../constants'

function makeLocalStorage() {
  const store = {}
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] },
    clear: () => { for (const k of Object.keys(store)) delete store[k] },
  }
}

// A canonical feed entry as the worker would emit it (alert-feed.ts AlertFeedEntry shape).
const entry = (over = {}) => ({
  key: 'alerted:new:inc1',
  kind: 'new',
  svcIds: ['claude'],
  embed: { title: '🔴 Claude — New Incident', description: 'API errors', color: 0xED4245 },
  ts: 1000,
  ...over,
})

const baseSettings = { alertCondition: 'all', alertTarget: 'all', alertServices: [], alertIncidents: true }

// Relayed-key marking now happens in the delivery .then (mark-on-success), so flush microtasks +
// the macrotask queue before the next poll to let it persist.
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('shouldRelay', () => {
  it('incident kinds gated by alertIncidents', () => {
    expect(shouldRelay(entry({ kind: 'new' }), baseSettings)).toBe(true)
    expect(shouldRelay(entry({ kind: 'resolved' }), baseSettings)).toBe(true)
    expect(shouldRelay(entry({ kind: 'new' }), { ...baseSettings, alertIncidents: false })).toBe(false)
    expect(shouldRelay(entry({ kind: 'resolved' }), { ...baseSettings, alertIncidents: false })).toBe(false)
  })

  it("alertCondition 'all' relays every status kind", () => {
    for (const kind of ['down', 'degraded', 'recovered']) {
      expect(shouldRelay(entry({ kind }), { ...baseSettings, alertCondition: 'all' })).toBe(true)
    }
  })

  it("alertCondition 'down' relays down + recovered but skips degraded", () => {
    const s = { ...baseSettings, alertCondition: 'down' }
    expect(shouldRelay(entry({ kind: 'down' }), s)).toBe(true)
    expect(shouldRelay(entry({ kind: 'recovered' }), s)).toBe(true)
    expect(shouldRelay(entry({ kind: 'degraded' }), s)).toBe(false)
  })

  it("alertTarget 'custom' requires an overlap with alertServices", () => {
    const s = { ...baseSettings, alertTarget: 'custom', alertServices: ['openai'] }
    expect(shouldRelay(entry({ svcIds: ['claude'] }), s)).toBe(false)
    expect(shouldRelay(entry({ svcIds: ['openai'] }), s)).toBe(true)
    expect(shouldRelay(entry({ svcIds: ['claude', 'openai'] }), s)).toBe(true)
  })

  it('never relays an unknown kind', () => {
    expect(shouldRelay(entry({ kind: 'weird' }), baseSettings)).toBe(false)
  })
})

describe('selectFeedEntriesToRelay', () => {
  it('relays entries not yet relayed at this-or-newer ts', () => {
    const feed = [entry({ key: 'a', ts: 1000 }), entry({ key: 'b', ts: 2000 })]
    expect(selectFeedEntriesToRelay(feed, baseSettings, {}).map((e) => e.key)).toEqual(['a', 'b'])
    // 'a' already relayed at 1000 → skip; 'b' unseen → relay
    expect(selectFeedEntriesToRelay(feed, baseSettings, { a: 1000 }).map((e) => e.key)).toEqual(['b'])
  })

  it('re-relays a re-fired alert (same key, newer ts)', () => {
    const feed = [entry({ key: 'a', ts: 5000 })]
    expect(selectFeedEntriesToRelay(feed, baseSettings, { a: 1000 }).map((e) => e.key)).toEqual(['a'])
  })

  it('applies the per-user filter', () => {
    const feed = [entry({ key: 'd', kind: 'degraded', svcIds: ['claude'] })]
    expect(selectFeedEntriesToRelay(feed, { ...baseSettings, alertCondition: 'down' }, {})).toEqual([])
  })

  it('skips malformed entries (missing key/embed, non-finite ts, partial embed)', () => {
    const feed = [
      { key: 'x', ts: 1 },                                          // no embed
      { embed: { title: 't', description: 'd', color: 1 }, ts: 1 }, // no key
      entry({ key: 'nan', ts: NaN }),                               // non-finite ts (would throw in new Date)
      entry({ key: 'partial', embed: { title: 't' } }),            // missing description/color
      null,
      entry({ key: 'ok' }),
    ]
    expect(selectFeedEntriesToRelay(feed, baseSettings, {}).map((e) => e.key)).toEqual(['ok'])
  })
})

describe('runWebhookAlerts (relay dispatch — Discord only)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal('localStorage', makeLocalStorage())
    __resetRelayFirstRun()
  })

  const withSettings = (extra = {}) => localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
    discordUrl: 'https://discord.com/api/webhooks/x/y', ...baseSettings, ...extra,
  }))

  it('no-ops (no fetch) when no Discord webhook is configured', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(baseSettings))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    runWebhookAlerts([entry()])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('baselines the backlog on the first poll (no send), then relays new entries', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    // Realistic ts (near wall clock) so the relayed-map prune in writeRelayed keeps them.
    const t0 = Date.now()
    // First poll: entry already in the feed (fired while tab was closed) → baselined, not sent.
    runWebhookAlerts([entry({ key: 'a', ts: t0 })])
    expect(fetchMock).not.toHaveBeenCalled()
    // Next poll: a NEW entry appears → relayed.
    runWebhookAlerts([entry({ key: 'a', ts: t0 }), entry({ key: 'b', ts: t0 + 1000 })])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).payload.embeds[0].title).toContain('New Incident')
  })

  it('relays the worker embed verbatim with footer + ts timestamp', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    runWebhookAlerts([]) // baseline (empty)
    runWebhookAlerts([entry({ key: 'a', ts: 1700000000000, embed: { title: 'T', description: 'D', color: 7 } })])
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/alert$/)
    const body = JSON.parse(opts.body)
    expect(body.channel).toBe('discord')
    expect(body.webhookUrl).toBe('https://discord.com/api/webhooks/x/y')
    expect(body.payload.embeds[0]).toMatchObject({
      title: 'T', description: 'D', color: 7,
      footer: { text: 'AIWatch' },
      timestamp: new Date(1700000000000).toISOString(),
    })
  })

  it('does not re-relay an entry already relayed (cross-poll dedup)', async () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    const t0 = Date.now()
    runWebhookAlerts([]) // baseline
    runWebhookAlerts([entry({ key: 'a', ts: t0 })])
    await flush() // let the success .then mark relayed + persist
    runWebhookAlerts([entry({ key: 'a', ts: t0 })])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('re-relays a re-fired alert (same key, newer ts) once the first was confirmed', async () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    const t0 = Date.now()
    runWebhookAlerts([]) // baseline
    runWebhookAlerts([entry({ key: 'a', ts: t0 })])
    await flush()
    // Operator 2h status-dedup expired → new cron ts → must relay again.
    runWebhookAlerts([entry({ key: 'a', ts: t0 + 60_000 })])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT mark relayed on a failed delivery → retries on the next poll (at-least-once)', async () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 429 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t0 = Date.now()
    runWebhookAlerts([]) // baseline
    runWebhookAlerts([entry({ key: 'a', ts: t0 })]) // fetch #1 fails → unmarked
    await flush()
    runWebhookAlerts([entry({ key: 'a', ts: t0 })]) // retry → fetch #2
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalled()
  })

  it('honors a relayed-key persisted in localStorage (cross-tab/reload dedup)', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    const t0 = Date.now()
    runWebhookAlerts([]) // consume firstRun baseline (empty)
    // Simulate another tab having already relayed 'a' into shared localStorage.
    localStorage.setItem('aiwatch-relayed-alerts', JSON.stringify({ a: t0 }))
    runWebhookAlerts([entry({ key: 'a', ts: t0 })])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips a malformed feed entry without throwing, still relays the valid one', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    runWebhookAlerts([]) // baseline
    runWebhookAlerts([
      entry({ key: 'bad-ts', ts: NaN }),
      entry({ key: 'bad-embed', embed: { title: 'x' } }),
      entry({ key: 'ok', ts: Date.now() }),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).payload.embeds[0].title).toContain('Claude')
  })

  it('honors alertTarget custom', () => {
    withSettings({ alertTarget: 'custom', alertServices: ['openai'] })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    runWebhookAlerts([]) // baseline
    runWebhookAlerts([
      entry({ key: 'c', svcIds: ['claude'], ts: 2000 }),
      entry({ key: 'o', svcIds: ['openai'], ts: 2000, embed: { title: '🔴 OpenAI', description: 'd', color: 1 } }),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).payload.embeds[0].title).toContain('OpenAI')
  })

  it("alertCondition 'down' suppresses degraded relays", () => {
    withSettings({ alertCondition: 'down' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    runWebhookAlerts([]) // baseline
    runWebhookAlerts([entry({ key: 'd', kind: 'degraded', ts: 2000 })])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
