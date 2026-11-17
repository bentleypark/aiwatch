// #2009 — the is-down "Check connection" counter: ingest route → WAE blob, and the daily read.
import { describe, it, expect, vi } from 'vitest'
import workerModule from '../index'
import { parseDeviceCheckBody, queryDeviceChecks, DEVICE_CHECK_INDEX, DEVICE_CHECK_OUTCOMES } from '../device-check-click'
import { buildClickRateSql, buildHistoryClickSql, parseClickRateResponse } from '../history-click'
import { DEVICE_CHECK_READABLE, DEVICE_CHECK_UNREADABLE } from '../device-check-readable'
import { formatDeviceCheckLine } from '../daily-summary'
import { AUDIENCE_UNKNOWN_SCREEN } from '../outage-audience'

const ORIGIN = 'https://ai-watch.dev'
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

function makeEnv() {
  const writeDataPoint = vi.fn()
  return { writeDataPoint, env: { ALLOWED_ORIGIN: ORIGIN, ANALYTICS: { writeDataPoint } as unknown as AnalyticsEngineDataset } as never }
}
const post = (body: unknown, origin = ORIGIN) => new Request('https://worker.example/api/device-check', {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

describe('POST /api/device-check → WAE', () => {
  it('records [svc, phase, agent, surface, outcome] under its own index', async () => {
    const { env, writeDataPoint } = makeEnv()
    const res = await workerModule.fetch(post({ svc: 'openai', active: true, surface: 'group', outcome: 'timeout' }), env, ctx)
    expect(res.status).toBe(204)
    expect(writeDataPoint).toHaveBeenCalledTimes(1)
    expect(writeDataPoint.mock.calls[0][0]).toEqual({ blobs: ['openai', 'active', 'unflagged', 'group', 'timeout'], doubles: [1], indexes: ['isdown-device-check'] })
  })

  it('answers the CORS preflight without recording', async () => {
    const { env, writeDataPoint } = makeEnv()
    const res = await workerModule.fetch(new Request('https://worker.example/api/device-check', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env, ctx)
    expect(res.status).toBe(204)
    expect(writeDataPoint).not.toHaveBeenCalled()
  })

  it('rejects a non-allowlisted origin without recording', async () => {
    const { env, writeDataPoint } = makeEnv()
    const res = await workerModule.fetch(post({ svc: 'openai', active: false, outcome: 'ok' }, 'https://evil.example'), env, ctx)
    expect(res.status).toBe(403)
    expect(writeDataPoint).not.toHaveBeenCalled()
  })

  it('rejects a body with no service id or an outcome outside the fixed list', async () => {
    const { env, writeDataPoint } = makeEnv()
    expect((await workerModule.fetch(post({ active: true, outcome: 'ok' }), env, ctx)).status).toBe(400)
    expect((await workerModule.fetch(post({ svc: 'openai', active: true, outcome: 'made-up' }), env, ctx)).status).toBe(400)
    expect((await workerModule.fetch(post({ svc: 'openai', active: true }), env, ctx)).status).toBe(400)
    expect(writeDataPoint).not.toHaveBeenCalled()
  })
})

describe('parseDeviceCheckBody', () => {
  const ids = new Set(['openai'])
  it('bounds an unknown id to the shared sentinel instead of minting a bucket', () => {
    expect(parseDeviceCheckBody({ svc: 'made-up', active: true, surface: 'service', outcome: 'ok' }, ids))
      .toEqual({ svc: AUDIENCE_UNKNOWN_SCREEN, active: true, surface: 'service', outcome: 'ok' })
  })
  it('treats anything but literal true as a clear page, and an undeclared surface as unknown', () => {
    expect(parseDeviceCheckBody({ svc: 'openai', active: 'true', surface: 'sidebar', outcome: 'error' }, ids))
      .toEqual({ svc: 'openai', active: false, surface: 'unknown', outcome: 'error' })
  })
  it('accepts every outcome the page can send and nothing else', () => {
    for (const outcome of DEVICE_CHECK_OUTCOMES) expect(parseDeviceCheckBody({ svc: 'openai', outcome }, ids)?.outcome).toBe(outcome)
    expect(parseDeviceCheckBody({ svc: 'openai', outcome: 'OK' }, ids)).toBeNull()
  })
})

describe('daily read', () => {
  it('reads clicks over the is-down views, bots excluded on both sides', () => {
    const sql = buildClickRateSql(DEVICE_CHECK_INDEX)
    expect(sql).toContain("index1 = 'isdown-device-check' AND blob3 != 'bot'")
    expect(sql).toContain("index1 = 'isdown-view' AND blob4 IN ('service', 'group') AND blob5 != 'bot'")
    expect(sql).toContain("INTERVAL '1' DAY")
    expect(sql).toContain('SUM(_sample_interval)')
    expect(sql).toContain('GROUP BY index1, blob2')
  })

  it("pairs each phase's checks with that phase's views", () => {
    expect(parseClickRateResponse({ data: [
      { kind: 'isdown-device-check', phase: 'active', n: 2 },
      { kind: 'isdown-device-check', phase: 'clear', n: '6' },
      { kind: 'isdown-history-click', phase: 'clear', n: 9 },
      { kind: 'isdown-view', phase: 'active', n: 40 },
      { kind: 'isdown-view', phase: 'clear', n: 260 },
    ] }, DEVICE_CHECK_INDEX)).toEqual({ active: { clicks: 2, views: 40 }, clear: { clicks: 6, views: 260 } })
    expect(parseClickRateResponse({}, DEVICE_CHECK_INDEX)).toBeNull()
  })

  it('returns null without credentials and never calls the API', async () => {
    const fetchImpl = vi.fn()
    expect(await queryDeviceChecks(undefined, 'tok', fetchImpl as never)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends the device-check query, not the history-link one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ kind: 'isdown-device-check', phase: 'clear', n: 1 }] })))
    const counts = await queryDeviceChecks('acc', 'tok', fetchImpl as never)
    expect(String(fetchImpl.mock.calls[0][1].body)).toContain("index1 = 'isdown-device-check'")
    expect(counts).toEqual({ active: { clicks: 0, views: 0 }, clear: { clicks: 1, views: 0 } })
  })

  it('divides by the views of the pages that carry the button: every family page, and the service pages of readable providers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] })))
    await queryDeviceChecks('acc', 'tok', fetchImpl as never)
    const sql = String(fetchImpl.mock.calls[0][1].body)
    expect(sql).toContain("blob5 != 'bot' AND (blob4 = 'group' OR blob3 IN (")
    const listed = [...sql.match(/blob3 IN \(([^)]*)\)/)![1].matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1])
    expect(listed.sort()).toEqual(Object.keys(DEVICE_CHECK_READABLE).sort())
    for (const id of [...DEVICE_CHECK_UNREADABLE, 'chatgpt', 'claudeai', 'claudecode', 'codex']) expect(listed).not.toContain(id)
  })

  it('leaves the history-link query on every is-down view', () => {
    expect(buildHistoryClickSql()).not.toContain('blob3 IN')
  })
})

describe('formatDeviceCheckLine', () => {
  it("prints each phase as checks over that phase's views", () => {
    expect(formatDeviceCheckLine({ active: { clicks: 1, views: 40 }, clear: { clicks: 4, views: 260 } }))
      .toBe('🌐 **Check Connection** (24h): during outages 1 checks / 40 views · clear 4 checks / 260 views')
  })

  it('renders a zero-check day, so every day of the window leaves a line', () => {
    expect(formatDeviceCheckLine({ active: { clicks: 0, views: 0 }, clear: { clicks: 0, views: 12 } })).toContain('clear 0 checks / 12 views')
  })

  it('is empty when the read is unconfigured', () => {
    expect(formatDeviceCheckLine(null)).toBe('')
  })
})
