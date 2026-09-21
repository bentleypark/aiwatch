import { describe, it, expect, vi } from 'vitest'
import { checkPersistentFetchFailures, PARSE_CAUSE_RECENCY_SLOTS } from '../persistent-failure'
import { parseFailKey, slotOf } from '../parse-failure-log'
import { TRACKING_ALERT_STALE_MS, TRACKING_COUNT_DECAY_MS, type StatusSourceReadFailure } from '../utils'

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
const trackingKV = (blob: Record<string, { failSince?: string; failCountAt?: string; failCount?: number; sourceReadFailure?: StatusSourceReadFailure }>, extra: Record<string, string> = {}) => {
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
  it('alerts the operator + writes the 24h dedup when a service has been unreadable >= 1h', async () => {
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

  it.each([
    [{ source: 'aws-health', phase: 'transport', errorKind: 'timeout' }, 'AWS Health transport timeout'],
    [{ source: 'aws-health', phase: 'http', httpStatus: 429 }, 'AWS Health HTTP 429'],
    [{ source: 'aws-health', phase: 'decode', httpStatus: 200 }, 'AWS Health response decode failed'],
    [{ source: 'aws-health', phase: 'shape', httpStatus: 200 }, 'AWS Health response shape failed'],
    [{ source: 'datadog-config', phase: 'http', httpStatus: 403 }, 'Datadog config.json HTTP 403'],
    [{ source: 'instatus-scrape', phase: 'http', httpStatus: 503 }, 'Instatus scrape HTTP 503'],
    [{ source: 'rss', phase: 'http', httpStatus: 503 }, 'RSS feed HTTP 503'],
    [{ source: 'gcloud', phase: 'http', httpStatus: 504 }, 'Google Cloud incidents.json HTTP 504'],
    [{ source: 'betterstack', phase: 'http', httpStatus: 502 }, 'Better Stack index.json HTTP 502'],
  ] as const)('includes the retained source-read cause for %o', async (sourceReadFailure, expected) => {
    const kv = trackingKV({ deepseek: { failSince: twoHoursAgo, sourceReadFailure } })
    const send = vi.fn<DiscordSend>(async () => true)

    await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)

    expect(send.mock.calls[0][1].description).toContain(`Observed: ${expected}.`)
  })

  // #1391 — the streak is armed by both the transport branches and the parse branches, so it carries
  // no cause. These drive the real `checkPersistentFetchFailures` with a real `instatus-parse-fail:`
  // value, so what the sweep reports is pinned where it actually runs.
  describe('#1391 — the alert reports what the record holds, not a fixed sentence', () => {
    const parseDayKV = (svcId: string, reasons: Record<string, number>, slot: number, entry: Record<string, unknown> = {}) =>
      trackingKV(
        { [svcId]: { failSince: twoHoursAgo, ...entry } },
        { [parseFailKey('2026-06-02')]: JSON.stringify({ counts: { [svcId]: reasons }, slots: { [svcId]: slot } }) },
      )

    // The WHOLE embed, title included, for each arm the sweep can send. The title is a literal at the
    // call site and was the one string no test pinned: a `not.toContain('unreachable')` on it passes
    // for any other phrasing of the same claim, which is how the deleted sentence could walk back in.
    it.each([
      ['a currently-booked parse failure', () => parseDayKV('deepseek', { 'scrape-unreadable': 7 }, slotOf(NOW)),
        'Booked today: `scrape-unreadable`.'],
      ['a retained read failure', () => trackingKV({ deepseek: { failSince: twoHoursAgo, sourceReadFailure: { source: 'aws-health', phase: 'http', httpStatus: 429 } } }),
        'Observed: AWS Health HTTP 429.'],
      ['neither signal', () => trackingKV({ deepseek: { failSince: twoHoursAgo } }),
        'Check both the configured status-page URL and whether the provider changed status-page vendors.'],
    ])('sends exactly one embed for %s', async (_label, makeKv, tail) => {
      const send = vi.fn<DiscordSend>(async () => true)

      await checkPersistentFetchFailures(makeKv(), DISCORD, svcs, NOW, send)

      // The count is part of the output surface: a SECOND send carrying the retired title and
      // sentence reaches the operator just as well, and inspecting only `calls[0]` cannot see it.
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][1]).toEqual({
        title: '⚠️ DeepSeek API — status source unreadable 1h+',
        description: `⚠️ **DeepSeek API** status source has been unreadable for **2h+**. ${tail}`,
        color: 0xe67e22,
      })
    })

    // Two reasons in one day is ordinary — `services.ts`' `scrapeLegFailure ?? betterStackLegFailure`
    // coalesce books different ones on different cycles. `slots` dates only the last booking and names
    // no reason, so electing one (by count or otherwise) claims a currency the record cannot support.
    // Insertion order here is REVERSE alphabetical and the counts favour the second entry, so this
    // fixture discriminates on both axes at once: it fails if the sort goes, and it fails if the
    // most-frequent reason is elected. A fixture already in alphabetical order pins neither.
    it('reports every reason booked that day, sorted, not the most frequent one', async () => {
      const kv = parseDayKV('deepseek', { 'rss-unreadable': 2, 'betterstack-unreadable': 40 }, slotOf(NOW))
      const send = vi.fn<DiscordSend>(async () => true)

      await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)

      expect(send.mock.calls[0][1].description).toContain('Booked today: `betterstack-unreadable`, `rss-unreadable`.')
    })

    // `parseParseFailDay` reads `slots` independently of `counts` and drops a count map whose entries
    // are all non-positive, so a corrupt or hand-edited value yields a fresh slot with no usable reasons.
    it('falls through to the retained read cause when a fresh slot has no usable reasons', async () => {
      const kv = trackingKV(
        { deepseek: { failSince: twoHoursAgo, sourceReadFailure: { source: 'aws-health', phase: 'http', httpStatus: 503 } } },
        { [parseFailKey('2026-06-02')]: JSON.stringify({ counts: { deepseek: { 'rss-unreadable': 0 } }, slots: { deepseek: slotOf(NOW) } }) },
      )
      const send = vi.fn<DiscordSend>(async () => true)

      await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)

      expect(send.mock.calls[0][1].description).not.toContain('Booked today')
      expect(send.mock.calls[0][1].description).toContain('AWS Health HTTP 503')
    })

    // The window WIDTH, in literal slots — deriving the fixture from PARSE_CAUSE_RECENCY_SLOTS makes
    // the test self-adjust to any value, so shrinking the constant to 0 would stay green.
    it.each([
      [0, true], [1, true], [2, true], [3, false], [4, false],
    ])('a booking %i slots old is reported: %s', async (slotsBack, reported) => {
      const kv = parseDayKV('deepseek', { 'scrape-unreadable': 7 }, slotOf(NOW) - slotsBack)
      const send = vi.fn<DiscordSend>(async () => true)

      await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)

      expect(send.mock.calls[0][1].description.includes('scrape-unreadable')).toBe(reported)
    })

    // The misattribution the recency window exists to prevent: a parse failure that ended hours ago
    // must not be reported as the cause of a streak that is now something else.
    it('a parse booking older than the recency window is not the cause', async () => {
      const staleSlot = slotOf(NOW) - (PARSE_CAUSE_RECENCY_SLOTS + 1)
      const kv = parseDayKV('deepseek', { 'scrape-unreadable': 7 }, staleSlot)
      const send = vi.fn<DiscordSend>(async () => true)

      await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)

      expect(send.mock.calls[0][1].description).not.toContain('scrape-unreadable')
      expect(send.mock.calls[0][1].description).toContain('Check both the configured status-page URL')
    })

    // Both signals, both reported. An earlier precedence rule elected the booking and dropped the
    // read failure, which discards whatever that record held.
    it('reports the retained read failure alongside a booking, not instead of it', async () => {
      const kv = parseDayKV('deepseek', { 'aws-health-unparseable': 3 }, slotOf(NOW) - 1, {
        sourceReadFailure: { source: 'aws-health', phase: 'http', httpStatus: 503 },
      })
      const send = vi.fn<DiscordSend>(async () => true)

      await checkPersistentFetchFailures(kv, DISCORD, svcs, NOW, send)

      expect(send.mock.calls[0][1].description).toBe(
        '⚠️ **DeepSeek API** status source has been unreadable for **2h+**. Booked today: `aws-health-unparseable`. Observed: AWS Health HTTP 503.',
      )
    })

    // #1224's steady-state-zero invariant: the day key must not be read on the common path, where no
    // service is due, and must be read at most once when several are.
    it('reads the parse-fail day key only when a service is actually alerted, and only once', async () => {
      const quiet = trackingKV({ deepseek: { failSince: tenMinAgo } })
      const quietSend = vi.fn<DiscordSend>(async () => true)
      await checkPersistentFetchFailures(quiet, DISCORD, svcs, NOW, quietSend)
      expect(quiet.get.mock.calls.filter(([k]) => k.startsWith('instatus-parse-fail:'))).toHaveLength(0)

      const busy = trackingKV({ deepseek: { failSince: twoHoursAgo }, mistral: { failSince: twoHoursAgo } })
      const busySend = vi.fn<DiscordSend>(async () => true)
      await checkPersistentFetchFailures(busy, DISCORD, [...svcs, { id: 'mistral', name: 'Mistral' }], NOW, busySend)
      expect(busySend).toHaveBeenCalledTimes(2)
      expect(busy.get.mock.calls.filter(([k]) => k.startsWith('instatus-parse-fail:'))).toHaveLength(1)
    })
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
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][1]).toEqual({
      title: '⚠️ ghost — status source unreadable 1h+',
      description: '⚠️ **ghost** status source has been unreadable for **2h+**. Check both the configured status-page URL and whether the provider changed status-page vendors.',
      color: 0xe67e22,
    })
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
