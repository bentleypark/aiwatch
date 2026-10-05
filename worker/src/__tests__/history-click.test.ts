// #1612 — the is-down "View 30-day history" click counter: ingest route → WAE blob, and the daily read.
import { describe, it, expect, vi } from 'vitest'
import workerModule from '../index'
import { parseHistoryClickBody, buildHistoryClickSql, parseHistoryClickResponse, queryHistoryClicks } from '../history-click'
import { formatHistoryClickLine } from '../daily-summary'
import { AUDIENCE_UNKNOWN_SCREEN } from '../outage-audience'

const ORIGIN = 'https://ai-watch.dev'
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

function makeEnv() {
  const writeDataPoint = vi.fn()
  return { writeDataPoint, env: { ALLOWED_ORIGIN: ORIGIN, ANALYTICS: { writeDataPoint } as unknown as AnalyticsEngineDataset } as never }
}
const post = (body: unknown, origin = ORIGIN) => new Request('https://worker.example/api/history-click', {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

describe('POST /api/history-click → WAE', () => {
  it('records [svc, phase, agent, surface] under its own index', async () => {
    const { env, writeDataPoint } = makeEnv()
    const res = await workerModule.fetch(post({ svc: 'openai', active: true, surface: 'group' }), env, ctx)
    expect(res.status).toBe(204)
    expect(writeDataPoint).toHaveBeenCalledTimes(1)
    expect(writeDataPoint.mock.calls[0][0]).toEqual({ blobs: ['openai', 'active', 'unflagged', 'group'], doubles: [1], indexes: ['isdown-history-click'] })
  })

  it('rejects a non-allowlisted origin without recording', async () => {
    const { env, writeDataPoint } = makeEnv()
    const res = await workerModule.fetch(post({ svc: 'openai', active: false }, 'https://evil.example'), env, ctx)
    expect(res.status).toBe(403)
    expect(writeDataPoint).not.toHaveBeenCalled()
  })

  it('rejects a body with no service id', async () => {
    const { env, writeDataPoint } = makeEnv()
    const res = await workerModule.fetch(post({ active: true }), env, ctx)
    expect(res.status).toBe(400)
    expect(writeDataPoint).not.toHaveBeenCalled()
  })
})

describe('parseHistoryClickBody', () => {
  const ids = new Set(['openai'])
  it('bounds an unknown id to the shared sentinel instead of minting a bucket', () => {
    expect(parseHistoryClickBody({ svc: 'made-up', active: true, surface: 'service' }, ids)).toEqual({ svc: AUDIENCE_UNKNOWN_SCREEN, active: true, surface: 'service' })
  })
  it('treats anything but literal true as a clear page, and an undeclared surface as unknown', () => {
    expect(parseHistoryClickBody({ svc: 'openai', active: 'true', surface: 'sidebar' }, ids)).toEqual({ svc: 'openai', active: false, surface: 'unknown' })
  })
})

describe('daily read', () => {
  it('reads clicks and the views of the pages carrying the link, bots excluded on both sides', () => {
    const sql = buildHistoryClickSql()
    expect(sql).toContain("index1 = 'isdown-history-click' AND blob3 != 'bot'")
    expect(sql).toContain("index1 = 'isdown-view' AND blob4 IN ('service', 'group') AND blob5 != 'bot'")
    expect(sql).toContain("INTERVAL '1' DAY")
    expect(sql).toContain('SUM(_sample_interval)')
    expect(sql).toContain('GROUP BY index1, blob2')
  })

  it("pairs each phase's clicks with that phase's views", () => {
    expect(parseHistoryClickResponse({ data: [
      { kind: 'isdown-history-click', phase: 'active', n: 3 },
      { kind: 'isdown-history-click', phase: 'clear', n: '5' },
      { kind: 'isdown-view', phase: 'active', n: 40 },
      { kind: 'isdown-view', phase: 'clear', n: 260 },
    ] })).toEqual({ active: { clicks: 3, views: 40 }, clear: { clicks: 5, views: 260 } })
    expect(parseHistoryClickResponse({})).toBeNull()
  })

  it('returns null without credentials and never calls the API', async () => {
    const fetchImpl = vi.fn()
    expect(await queryHistoryClicks(undefined, 'tok', fetchImpl as never)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('formatHistoryClickLine', () => {
  it("prints each phase as clicks over that phase's views", () => {
    expect(formatHistoryClickLine({ active: { clicks: 1, views: 40 }, clear: { clicks: 4, views: 260 } }))
      .toBe('📜 **30-day History Link** (24h): during outages 1 clicks / 40 views · clear 4 clicks / 260 views')
  })

  it('renders a zero-click day, so every day of the window leaves a line', () => {
    expect(formatHistoryClickLine({ active: { clicks: 0, views: 0 }, clear: { clicks: 0, views: 12 } })).toContain('clear 0 clicks / 12 views')
  })

  it('is empty when the read is unconfigured', () => {
    expect(formatHistoryClickLine(null)).toBe('')
  })
})
