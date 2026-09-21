// #1389/#957 — "this service stopped publishing official uptime" operator alert.
//
// The failure it exists for: on 2026-09-10, 14 services went to `uptime30d: null` in a single cycle and
// nothing said so: #500 fires on failed reads, #689 on a 4xx, #135 on an unresolvable component id,
// and the source was answering 200 with a perfectly good component list — only the number was gone.
//
// The hard part is not detecting a null; it is not crying wolf about the services that have never
// published uptime at all. The tracker's answer is that a reading must have been SEEN before its
// absence counts, which makes the judgement observational rather than a config list that goes stale —
// and is why that set is nowhere named here, since it rotates whenever a provider starts or stops
// publishing. Most of what follows pins that boundary in both directions.
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  trackUptimeReading,
  shouldAlertUptimeMissing,
  formatUptimeMissingAlert,
  UPTIME_MISSING_ALERT_MS,
  UPTIME_SEEN_RETENTION_MS,
  type TrackingStateBlob,
} from '../utils'
import { checkUptimeLiveness } from '../uptime-liveness'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})
import { fetchService, fetchAllServices, SERVICES } from '../services'
import type { ServiceStatus } from '../services'
import workerModule from '../index'
import { mockKV, TEST_TIMEOUT_MS } from './helpers/unreadable-source'
import { CLAUDE_API, ninetyDays } from './helpers/lazy-status-page'

const T0 = Date.parse('2026-09-09T00:00:00Z')
const SEEN_DAY = '2026-09-09' // T0's UTC day — the granularity `uptimeSeenAt` is stored at
const hours = (n: number) => n * 3_600_000
const days = (n: number) => n * 86_400_000

describe('trackUptimeReading — the seen/missing pair', () => {
  it('a service that has NEVER published uptime records nothing at all', () => {
    // Without this, the alert would page forever about every service that does not publish uptime, for
    // a documented permanent state (#713), and be muted within a week.
    const store: TrackingStateBlob = {}
    for (let i = 0; i < 5; i++) trackUptimeReading(store, 'bedrock', false, T0 + hours(i * 12))
    expect(store).toEqual({})
  })

  it('a healthy reading records the day and nothing else', () => {
    const store: TrackingStateBlob = {}
    trackUptimeReading(store, 'claude', true, T0)
    expect(store.claude).toEqual({ uptimeSeenAt: '2026-09-09' })
  })

  it('repeat readings on the same day do not touch the blob', () => {
    // `/api/status` runs this on EVERY browser poll. A full timestamp refreshed each time would make
    // `writeTrackingStateIfChanged` write all 45 services to KV every cycle — the diagnostic would
    // become the system's biggest writer.
    const store: TrackingStateBlob = {}
    trackUptimeReading(store, 'claude', true, T0)
    const before = JSON.stringify(store)
    for (const m of [1, 5, 60, 600]) trackUptimeReading(store, 'claude', true, T0 + m * 60_000)
    expect(JSON.stringify(store)).toBe(before)
  })

  it('the first null after a reading stamps `uptimeMissingSince`', () => {
    const store: TrackingStateBlob = {}
    trackUptimeReading(store, 'claude', true, T0)
    trackUptimeReading(store, 'claude', false, T0 + hours(1))
    expect(store.claude?.uptimeMissingSince).toBe(new Date(T0 + hours(1)).toISOString())
    expect(store.claude?.uptimeSeenAt, 'the evidence that there WAS something to lose survives').toBe('2026-09-09')
  })

  it('later nulls do NOT re-stamp it — otherwise the clock resets and the threshold is unreachable', () => {
    const store: TrackingStateBlob = {}
    trackUptimeReading(store, 'claude', true, T0)
    trackUptimeReading(store, 'claude', false, T0 + hours(1))
    for (const h of [2, 3, 7, 20]) trackUptimeReading(store, 'claude', false, T0 + hours(h))
    expect(store.claude?.uptimeMissingSince).toBe(new Date(T0 + hours(1)).toISOString())
  })

  it('a recovery clears the missing clock', () => {
    const store: TrackingStateBlob = {}
    trackUptimeReading(store, 'claude', true, T0)
    trackUptimeReading(store, 'claude', false, T0 + hours(1))
    trackUptimeReading(store, 'claude', true, T0 + hours(2))
    expect(store.claude?.uptimeMissingSince).toBeUndefined()
    expect(shouldAlertUptimeMissing(store.claude!, T0 + hours(48))).toBe(false)
  })

  it('a one-cycle blip cannot arm the alert', () => {
    // The observed false-positive class (2026-08-14): a single status-page HTML fetch loses its race,
    // `uptime30d` is null for one cycle, four re-queries return the value immediately. If this fired,
    // the alert would be noise inside a week and would be muted before the next real rollout.
    const store: TrackingStateBlob = {}
    trackUptimeReading(store, 'claude', true, T0)
    trackUptimeReading(store, 'claude', false, T0 + 5 * 60_000)
    expect(shouldAlertUptimeMissing(store.claude!, T0 + 6 * 60_000)).toBe(false)
    trackUptimeReading(store, 'claude', true, T0 + 10 * 60_000)
    expect(store.claude?.uptimeMissingSince).toBeUndefined()
  })

  it('stops tracking a service whose last reading has aged past the retention window', () => {
    // A provider that migrated away months ago is no longer "losing" its uptime — it simply is a
    // service that does not publish one. Holding the evidence forever would mean a second, meaningless
    // alert if it ever came back and went away again.
    //
    // Both cases below bracket the window with ABSOLUTE day offsets, never `UPTIME_SEEN_RETENTION_MS`
    // itself. A `now` computed from the constant moves with it, so the pair stays green for ANY value —
    // which is exactly how the first two drafts of this case survived widening 30d → 90d: one seeded a
    // date already months stale, the other derived its clock from the constant under test.
    const store: TrackingStateBlob = { mistral: { uptimeSeenAt: SEEN_DAY, uptimeMissingSince: new Date(T0).toISOString() } }
    trackUptimeReading(store, 'mistral', false, T0 + days(31))
    expect(store.mistral).toBeUndefined()
  })

  it('keeps tracking a service still INSIDE the retention window', () => {
    // The complementary direction. Without it, "retire the entry" could fire arbitrarily early and only
    // the case above would notice — a service would go quietly unalertable weeks before it should.
    const store: TrackingStateBlob = { mistral: { uptimeSeenAt: SEEN_DAY } }
    trackUptimeReading(store, 'mistral', false, T0 + days(29))
    expect(store.mistral?.uptimeSeenAt).toBe(SEEN_DAY)
    expect(store.mistral?.uptimeMissingSince, 'and it is armable').toBeTruthy()
  })

  it('the retention constant is the 30 days those two bracket', () => {
    // Stated once, so the pair above reads as a bracket rather than as two magic numbers.
    expect(UPTIME_SEEN_RETENTION_MS).toBe(days(30))
  })

  it('an unreachable cycle does NOT reset the clock — the alert is starvation-proof', () => {
    // Round 3's finding, and the reason the readable/unreadable classification is gone. A version that
    // CLEARED on unreachable cycles could only fire after ~6h containing zero of them; this runs once
    // per `/api/status` request, so that is thousands of consecutive cycles, and a source that blips
    // more often than the threshold could never alert at all. That is a miss, not a delay — and it is
    // the frequency dependence `elapsedAtLeast` exists to avoid ("a consecutive-cycle counter measures
    // traffic, not duration").
    const store: TrackingStateBlob = {}
    trackUptimeReading(store, 'claude', true, T0)
    trackUptimeReading(store, 'claude', false, T0 + hours(1))
    // A blip every 5h for a month, each of which used to reset the clock.
    for (let h = 2; h < 24 * 30; h += 5) trackUptimeReading(store, 'claude', false, T0 + hours(h))

    expect(store.claude?.uptimeMissingSince, 'still the ORIGINAL loss, not the latest cycle').toBe(new Date(T0 + hours(1)).toISOString())
    expect(shouldAlertUptimeMissing(store.claude!, T0 + hours(7))).toBe(true)
  })

  it('a corrupt `uptimeSeenAt` retires the entry instead of arming on a NaN comparison', () => {
    const store: TrackingStateBlob = { claude: { uptimeSeenAt: 'not-a-date' } }
    trackUptimeReading(store, 'claude', false, T0)
    expect(store.claude).toBeUndefined()
  })
})

describe('shouldAlertUptimeMissing — the threshold', () => {
  const armed = (sinceMs: number): TrackingStateBlob[string] => ({ uptimeSeenAt: '2026-09-09', uptimeMissingSince: new Date(sinceMs).toISOString() })

  it('is false below the threshold and true at it', () => {
    expect(shouldAlertUptimeMissing(armed(T0), T0 + UPTIME_MISSING_ALERT_MS - 1)).toBe(false)
    expect(shouldAlertUptimeMissing(armed(T0), T0 + UPTIME_MISSING_ALERT_MS)).toBe(true)
  })

  it('is false for an entry that was never armed', () => {
    expect(shouldAlertUptimeMissing({ uptimeSeenAt: '2026-09-09' }, T0 + hours(999))).toBe(false)
    expect(shouldAlertUptimeMissing({}, T0)).toBe(false)
  })

  it('is false for an unparseable timestamp — fail toward NOT alerting', () => {
    expect(shouldAlertUptimeMissing({ uptimeMissingSince: 'garbage' }, T0 + hours(999))).toBe(false)
  })
})

describe('formatUptimeMissingAlert', () => {
  it('names the elapsed time, the last reading and the page to go look at', () => {
    const body = formatUptimeMissingAlert('Claude API', new Date(T0).toISOString(), '2026-09-09', 'https://status.claude.com', T0 + hours(7))
    expect(body).toContain('7h+')
    expect(body).toContain('2026-09-09')
    expect(body).toContain('https://status.claude.com')
  })

  it('claims nothing about WHY the number is gone, or what it cost', () => {
    // Four review rounds each found a different added clause false here — "the status source still
    // answers", "its Score has fallen to the no-uptime rescale", "this fires while it reads", "it has
    // left the high-confidence ranking". The detector establishes none of them: it knows the number is
    // absent, and for an unprobed service the Score is WITHHELD entirely (`low` → null) rather than
    // rescaled, so a Score clause is false for part of the affected roster.
    //
    // Pins the CLASS, not the four phrasings: a literal blocklist only forbids the drafts that already
    // happened, which is how the fourth one got in past a test written after the third.
    const body = formatUptimeMissingAlert('Claude API', new Date(T0).toISOString(), '2026-09-09', 'https://status.claude.com', T0 + hours(7))
    expect(body, 'no claim about the source, the Score, or the ranking').not.toMatch(/score|rank|confidence|answers|reads|reachab|unreadable|rescale/i)
  })
})

describe('checkUptimeLiveness — the sweep', () => {
  // Captures put OPTIONS, not just values: without them no behaviour test pins that the derived TTL is
  // what actually reaches KV, and dropping `expirationTtl` — turning a 7-day re-alert into "once, ever"
  // — stays green (the lesson `cache-reseed-wiring.test.ts` already learned).
  function kvDouble(seed: Record<string, string> = {}) {
    const store: Record<string, string> = { ...seed }
    const puts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }> = []
    return {
      store,
      puts,
      get: vi.fn(async (k: string) => store[k] ?? null),
      put: vi.fn(async (k: string, v: string, options?: { expirationTtl?: number }) => { store[k] = v; puts.push({ key: k, value: v, options }) }),
      delete: vi.fn(async (k: string) => { delete store[k] }),
    }
  }
  const SERVICES = [
    { id: 'claude', name: 'Claude API', statusUrl: 'https://status.claude.com' },
    { id: 'cursor', name: 'Cursor', statusUrl: 'https://status.cursor.com' },
  ]
  const tracking = (blob: TrackingStateBlob) => ({ 'tracking:state': JSON.stringify(blob) })
  const armedBlob = { claude: { uptimeSeenAt: '2026-09-09', uptimeMissingSince: new Date(T0).toISOString() } }
  const NOW = T0 + hours(7)

  it('alerts once, and writes the dedup marker only after a successful send', async () => {
    const kv = kvDouble(tracking(armedBlob))
    const sent: Array<{ title: string; description: string }> = []
    const send = vi.fn(async (_url: string, embed: { title: string; description: string; color: number }) => { sent.push(embed); return true })

    await checkUptimeLiveness(kv, 'https://discord.test/hook', SERVICES, NOW, send)

    expect(send).toHaveBeenCalledTimes(1)
    expect(sent[0].title).toContain('Claude API')
    expect(sent[0].description).toContain('https://status.claude.com')
    expect(kv.store['alerted:uptime-missing:claude']).toBe('1')
    // The dedup TTL is the 7-day re-alert cadence. Without this the marker could be written with no
    // expiry — the service alerts once, ever — and every other assertion here still passes.
    expect(kv.puts).toEqual([{ key: 'alerted:uptime-missing:claude', value: '1', options: { expirationTtl: 604_800 } }])
  })

  it('alerts EVERY armed service in one sweep, not just the first', async () => {
    // The incident that motivated this armed 14 services at once. With a single armed service in every
    // case, a `break` after the first successful send is invisible.
    const kv = kvDouble(tracking({
      claude: { uptimeSeenAt: '2026-09-09', uptimeMissingSince: new Date(T0).toISOString() },
      cursor: { uptimeSeenAt: '2026-09-09', uptimeMissingSince: new Date(T0).toISOString() },
    }))
    const send = vi.fn(async () => true)

    await checkUptimeLiveness(kv, 'https://discord.test/hook', SERVICES, NOW, send)

    expect(send).toHaveBeenCalledTimes(2)
    expect(kv.store['alerted:uptime-missing:claude']).toBe('1')
    expect(kv.store['alerted:uptime-missing:cursor']).toBe('1')
  })

  it('does not alert twice while the dedup marker stands', async () => {
    const kv = kvDouble({ ...tracking(armedBlob), 'alerted:uptime-missing:claude': '1' })
    const send = vi.fn(async () => true)
    await checkUptimeLiveness(kv, 'https://discord.test/hook', SERVICES, NOW, send)
    expect(send).not.toHaveBeenCalled()
  })

  it('a FAILED send leaves no marker, so the next cron retries', async () => {
    // The alternative silently swallows the one alert this whole feature exists to deliver.
    const kv = kvDouble(tracking(armedBlob))
    const send = vi.fn(async () => false)
    await checkUptimeLiveness(kv, 'https://discord.test/hook', SERVICES, NOW, send)
    expect(send).toHaveBeenCalledTimes(1)
    expect(kv.store['alerted:uptime-missing:claude']).toBeUndefined()
  })

  it('stays silent below the threshold', async () => {
    const kv = kvDouble(tracking(armedBlob))
    const send = vi.fn(async () => true)
    await checkUptimeLiveness(kv, 'https://discord.test/hook', SERVICES, T0 + hours(1), send)
    expect(send).not.toHaveBeenCalled()
  })

  // ── The accepted overlap ──
  //
  // This sweep asks NOTHING about what the other operator alerts are doing, so a shared root cause
  // produces two messages. Three attempts to suppress that were each wrong in a new way; the third is
  // why there is no fourth — the markers those alerts keep do not mean "someone was told". #135 writes
  // its marker even when the Discord POST fails, so suppressing on it silenced BOTH alerts for 24h
  // about a service nobody heard about. A bounded duplicate is the better trade for a detector that
  // exists because a silence cost a day.
  //
  // Pinned as BEHAVIOUR, not left to prose: if someone reintroduces a marker check, these go red.
  it.each([
    ['alerted:fetch-persistent', '#500 — status source unreadable 1h+'],
    ['alerted:source-dead', '#689 — status source returned 4xx'],
    ['alerted:component-missing', '#135 — configured component id no longer resolves'],
  ])('still alerts while %s is set (%s) — the overlap is deliberate', async (prefix) => {
    const kv = kvDouble({ ...tracking(armedBlob), [`${prefix}:claude`]: '1' })
    const send = vi.fn(async () => true)

    await checkUptimeLiveness(kv, 'https://discord.test/hook', SERVICES, NOW, send)

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('the duplicate is BOUNDED — the 7d dedup holds it to one message per week', async () => {
    // What makes the overlap affordable. Without the dedup, the same service would be re-sent on every
    // cron cycle for as long as its uptime stayed gone.
    const kv = kvDouble({ ...tracking(armedBlob), 'alerted:source-dead:claude': '1' })
    const send = vi.fn(async () => true)

    await checkUptimeLiveness(kv, 'https://discord.test/hook', SERVICES, NOW, send)
    await checkUptimeLiveness(kv, 'https://discord.test/hook', SERVICES, NOW + hours(1), send)

    expect(send, 'the second cycle is deduped, not re-sent').toHaveBeenCalledTimes(1)
    expect(kv.puts[0].options).toEqual({ expirationTtl: 604_800 })
  })

  it('DOES alert when only the uptime leg is failing — the case nothing else covers', async () => {
    // The #1389 shape: the status-page HTML or `/uptime_showcase` returns non-ok while summary.json is
    // fine. No other alert fires at all here, so this one is the entire signal.
    const kv = kvDouble(tracking(armedBlob))
    const send = vi.fn(async () => true)

    await checkUptimeLiveness(kv, 'https://discord.test/hook', SERVICES, NOW, send)

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('skips an acknowledged dead source (#800)', async () => {
    const kv = kvDouble(tracking(armedBlob))
    const send = vi.fn(async () => true)
    await checkUptimeLiveness(kv, 'https://discord.test/hook', SERVICES, NOW, send, new Set(['claude']))
    expect(send).not.toHaveBeenCalled()
  })

  it('skips an entry for a service no longer in SERVICES', async () => {
    const kv = kvDouble(tracking({ retired: { uptimeSeenAt: '2026-09-09', uptimeMissingSince: new Date(T0).toISOString() } }))
    const send = vi.fn(async () => true)
    await checkUptimeLiveness(kv, 'https://discord.test/hook', SERVICES, NOW, send)
    expect(send).not.toHaveBeenCalled()
  })

  it('is a no-op without a webhook or KV, and never throws on a broken read', async () => {
    const send = vi.fn(async () => true)
    await checkUptimeLiveness(undefined, 'https://discord.test/hook', SERVICES, NOW, send)
    await checkUptimeLiveness(kvDouble(), undefined, SERVICES, NOW, send)
    const broken = { get: vi.fn(async () => { throw new Error('KV down') }), put: vi.fn(async () => {}), delete: vi.fn(async () => {}) }
    await expect(checkUptimeLiveness(broken, 'https://discord.test/hook', SERVICES, NOW, send)).resolves.toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })
})

// ── The wired half ──
//
// Everything above is pure, and would stay green if `fetchService` never called `trackUptimeReading` or
// the cron never called `checkUptimeLiveness` — which is exactly the
// `fix_the_called_path_not_the_tested_twin` failure this feature exists to end. Both halves are pinned
// below.

describe('the signal is produced by the real fetch path', () => {
  // Drives `fetchService` (ONE service), not `fetchAllServices` (45). The choke point under test is in
  // `fetchService`, so 45 services buys no coverage — and it costs: three `fetchAllServices` runs in
  // this file added enough CPU contention to push `cache-reseed-wiring.test.ts` past its 5s default
  // timeout under vitest's unbounded file parallelism, turning `npm run test:worker` intermittently red
  // at an unrelated location. The showcase transport's own end-to-end wiring is covered where it
  // belongs, in `lazy-uptime-showcase.test.ts`.
  const claude = SERVICES.find((s) => s.id === 'claude')!
  const today = () => new Date().toISOString().split('T')[0]

  /** A prefetch entry for the Anthropic page, with or without a usable uptime payload. */
  function prefetched(withUptime: boolean) {
    return {
      summary: {
        status: { indicator: 'none', description: 'All Systems Operational' },
        components: [{ id: CLAUDE_API, name: 'Claude API', status: 'operational' }],
        incidents: [],
      },
      incidents: null,
      latency: 10,
      ...(withUptime ? { uptimeTimelines: { [CLAUDE_API]: { days: ninetyDays(today()) } } } : {}),
    }
  }

  it('records the reading when uptime IS published', async () => {
    const trackingStore: TrackingStateBlob = {}
    await fetchService(claude, prefetched(true), undefined, trackingStore)
    expect(trackingStore.claude?.uptimeSeenAt).toBe(today())
  })

  it('arms the missing clock when a service that HAD uptime stops publishing it', async () => {
    // The 2026-09-10 event in miniature: the page still answers with a full component list, and the
    // only thing that changed is that no number comes back.
    const trackingStore: TrackingStateBlob = { claude: { uptimeSeenAt: today() } }
    await fetchService(claude, prefetched(false), undefined, trackingStore)

    expect(trackingStore.claude?.uptimeMissingSince, 'nothing else in the system notices this').toBeTruthy()
    expect(trackingStore.claude?.uptimeSeenAt).toBe(today())
  })

  it('stays silent for a service with no prior reading — the false-positive direction', async () => {
    // Same premise, no `uptimeSeenAt` seeded. A service that simply does not publish uptime lives in
    // this state permanently; arming it would make the alert noise and get it muted before the next
    // real event.
    const trackingStore: TrackingStateBlob = {}
    await fetchService(claude, prefetched(false), undefined, trackingStore)
    expect(trackingStore.claude?.uptimeMissingSince).toBeUndefined()
  })

  it('records the absence even when the SOURCE was unreadable — the judgement is not made here', async () => {
    // Deliberate, and the point of round 3's restructure. Two earlier versions tried to tell "the page
    // is unreachable" from "the page stopped publishing" at THIS line; both failed, in opposite
    // directions (a frozen clock, then a starvable one). The tracker now records only that the number
    // was absent, and `checkUptimeLiveness` decides whether that is worth reporting — which it does by
    // at alert time. That call is pinned in the sweep's own describe.
    //
    // This is also not a distinction available here: `sourceUnknown`/`sourceDead` describe the
    // summary.json leg, while the status-page HTML and `/uptime_showcase` legs — the only ones that
    // produce `uptime30d` for an Atlassian service — can fail on their own without setting either.
    const trackingStore: TrackingStateBlob = { claude: { uptimeSeenAt: today() } }
    // No prefetch + a throwing fetch ⇒ the unreadable-source return path (`sourceUnknown`).
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('TLS: cert does not match host') }))
    const svc = await fetchService(claude, undefined, mockKV() as unknown as KVNamespace, trackingStore)
    vi.unstubAllGlobals()

    expect(svc.sourceUnknown, 'premise: this cycle could not read the source').toBe(true)
    expect(trackingStore.claude?.uptimeMissingSince, 'armed — suppression is the sweep\'s job').toBeTruthy()
    expect(trackingStore.claude?.uptimeSeenAt).toBe(today())
  })
})

describe('the sweep is wired into the cron', () => {
  // Behavioural, not a source scan. An earlier version asserted the call site with a regex and
  // justified it as "nothing in the suite invokes the `scheduled` handler" — which is false:
  // `cache-reseed-wiring.test.ts` drives it, and this PR's own timing measurement in that file was only
  // possible because the sweep runs under that harness. A regex over `index.ts` also breaks on a
  // reformat and survives a roster that no longer reaches the sweep, which is the failure mode this
  // repo's `kv-read-census` note warns about.
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
  // Mid-month, off the hour, outside the daily-summary window — so no other cron branch is entangled.
  const event = { scheduledTime: Date.parse('2026-08-12T12:07:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent
  const OPERATIONAL = SERVICES.map((c) => ({ id: c.id, name: c.name, status: 'operational', incidents: [] } as unknown as ServiceStatus))

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('fires the real alert through scheduled(), for an armed service on the real roster', async () => {
    const store: Record<string, string> = {
      // `claude` lost its uptime 7h ago and nothing else is carrying it.
      'tracking:state': JSON.stringify({ claude: { uptimeSeenAt: '2026-08-11', uptimeMissingSince: '2026-08-12T05:07:00.000Z' } }),
    }
    const kv = {
      get: async (k: string) => store[k] ?? null,
      getWithMetadata: async () => ({ value: null, metadata: null }),
      put: async (k: string, v: string) => { store[k] = v },
      delete: async (k: string) => { delete store[k] },
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const posted: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      if (url.includes('discord')) posted.push(String(init?.body ?? ''))
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(fetchAllServices).mockResolvedValue({ raw: OPERATIONAL, enriched: OPERATIONAL, pageComponents: {}, upstreamFeeds: [] })

    await workerModule.scheduled(event, { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: 'https://discord.test/hook' } as never, ctx)

    // The embed this feature exists to deliver, reaching Discord from the real handler — and the
    // dedup marker written for it, which is what a roster that never reaches the sweep would lack.
    expect(posted.join('\n'), 'the uptime-missing embed').toContain('uptime has stopped publishing')
    expect(posted.join('\n')).toContain('Claude API')
    expect(store['alerted:uptime-missing:claude']).toBe('1')
  }, TEST_TIMEOUT_MS)
})
