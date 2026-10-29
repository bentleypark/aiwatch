// #1839 — the weekly briefing's Stability Trend, driven through the real cron. The pure gates are
// pinned in weekly-briefing.test.ts; this pins that the cron calls them with the window fields intact.

import { describe, it, expect, vi, afterEach } from 'vitest'
import workerModule from '../index'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

// Sunday 00:02 UTC — the briefing window. The previous week is `history:` 7..13 days back.
const SUNDAY = { scheduledTime: Date.parse('2026-08-02T00:02:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent
const PREV_WEEK_DAY = '2026-07-26'
// The oldest day of that week. Its GroqCloud figure differs, so reading the week oldest-first shows.
const PREV_WEEK_OLDEST = '2026-07-20'

function makeKv(store: Record<string, string>) {
  return {
    get: async (key: string) => store[key] ?? null,
    getWithMetadata: async () => ({ value: null, metadata: null }),
    // The same cron refreshes `services:latest` from the (mocked, empty) status pages before the
    // briefing reads it; dropping that write keeps the seeded snapshot as the briefing's input.
    put: async (key: string, value: string) => { if (key !== 'services:latest') store[key] = value },
    delete: async (key: string) => { delete store[key] },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
}

async function stabilitySection(live: object[], prevRow: Record<string, object>) {
  const kv = makeKv({
    'services:latest': JSON.stringify(live),
    [`history:${PREV_WEEK_DAY}`]: JSON.stringify(prevRow),
    [`history:${PREV_WEEK_OLDEST}`]: JSON.stringify({ groq: { ok: 288, total: 288, officialUptime: 95.0 } }),
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }))
  await workerModule.scheduled(SUNDAY, { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: 'https://example.invalid/hook' } as never, ctx)
  const body = fetchSpy.mock.calls
    .map(([, init]) => String((init as RequestInit | undefined)?.body ?? ''))
    .find(b => b.includes('Weekly Briefing')) ?? ''
  const description = (JSON.parse(body || '{"embeds":[{}]}').embeds[0].description ?? '') as string
  return description.slice(description.indexOf('Stability Trend'))
}

describe('weekly briefing Stability Trend skips short-window uptime (#1839)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const groqLive = { id: 'groq', uptime30d: 99.5 }
  const groqPrev = { ok: 288, total: 288, officialUptime: 97.0 }

  it('drops a live figure that carries uptimeWindowDays', async () => {
    const section = await stabilitySection(
      [groqLive, { id: 'helicone', uptime30d: 100, uptimeWindowDays: 1 }],
      { groq: groqPrev, helicone: { ok: 288, total: 288, officialUptime: 91.22 } },
    )
    expect(section, 'the full-window pair must still reach the section').toContain('GroqCloud (97.0% → 99.5%)')
    expect(section).not.toContain('Helicone')
  })

  it('drops a previous-week snapshot that carries officialUptimeWindowDays', async () => {
    const section = await stabilitySection(
      [groqLive, { id: 'helicone', uptime30d: 91.22 }],
      { groq: groqPrev, helicone: { ok: 288, total: 288, officialUptime: 100, officialUptimeWindowDays: 2 } },
    )
    expect(section).toContain('GroqCloud (97.0% → 99.5%)')
    expect(section).not.toContain('Helicone')
  })
})
