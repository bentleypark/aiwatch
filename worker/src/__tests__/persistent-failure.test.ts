import { describe, it, expect, vi } from 'vitest'
import { checkPersistentFetchFailures } from '../persistent-failure'
import { TRACKING_ALERT_STALE_MS, TRACKING_COUNT_DECAY_MS } from '../utils'

type DiscordSend = (
  webhookUrl: string,
  embed: { title: string; description: string; color: number },
) => Promise<boolean>

const NOW = Date.parse('2026-06-02T12:00:00.000Z')
const twoHoursAgo = new Date(NOW - 2 * 3_600_000).toISOString()
const tenMinAgo = new Date(NOW - 10 * 60_000).toISOString()
const DISCORD = 'https://discord.com/api/webhooks/1/abc'

function mockKV(store: Record<string, string> = {}) {
  return {
    store,
    get: vi.fn(async (k: string) => store[k] ?? null),
    put: vi.fn(async (k: string, v: string) => { store[k] = v }),
    delete: vi.fn(async (k: string) => { delete store[k] }),
  }
}

// #1224 — failSince now lives in the consolidated `tracking:state` blob, not individual
// `fetch-fail:since:{id}` keys. `alerted:fetch-persistent:{id}` (the alert dedup marker) is
// unaffected by the consolidation and still reads/writes its own key.
// #1224 round 4 — failSince only alerts while its paired failCountAt is fresh (TRACKING_ALERT_STALE_MS).
// Every entry gets a default failCount + fresh failCountAt unless the test overrides them (e.g. to
// exercise the staleness gate itself) — realistic, since trackFetchFailure never writes failSince
// without ALSO writing failCount/failCountAt in the same call, and sanitizeTrackingState requires the
// (failCount, failCountAt) pair to survive together (a lone failCountAt with no failCount is itself
// treated as corruption, same as the reverse).
const trackingKV = (blob: Record<string, { failSince?: string; failCountAt?: string; failCount?: number }>, extra: Record<string, string> = {}) => {
  // Stamped against the sweep's own frozen NOW, not the real wall clock — using Date.now() here would
  // make every default-stamped entry look "fresh" only because it sits in NOW's future (2026-06-02),
  // which passes the staleness gate for the wrong reason and stops these fixtures from actually
  // exercising it.
  const now = new Date(NOW).toISOString()
  const stamped = Object.fromEntries(Object.entries(blob).map(([id, entry]) => [id, { failCount: 3, failCountAt: now, ...entry }]))
  return mockKV({ 'tracking:state': JSON.stringify(stamped), ...extra })
}

const svcs = [{ id: 'deepseek', name: 'DeepSeek API' }, { id: 'mistral', name: 'Mistral API' }]

describe('checkPersistentFetchFailures (#500)', () => {
  it('alerts the operator + writes the 24h dedup when a service has been unreachable >= 1h', async () => {
    const kv = trackingKV({ deepseek: { failSince: twoHoursAgo } })
    const send = vi.fn<DiscordSend>(async () => true)
    await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)
    expect(send).toHaveBeenCalledOnce()
    const [url, embed] = send.mock.calls[0]
    expect(url).toBe(DISCORD) // operator webhook
    expect(embed.title).toContain('DeepSeek API')
    expect(embed.description).toContain('2h+')
    expect(kv.store['alerted:fetch-persistent:deepseek']).toBe('1') // dedup written
  })

  it('does NOT alert when the failure is younger than 1h', async () => {
    const kv = trackingKV({ deepseek: { failSince: tenMinAgo } })
    const send = vi.fn<DiscordSend>(async () => true)
    await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)
    expect(send).not.toHaveBeenCalled()
    expect(kv.store['alerted:fetch-persistent:deepseek']).toBeUndefined()
  })

  it('skips a service already alerted this 24h (dedup)', async () => {
    const kv = trackingKV({ deepseek: { failSince: twoHoursAgo } }, { 'alerted:fetch-persistent:deepseek': '1' })
    const send = vi.fn<DiscordSend>(async () => true)
    await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)
    expect(send).not.toHaveBeenCalled()
  })

  it('does NOT write the dedup marker when the send fails (so it retries next cron)', async () => {
    const kv = trackingKV({ deepseek: { failSince: twoHoursAgo } })
    const send = vi.fn<DiscordSend>(async () => false) // Discord POST failed
    await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)
    expect(send).toHaveBeenCalledOnce()
    expect(kv.store['alerted:fetch-persistent:deepseek']).toBeUndefined()
  })

  it('falls back to the svcId when the service is not in the name map', async () => {
    const kv = trackingKV({ ghost: { failSince: twoHoursAgo } })
    const send = vi.fn<DiscordSend>(async () => true)
    await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)
    expect(send.mock.calls[0][1].title).toContain('ghost')
  })

  it('no-ops when kv or discord url is absent', async () => {
    const send = vi.fn<DiscordSend>(async () => true)
    await checkPersistentFetchFailures(undefined, DISCORD, svcs, NOW, send)
    await checkPersistentFetchFailures(trackingKV({ deepseek: { failSince: twoHoursAgo } }), undefined, svcs, NOW, send)
    expect(send).not.toHaveBeenCalled()
  })

  it('handles multiple blocked services in one sweep', async () => {
    const kv = trackingKV({
      deepseek: { failSince: twoHoursAgo },
      mistral: { failSince: twoHoursAgo },
    })
    const send = vi.fn<DiscordSend>(async () => true)
    await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('#800 — skips a KNOWN-deactivated source (suppressedIds), even when it would otherwise alert', async () => {
    const kv = trackingKV({ characterai: { failSince: twoHoursAgo } })
    const send = vi.fn<DiscordSend>(async () => true)
    const svcsWithCai = [...svcs, { id: 'characterai', name: 'Character.AI' }]
    await checkPersistentFetchFailures(kv, DISCORD, svcsWithCai, NOW, send, new Set(['characterai']))
    expect(send).not.toHaveBeenCalled()
    expect(kv.store['alerted:fetch-persistent:characterai']).toBeUndefined()
  })

  it('#800 — suppressedIds scopes to the flagged service only — others still alert', async () => {
    const kv = trackingKV({
      characterai: { failSince: twoHoursAgo },
      deepseek: { failSince: twoHoursAgo },
    })
    const send = vi.fn<DiscordSend>(async () => true)
    const svcsWithCai = [...svcs, { id: 'characterai', name: 'Character.AI' }]
    await checkPersistentFetchFailures(kv, DISCORD, svcsWithCai, NOW, send, new Set(['characterai']))
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0][1].title).toContain('DeepSeek API')
  })

  // #1224 round 4 (C1) — the regression this fix exists for. A dead-source read (#689's 4xx path)
  // stops calling trackFetchFailure/resetFetchFailure entirely, so `failSince` freezes forever with
  // no expiry of its own — without the failCountAt-freshness gate this would page every 24h forever.
  it('does NOT alert on a failSince whose failCountAt has gone stale — a frozen leftover from a source that stopped reporting entirely', async () => {
    const staleAt = new Date(NOW - (TRACKING_ALERT_STALE_MS + 5 * 60_000)).toISOString() // past the stale gate
    const kv = mockKV({ 'tracking:state': JSON.stringify({ deepseek: { failCount: 3, failSince: twoHoursAgo, failCountAt: staleAt } }) })
    const send = vi.fn<DiscordSend>(async () => true)
    await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)
    expect(send).not.toHaveBeenCalled()
  })

  it('DOES still alert when failCountAt is fresh even though failSince is old — the genuinely-still-failing case', async () => {
    const kv = mockKV({ 'tracking:state': JSON.stringify({ deepseek: { failCount: 3, failSince: twoHoursAgo, failCountAt: new Date(NOW - 5 * 60_000).toISOString() } }) })
    const send = vi.fn<DiscordSend>(async () => true)
    await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)
    expect(send).toHaveBeenCalledOnce()
  })

  // Pins the 2x margin itself (round 5, Important #1): a failCountAt this old is PAST the raw
  // TRACKING_COUNT_DECAY_MS window (so a naive 1x gate would already call it stale) but still WELL
  // WITHIN TRACKING_ALERT_STALE_MS — exactly the legitimate mid-reclimb staleness a genuinely still-
  // failing service produces between threshold-crossing writes. Must still alert; a regression to a
  // 1x margin here would suppress a real ongoing outage.
  it('DOES still alert when failCountAt is older than the raw decay window but still within the 2x alert margin', async () => {
    const midReclimbAt = new Date(NOW - (TRACKING_COUNT_DECAY_MS + 10 * 60_000)).toISOString() // 40 min old
    expect(TRACKING_ALERT_STALE_MS).toBeGreaterThan(TRACKING_COUNT_DECAY_MS + 10 * 60_000) // the fixture must actually land inside the intended gap
    const kv = mockKV({ 'tracking:state': JSON.stringify({ deepseek: { failCount: 3, failSince: twoHoursAgo, failCountAt: midReclimbAt } }) })
    const send = vi.fn<DiscordSend>(async () => true)
    await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)
    expect(send).toHaveBeenCalledOnce()
  })

  it('never throws — a tracking-blob read failure is swallowed (best-effort, cron-safe)', async () => {
    const kv = { get: vi.fn(async () => { throw new Error('KV down') }), put: vi.fn(), delete: vi.fn() }
    const send = vi.fn<DiscordSend>(async () => true)
    await expect(checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)).resolves.toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })

  it('never throws — even if the injected `send` itself rejects, which is the one call in this sweep with no inner catch of its own (the dedup kv.get already has its own inline .catch, and readTrackingState protects itself)', async () => {
    const kv = trackingKV({ deepseek: { failSince: twoHoursAgo } })
    const send = vi.fn<DiscordSend>(async () => { throw new Error('discord POST rejected, not just false') })
    await expect(checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)).resolves.toBeUndefined()
    expect(send).toHaveBeenCalledOnce() // it WAS reached — the outer try/catch is what stops the throw propagating
  })
})
