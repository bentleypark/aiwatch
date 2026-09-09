// #1355 — a SHORT monthly archive must keep being reported until it is repaired.
//
// The month-end "archive ready" ping (#1364) already warns once, then dedups itself via
// `archive:notified:{period}` for 60 days, while `archive:monthly:{period}` is permanent and TTL-less.
// The daily summary now re-derives the verdict from the archive itself every day.
//
// The wiring test at the bottom is the load-bearing one: the pure functions can be green while the
// cron never reads the archive or never passes the field, which is exactly the shape
// `feedback_mutation_test_both_directions` / `debugging_fix_the_called_path_not_the_tested_twin` warn
// about. It drives the real `scheduled()` handler and asserts on the actual Discord payload.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { shortArchiveOf, buildArchiveReadyEmbed, ARCHIVE_REBUILD_CAVEAT } from '../monthly-archive'
import { formatArchiveHealthLine, buildDailySummary } from '../daily-summary'
import type { ServiceStatus } from '../types'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, fetchAllServices } from '../services'

describe('shortArchiveOf (#1355)', () => {
  it('reports the gap for a month that is short', () => {
    // August has 31 calendar days; the 2026-08 archive was built with 30 (the race this issue is named for).
    expect(shortArchiveOf('2026-08', 30)).toEqual({
      period: '2026-08', daysCollected: 30, expectedDays: 31, missingDays: 1,
    })
  })

  it('returns null for a complete month — the other direction', () => {
    expect(shortArchiveOf('2026-08', 31)).toBeNull()
    expect(shortArchiveOf('2026-09', 30)).toBeNull() // September legitimately has 30
    expect(shortArchiveOf('2026-02', 28)).toBeNull()
  })

  it('knows February in a leap year', () => {
    expect(shortArchiveOf('2028-02', 28)).toEqual({
      period: '2028-02', daysCollected: 28, expectedDays: 29, missingDays: 1,
    })
    expect(shortArchiveOf('2028-02', 29)).toBeNull()
  })

  it('gives NO verdict for a period it cannot evaluate, rather than inventing one', () => {
    // `getMonthDates(y, 13)` answers 31 by rolling into the next year, so a typo would otherwise
    // manufacture a mismatch against a month that does not exist.
    expect(shortArchiveOf('2026-13', 30)).toBeNull()
    expect(shortArchiveOf('2026-00', 30)).toBeNull()
    expect(shortArchiveOf('not-a-period', 30)).toBeNull()
    expect(shortArchiveOf('2026-8', 30)).toBeNull()
    expect(shortArchiveOf('2026-08', NaN)).toBeNull()
  })

  it('does not report a count ABOVE the month length as short', () => {
    expect(shortArchiveOf('2026-09', 31)).toBeNull()
  })
})

describe('formatArchiveHealthLine (#1355)', () => {
  const SHORT = { state: 'short', period: '2026-08', daysCollected: 30, expectedDays: 31, missingDays: 1 } as const

  it('names the gap without promising a rebuild fixes it', () => {
    const line = formatArchiveHealthLine(SHORT)
    expect(line).toContain('Monthly archive short')
    expect(line).toContain('2026-08')
    expect(line).toContain('30 of 31 days')
    // The claim this must NOT make: a rebuild re-reads the same absent `history:` keys, and
    // `censusRegressions` accepts an equal-and-still-short result, so "recovers it" would send the
    // operator to a non-idempotent write that cannot clear the very line prescribing it.
    expect(line).not.toContain('recovers it')
    expect(line).toContain(ARCHIVE_REBUILD_CAVEAT)
  })

  it('states the rebuild tradeoff identically to the month-end embed, from one source', () => {
    // These are two Discord messages about the SAME archive, and on the 1st they both go out. When the
    // claim lived in each of them separately, correcting one produced a same-day contradiction — the
    // operator was told to rebuild and told not to. Pinning the shared constant is what makes drifting
    // them apart fail here rather than in the channel.
    const embed = buildArchiveReadyEmbed('2026-08', 45, 30, 31)
    expect(embed.description).toContain(ARCHIVE_REBUILD_CAVEAT)
    expect(formatArchiveHealthLine(SHORT)).toContain(ARCHIVE_REBUILD_CAVEAT)
    expect(buildArchiveReadyEmbed('2026-08', 45, 31, 31).description).not.toContain(ARCHIVE_REBUILD_CAVEAT)
  })

  it('reports a MISSING archive as its own state, with rebuild as the right remedy there', () => {
    const line = formatArchiveHealthLine({ state: 'missing', period: '2026-09' })
    expect(line).toContain('Monthly archive MISSING')
    expect(line).toContain('2026-09')
    expect(line).toContain('rebuild-archive')
    // Distinct from the short line — a reader must not have to guess which failure happened.
    expect(line).not.toContain('of 30 days')
  })

  it('agrees with itself on plurals', () => {
    expect(formatArchiveHealthLine(SHORT)).toContain('missing 1 day)')
    expect(formatArchiveHealthLine({ ...SHORT, daysCollected: 28, missingDays: 3 })).toContain('missing 3 days)')
  })

  it('renders nothing when there is no verdict', () => {
    expect(formatArchiveHealthLine(null)).toBe('')
    expect(formatArchiveHealthLine(undefined)).toBe('')
  })
})

describe('buildDailySummary archive-health line (#1355)', () => {
  const base = {
    services: [] as ServiceStatus[],
    aiUsage: null,
    latencySnapshots: [],
    incidentCountToday: { newCount: 0, resolvedCount: 0 },
    redditCount: 0,
  }

  it('includes the line for each failure state', () => {
    expect(buildDailySummary({ ...base, archiveHealth: { state: 'short', period: '2026-08', daysCollected: 30, expectedDays: 31, missingDays: 1 } })).toContain('Monthly archive short')
    expect(buildDailySummary({ ...base, archiveHealth: { state: 'missing', period: '2026-08' } })).toContain('Monthly archive MISSING')
  })

  it('omits it entirely when there is no verdict', () => {
    expect(buildDailySummary({ ...base, archiveHealth: null })).not.toContain('Monthly archive')
    expect(buildDailySummary(base)).not.toContain('Monthly archive')
  })

  it('places the line above the traffic sections, where an action item belongs', () => {
    const out = buildDailySummary({
      ...base,
      archiveHealth: { state: 'short', period: '2026-08', daysCollected: 30, expectedDays: 31, missingDays: 1 },
      pluginTraffic: { monitor: 5, brief: 1 },
    })
    const shortAt = out.indexOf('Monthly archive short')
    const pluginAt = out.indexOf('Plugin (Claude Code)')
    expect(shortAt).toBeGreaterThan(-1)
    expect(pluginAt).toBeGreaterThan(-1)
    expect(shortAt).toBeLessThan(pluginAt)
  })
})

// ── Wiring: the real scheduled() handler ─────────────────────────────

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

const OPERATIONAL: ServiceStatus[] = SERVICES.map(s => (
  { id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus
))

type ArchiveState = number | 'absent' | 'fault' | 'malformed'

/**
 * `runAt` is deliberately mid-month (09:0x UTC is the daily-summary window; the 15th is far from the
 * 1st) so the month-end archive window cannot also fire and supply a warning by the OTHER path — the
 * assertions below would not be able to tell the two sources apart.
 */
function makeKv(expectedPeriod: string, state: ArchiveState) {
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string) => {
      if (key === `archive:monthly:${expectedPeriod}`) {
        if (state === 'absent') return null
        if (state === 'fault') throw new Error('simulated KV read fault')
        if (state === 'malformed') return JSON.stringify({ period: expectedPeriod, services: {} })
        return JSON.stringify({ period: expectedPeriod, daysCollected: state, services: { claude: {} } })
      }
      if (key === 'services:latest') return JSON.stringify(OPERATIONAL)
      return store.get(key) ?? null
    },
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
  return kv
}

async function runCron(kv: KVNamespace, runAt: string) {
  vi.mocked(fetchAllServices).mockResolvedValue({ raw: OPERATIONAL, enriched: OPERATIONAL, pageComponents: {}, upstreamFeeds: [] })
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }))
  await workerModule.scheduled({ scheduledTime: Date.parse(runAt), cron: '*/5 * * * *' } as ScheduledEvent, {
    STATUS_CACHE: kv,
    DISCORD_WEBHOOK_URL: 'https://example.invalid/hook',
  } as never, ctx)
  for (const call of fetchMock.mock.calls) {
    if (call[0] !== 'https://example.invalid/hook') continue
    const body = (call[1] as RequestInit | undefined)?.body
    if (typeof body === 'string' && body.includes('AIWatch Daily Report')) return body
  }
  return undefined
}

describe('daily summary re-asserts a bad archive (#1355 wiring)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('carries the short-archive line into the real daily Discord report', async () => {
    const body = await runCron(makeKv('2026-08', 30), '2026-09-15T09:02:00.000Z') // August has 31

    expect(body).toBeDefined()
    expect(body).toContain('Monthly archive short')
    expect(body).toContain('2026-08')
    expect(body).toContain('30 of 31 days')
  })

  it('says nothing when the previous month archived completely — the other direction', async () => {
    const body = await runCron(makeKv('2026-08', 31), '2026-09-15T09:02:00.000Z')

    expect(body).toBeDefined()
    expect(body).not.toContain('Monthly archive')
  })

  it('reports a previous month that was never archived at all', async () => {
    // The build path can leave no archive AND no alert: `kvPut` returns false rather than throwing, so
    // the `catch` that writes `archive:failed:` and pings Discord never runs. Absence must therefore be
    // reported here rather than assumed covered elsewhere.
    const body = await runCron(makeKv('2026-08', 'absent'), '2026-09-15T09:02:00.000Z')

    expect(body).toBeDefined()
    expect(body).toContain('Monthly archive MISSING')
    expect(body).toContain('2026-08')
  })

  it('makes no claim when the archive cannot be read or parsed', async () => {
    // A read fault is not evidence of absence, and a present-but-unparseable value is not evidence of
    // either state. Both must stay silent WITHOUT taking the daily report down with them.
    for (const state of ['fault', 'malformed'] as const) {
      const body = await runCron(makeKv('2026-08', state), '2026-09-15T09:02:00.000Z')
      expect(body, state).toBeDefined()
      expect(body, state).not.toContain('Monthly archive')
      vi.restoreAllMocks()
    }
  })

  it('crosses the year boundary — January reads DECEMBER, not month -1', async () => {
    // The one piece of arithmetic with no executable evidence until now:
    // `Date.UTC(2027, 0 - 1, 1)` must roll back to 2026-12.
    const body = await runCron(makeKv('2026-12', 30), '2027-01-15T09:02:00.000Z') // December has 31

    expect(body).toBeDefined()
    expect(body).toContain('Monthly archive short')
    expect(body).toContain('2026-12')
    expect(body).toContain('30 of 31 days')
  })
})
