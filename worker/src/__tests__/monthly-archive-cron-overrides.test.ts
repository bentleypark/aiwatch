// #1274 — the month-end cron writes the permanent monthly archive, and it writes it once:
// `if (!existing)` means no later cycle revisits the key. It used to let `buildMonthlyArchive` take
// its own fail-open read of `incident:duration-overrides`, so a KV blip archived the provider's
// paperwork duration for good — no census signal, not even a log line.
//
// The fix is NOT a refusal. Skipping the write would trade one wrong duration for a month that never
// exists, on a path where nothing retries it and the sources it would be rebuilt from expire. The
// archive is written either way; what changes is that a bad read is announced instead of silent.
//
// Driven through the REAL `scheduled()` handler rather than a helper: the defect was never in a pure
// function, it was in which read the cron reached for, and only the handler shows that.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../services'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, fetchAllServices } from '../services'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

// 1st of the month, 00:07 UTC → inside the archive window, and NOT the 01:00 catch-up. Deliberately
// outside the daily-summary window so no unmocked Analytics read is entered.
const ARCHIVE_EVENT = { scheduledTime: Date.parse('2026-08-01T00:07:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent

const OPERATIONAL: ServiceStatus[] = SERVICES.map(s => (
  { id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus
))

/** One resolved incident carrying the provider's inflated paperwork span, so an override has
 *  something to correct. Without an accumulator the build skips its override block entirely — which
 *  is how an earlier version of the read-count assertion below passed for the wrong reason. */
const PAPERWORK_ACCUMULATOR = JSON.stringify({
  lastUpdated: '2026-07-31T00:00:00Z',
  services: {
    claude: {
      count: 1, totalMinutes: 800, longestMinutes: 800,
      dates: ['2026-07-02'], incidentIds: ['inc-1'], durations: { 'inc-1': 800 },
      incidents: [{
        id: 'inc-1', title: 'Elevated errors', startedAt: '2026-07-02T00:00:00Z',
        resolvedAt: '2026-07-02T13:20:00Z', durationMin: 800, status: 'resolved',
      }],
    },
  },
})

/** KV whose `get` throws for one key, so a FAULT can be told from an absent value — the whole point.
 *  Also counts reads of that key, which is how "the build consumed the caller's read" is stated. */
function makeKv(opts: { overridesRaw?: string | null; faultOnOverrides?: boolean } = {}) {
  const store = new Map<string, string>()
  if (opts.overridesRaw != null) store.set('incident:duration-overrides', opts.overridesRaw)
  const puts: Array<{ key: string; value: string }> = []
  const reads = { overrides: 0 }
  const kv = {
    get: async (key: string) => {
      if (key === 'incident:duration-overrides') {
        reads.overrides++
        if (opts.faultOnOverrides) throw new Error('KV unavailable')
      }
      // Answer ANY `incidents:monthly:` period. The handler derives the previous month with LOCAL
      // date getters, so the exact key depends on the runner's timezone; seeding one fixed period
      // left `incidentData` null under some of them, which skips the build's whole override block.
      if (key.startsWith('incidents:monthly:')) return PAPERWORK_ACCUMULATOR
      return store.get(key) ?? null
    },
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (key: string, value: string) => { puts.push({ key, value }); store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
  return { kv, puts, reads }
}

async function runCron(kv: KVNamespace) {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(fetchAllServices).mockResolvedValue({ raw: OPERATIONAL, enriched: OPERATIONAL, pageComponents: {}, upstreamFeeds: [] })
  // A FRESH Response per call — one shared instance gets its body cancelled by the first consumer
  // and every later read throws "ReadableStream is locked", surfacing as an unhandled rejection
  // rather than a failed assertion.
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }))
  await workerModule.scheduled(ARCHIVE_EVENT, { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: 'https://example.invalid/hook' } as never, ctx)
  return fetchSpy
}

/** The write this cron made to a permanent monthly-archive key. */
function archiveWrite(puts: Array<{ key: string; value: string }>) {
  const rows = puts.filter(p => p.key.startsWith('archive:monthly:'))
  expect(rows, 'exactly one permanent archive write per cycle').toHaveLength(1)
  const parsed = JSON.parse(rows[0].value)
  // The event is 2026-08-01T00:07Z, so the archive must be the UTC previous month. Checking only
  // key/value self-consistency would let a `getMonth()` mutation select the current month.
  expect(rows[0].key).toBe('archive:monthly:2026-07')
  expect(parsed.period).toBe('2026-07')
  return parsed
}

/** The override-missing alert body, or '' if none was sent. */
function alertBody(fetchSpy: { mock: { calls: unknown[][] } }) {
  return fetchSpy.mock.calls
    .map((c) => String((c[1] as RequestInit | undefined)?.body ?? ''))
    .find(b => b.includes('WITHOUT duration overrides')) ?? ''
}

describe('month-end cron — a bad duration-override read is announced, never silent (#1274)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('applies the override and reads the list exactly ONCE', async () => {
    // The read count is the direct statement that the build CONSUMED the cron's read rather than
    // taking its own. A second read is the whole defect (#1260's shape): the caller's read succeeds,
    // the build's own read faults, `[]` comes back, and the un-corrected duration is archived.
    const { kv, puts, reads } = makeKv({ overridesRaw: JSON.stringify([{ id: 'inc-1', durationMin: 18 }]) })

    const fetchSpy = await runCron(kv)

    expect(archiveWrite(puts).services?.claude?.longestIncidentMin, 'the pinned duration').toBe(18)
    expect(reads.overrides, 'a second read re-opens the gap this closes').toBe(1)
    expect(alertBody(fetchSpy), 'a healthy cycle must stay quiet').toBe('')
  })

  it('still archives when the list cannot be read, rather than losing the month', async () => {
    // Refusing here would be worse than the bug: `if (!existing)` means nothing revisits a skipped
    // month, and the sources a later rebuild would need expire. The month survives; the duration is
    // wrong and said so.
    const { kv, puts } = makeKv({ faultOnOverrides: true })

    const fetchSpy = await runCron(kv)

    expect(archiveWrite(puts).services?.claude?.longestIncidentMin, 'un-corrected, as announced').toBe(800)
    expect(alertBody(fetchSpy), 'the operator must be told the month went out without its overrides').not.toBe('')
  })

  it('does the same for a list that parses but holds an unusable row', async () => {
    // A quoted `"18"` normalizes to nothing, so it reads as "no overrides configured" with no KV
    // fault at all. Asserting the ALERT here too, not just the write: a test whose only assertion is
    // an absence passes for every reason, including the wrong one.
    const { kv, puts } = makeKv({ overridesRaw: '[{"id":"inc-1","durationMin":"18"}]' })

    const fetchSpy = await runCron(kv)

    expect(archiveWrite(puts).services?.claude?.longestIncidentMin).toBe(800)
    expect(alertBody(fetchSpy)).not.toBe('')
  })

  it('is quiet when the list is merely absent — a fault is not an empty list', async () => {
    // The negative control. Without it, alerting unconditionally would pass every test above, and
    // one spurious monthly alert trains the operator to skim past the real one.
    const { kv, puts } = makeKv({ overridesRaw: null })

    const fetchSpy = await runCron(kv)

    expect(archiveWrite(puts).services?.claude?.longestIncidentMin, 'nothing configured → stored duration stands').toBe(800)
    expect(alertBody(fetchSpy), 'an absent list is a real answer, not a fault').toBe('')
  })
})
