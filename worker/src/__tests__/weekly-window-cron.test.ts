// The weekly briefing's window, driven through the real cron: the run is Sunday 00:00–00:04 UTC, so
// the Sunday after the previous run must be read by THIS run, and the run's own day by the next one.

import { describe, it, expect, vi, afterEach } from 'vitest'
import workerModule from '../index'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

// Window of this run: 2026-07-26 (the Sunday after the previous run) .. 2026-08-01.
const SUNDAY_RUN = { scheduledTime: Date.parse('2026-08-02T00:02:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent

function makeKv(store: Record<string, string>, failDelete = false) {
  return {
    get: async (key: string) => store[key] ?? null,
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (key: string, value: string) => { if (key !== 'services:latest') store[key] = value },
    delete: async (key: string) => { if (failDelete) throw new Error('KV delete failed'); delete store[key] },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
}

function incident(id: string, startedAt: string) {
  return { id, title: `Incident ${id}`, startedAt, resolvedAt: startedAt, durationMin: 30, status: 'resolved' }
}

function monthly(...incidents: ReturnType<typeof incident>[]) {
  return JSON.stringify({ lastUpdated: '2026-08-02T00:00:00Z', services: { claude: { count: incidents.length, totalMinutes: 30 * incidents.length, longestMinutes: 30, dates: [], incidentIds: incidents.map((i) => i.id), durations: {}, incidents } } })
}

async function briefing(store: Record<string, string>, run: ScheduledEvent = SUNDAY_RUN, failDelete = false) {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }))
  await workerModule.scheduled(run, { STATUS_CACHE: makeKv(store, failDelete), DISCORD_WEBHOOK_URL: 'https://example.invalid/hook' } as never, ctx)
  const body = fetchSpy.mock.calls
    .map(([, init]) => String((init as RequestInit | undefined)?.body ?? ''))
    .find((b) => b.includes('Weekly Briefing')) ?? ''
  expect(body, 'the briefing must have been sent at all').not.toBe('')
  return JSON.parse(body).embeds[0] as { title: string; description: string }
}

describe('weekly briefing window (the Sunday run)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('is titled with the 7 complete days before the run', async () => {
    const { title } = await briefing({})
    expect(title).toBe('📋 Weekly Briefing (2026-07-26 ~ 2026-08-01)')
  })

  it('counts an incident from the Sunday after the previous run, and none from the run day itself', async () => {
    const { description } = await briefing({
      'incidents:monthly:2026-07': monthly(incident('before-window', '2026-07-25T12:00:00Z'), incident('sun-in-window', '2026-07-26T12:00:00Z')),
      'incidents:monthly:2026-08': monthly(incident('run-day', '2026-08-02T00:01:00Z'), incident('sat-in-window', '2026-08-01T23:30:00Z')),
    })
    expect(description).toContain('2 incident records across 1 services')
  })

  it('reports the changelog entries of the window only, and clears the buffer', async () => {
    const entry = (title: string, date: string) => ({ source: 'anthropic', title, url: `https://example.invalid/${title}`, date })
    const store: Record<string, string> = {
      'changelog:entries': JSON.stringify([
        entry('before-window', '2026-07-25T23:00:00Z'),
        entry('in-window', '2026-07-26T08:00:00Z'),
        entry('run-day-entry', '2026-08-02T00:01:00Z'),
      ]),
    }
    const { description } = await briefing(store)
    expect(description).toContain('in-window')
    expect(description).not.toContain('before-window')
    expect(description).not.toContain('run-day-entry')
    expect(store['changelog:entries']).toBeUndefined()
  })

  it('does not report an entry twice when the buffer cleanup fails', async () => {
    const store: Record<string, string> = {
      'changelog:entries': JSON.stringify([{ source: 'anthropic', title: 'in-window', url: 'https://example.invalid/a', date: '2026-07-26T08:00:00Z' }]),
    }
    const first = await briefing(store, SUNDAY_RUN, true)
    expect(first.description).toContain('in-window')
    expect(store['changelog:entries'], 'the failed cleanup left the entry in the buffer').toBeDefined()

    vi.restoreAllMocks()
    for (const key of Object.keys(store)) if (key.startsWith('weekly-briefing:')) delete store[key]
    const next = await briefing(store, { scheduledTime: Date.parse('2026-08-09T00:02:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent)
    expect(next.description).not.toContain('in-window')
  })

  it('reads the ai:usage keys of the same window, so an enrich count booked on that Sunday reaches the line', async () => {
    const day = (n: number) => JSON.stringify({ calls: 4, success: 4, failed: 0, gemma: 4, gemmaAttempts: 4, aiLessSent: n, enriched: n })
    const { description } = await briefing({
      'ai:usage:2026-07-25': day(9),
      'ai:usage:2026-07-26': day(1),
      'ai:usage:2026-08-01': day(1),
      'ai:usage:2026-08-02': day(5),
    })
    expect(description).toContain('2 sent without AI, 2 edited in, 0 not edited, 0 expired')
  })
})
