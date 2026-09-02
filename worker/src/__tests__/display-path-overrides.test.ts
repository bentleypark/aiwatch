// #1274 — the two DISPLAY apply points for the #1019 duration override: the `/api/report`
// current-month partial (the dashboard's 30/90-day incident list) and the weekly briefing.
//
// The issue required them to keep their fail-open read, and `overrides.test.ts` pins that
// `readOverridesFresh` still collapses a fault to `[]`. That is the function, not the callers — and
// deleting the `applyDurationOverrides` call from EITHER caller left the whole suite green.
// So the corrected duration could silently stop rendering while the archive kept it, and the same
// incident would read 13h on the dashboard and 18m in the report.
//
// The concrete regression this guards is a plausible tidy-up, not a hypothetical: both readers now
// sit on the same import line, so swapping this caller to the fail-closed `readOverridesFreshResult`
// would turn one hand-edited junk row into a hard failure of the dashboard incident list for every
// user — the opposite of the property status-determination.md documents.

import { describe, it, expect, vi, afterEach } from 'vitest'
import workerModule from '../index'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

const CURRENT_MONTH = new Date().toISOString().slice(0, 7)

/** One resolved incident whose stored duration is the provider's inflated paperwork span. */
function paperworkAccumulator(month: string) {
  const day = `${month}-02`
  return JSON.stringify({
    lastUpdated: `${day}T00:00:00Z`,
    services: {
      claude: {
        count: 1, totalMinutes: 800, longestMinutes: 800,
        dates: [day], incidentIds: ['inc-1'], durations: { 'inc-1': 800 },
        incidents: [{
          id: 'inc-1', title: 'Elevated errors', startedAt: `${day}T00:00:00Z`,
          resolvedAt: `${day}T13:20:00Z`, durationMin: 800, status: 'resolved',
        }],
      },
    },
  })
}

function makeKv(store: Record<string, string>, faultOn?: RegExp) {
  return {
    get: async (key: string) => {
      if (faultOn?.test(key)) throw new Error('KV unavailable')
      return store[key] ?? null
    },
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (key: string, value: string) => { store[key] = value },
    delete: async (key: string) => { delete store[key] },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
}

async function reportFor(kv: KVNamespace, month = CURRENT_MONTH) {
  const res = await workerModule.fetch(
    new Request(`https://example.com/api/report?month=${month}`),
    { ALLOWED_ORIGIN: '*', STATUS_CACHE: kv } as Parameters<typeof workerModule.fetch>[1],
    ctx,
  )
  const body = await res.json() as { services?: Record<string, { incidentList?: { id: string; durationMin: number }[] }> }
  return { status: res.status, claude: body.services?.claude?.incidentList ?? [] }
}

describe('/api/report current-month partial applies duration overrides (#1019 / #1274)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('renders the pinned duration, not the provider paperwork span', async () => {
    const kv = makeKv({
      [`incidents:monthly:${CURRENT_MONTH}`]: paperworkAccumulator(CURRENT_MONTH),
      'incident:duration-overrides': JSON.stringify([{ id: 'inc-1', durationMin: 18 }]),
    })

    const { status, claude } = await reportFor(kv)

    expect(status).toBe(200)
    const inc = claude.find(i => i.id === 'inc-1')
    expect(inc, 'the accumulated incident must reach the partial at all').toBeDefined()
    expect(inc!.durationMin, 'the operator-pinned duration').toBe(18)
  })

  it('leaves the stored duration alone when no override is configured', async () => {
    // The control: without it, an apply call that always returned the input would pass the test above
    // only by accident of the fixture.
    const kv = makeKv({ [`incidents:monthly:${CURRENT_MONTH}`]: paperworkAccumulator(CURRENT_MONTH) })

    const { claude } = await reportFor(kv)

    expect(claude.find(i => i.id === 'inc-1')!.durationMin).toBe(800)
  })

  it('still serves the list when the override read FAULTS — this path stays fail-open', async () => {
    // The explicit requirement from the issue. A display surface must not blank out over one
    // unreadable operator list; it renders the un-corrected duration and moves on.
    const kv = makeKv(
      { [`incidents:monthly:${CURRENT_MONTH}`]: paperworkAccumulator(CURRENT_MONTH) },
      /^incident:duration-overrides$/,
    )

    const { status, claude } = await reportFor(kv)

    expect(status, 'a fault here must not become a 5xx for every dashboard user').toBe(200)
    expect(claude.find(i => i.id === 'inc-1')!.durationMin).toBe(800)
  })

  it('and when the list holds a row it cannot use, for the same reason', async () => {
    // `rebuild-archive` REFUSES this value (#1274). The display path must not: the two callers
    // deliberately read the same key to different depths.
    const kv = makeKv({
      [`incidents:monthly:${CURRENT_MONTH}`]: paperworkAccumulator(CURRENT_MONTH),
      'incident:duration-overrides': '[{"id":"inc-1","durationMin":"18"}]',
    })

    const { status, claude } = await reportFor(kv)

    expect(status).toBe(200)
    expect(claude.find(i => i.id === 'inc-1')!.durationMin).toBe(800)
  })
})

// ── The second display apply point: the weekly briefing's incident summary ──────────────────────
// Same gap, same fix. Neutering `applyDurationOverrides` here also left the full suite green, so the
// operator's Discord digest could quietly go back to quoting the provider's paperwork span.

describe('weekly briefing incident summary applies duration overrides (#1019 / #1274)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  // Sunday 00:02 UTC — the briefing window (`getUTCDay() === 0`, hour 0, minutes < 5). Day 2, so the
  // 1st-of-month archive window is not entangled with it.
  const SUNDAY = { scheduledTime: Date.parse('2026-08-02T00:02:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent

  /** Runs the real cron and returns the weekly-briefing Discord body, or '' if none was sent. */
  async function briefingBody(overridesRaw: string | null, faultOn?: RegExp) {
    const store: Record<string, string> = {
      // The briefing reads the CURRENT and previous month relative to the event clock.
      'incidents:monthly:2026-08': paperworkAccumulator('2026-08'),
    }
    if (overridesRaw !== null) store['incident:duration-overrides'] = overridesRaw
    const kv = makeKv(store, faultOn)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // A FRESH Response per call — a shared one gets its body cancelled by the first consumer.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }))
    await workerModule.scheduled(
      SUNDAY,
      { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: 'https://example.invalid/hook' } as never,
      ctx,
    )
    return fetchSpy.mock.calls
      .map(([, init]) => String((init as RequestInit | undefined)?.body ?? ''))
      .find(b => b.includes('Weekly Briefing')) ?? ''
  }

  it('quotes the paperwork span when nothing is overridden — the control', async () => {
    // Asserted first, and deliberately: it is what proves the fixture reaches the summary at all,
    // so the override assertion below cannot pass by the incident being absent.
    const body = await briefingBody(null)
    expect(body, 'the briefing must have been sent at all').not.toBe('')
    expect(body).toContain('13h')
  })

  it('quotes the pinned duration once an override exists', async () => {
    // Asserts the VALUE, not merely the absence of `13h`. A pure negative cannot separate "18m, the
    // operator's pin" from any other wrong number, and a wrong number here means the same incident
    // reads one way in the digest and another in the archive — the disagreement #1019 exists to end.
    const body = await briefingBody(JSON.stringify([{ id: 'inc-1', durationMin: 18 }]))
    expect(body).not.toBe('')
    expect(body, 'the paperwork span must be gone').not.toContain('13h')
    expect(body, 'and replaced by the pinned 18 minutes').toContain('18m')
  })

  it('still sends the briefing when the override read FAULTS — this path stays fail-open', async () => {
    // The property this file's header claims for BOTH display callers, and previously tested on one.
    // Swapping this caller to the fail-closed reader throws inside the cron's outer catch, so the
    // weekly digest simply stops being sent — silently, over one unreadable operator list.
    const body = await briefingBody(null, /^incident:duration-overrides$/)
    expect(body, 'a fault must not suppress the whole briefing').not.toBe('')
    expect(body).toContain('13h')
  })

  it('and when the list holds a row it cannot use, for the same reason', async () => {
    const body = await briefingBody('[{"id":"inc-1","durationMin":"18"}]')
    expect(body, 'one bad row must not suppress the whole briefing').not.toBe('')
    expect(body).toContain('13h')
  })
})

