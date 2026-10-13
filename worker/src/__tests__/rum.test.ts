import { describe, it, expect, vi, afterEach } from 'vitest'
import workerModule from '../index'
import {
  parseRumBatch, evaluateRum, applyRumVerdict, recordRumSamples, withServerTiming, rumAlertKey, formatRumAlert,
  RUM_INDEX, RUM_SLOW_MS, type RumSample,
} from '../rum'
import { INFRA_STATUS_KEY } from '../infra-status'
import { mockKV } from './helpers/unreadable-source'

const ok = (totalMs: number, serverMs: number | null = 200): RumSample => ({ totalMs, serverMs, outcome: 'ok' })
const SLOW = RUM_SLOW_MS + 5_000

describe('#1686 parseRumBatch', () => {
  it('accepts a batch and rounds the timings', () => {
    expect(parseRumBatch({ samples: [{ totalMs: 1234.6, serverMs: 12.4, outcome: 'ok' }] }))
      .toEqual([{ totalMs: 1235, serverMs: 12, outcome: 'ok' }])
  })
  it('caps an oversized timing instead of rejecting the batch', () => {
    const batch = parseRumBatch({ samples: [{ totalMs: 700_000, outcome: 'pending' }, { totalMs: 900, outcome: 'ok' }] })
    expect(batch?.map((s) => s.totalMs)).toEqual([600_000, 900])
  })
  it('keeps a missing worker time as null', () => {
    expect(parseRumBatch({ samples: [{ totalMs: 5, outcome: 'timeout' }] })?.[0].serverMs).toBeNull()
  })
  it.each([
    ['no samples', {}],
    ['empty', { samples: [] }],
    ['too many', { samples: Array.from({ length: 11 }, () => ({ totalMs: 1, outcome: 'ok' })) }],
    ['negative', { samples: [{ totalMs: -1, outcome: 'ok' }] }],
    ['not finite', { samples: [{ totalMs: Infinity, outcome: 'ok' }] }],
    ['unknown outcome', { samples: [{ totalMs: 1, outcome: 'slow' }] }],
    ['bad worker time', { samples: [{ totalMs: 1, serverMs: 'x', outcome: 'ok' }] }],
  ])('rejects %s', (_, body) => {
    expect(parseRumBatch(body)).toBeNull()
  })
})

describe('#1686 evaluateRum — 4 of the last 5', () => {
  it('needs five samples', () => {
    expect(evaluateRum([ok(SLOW), ok(SLOW), ok(SLOW), ok(SLOW)]).kind).toBe('too-few')
  })
  it('4 slow of 5 is slow; 3 is between; 1 is healthy', () => {
    expect(evaluateRum([ok(SLOW), ok(SLOW), ok(SLOW), ok(SLOW), ok(100)]).kind).toBe('slow')
    expect(evaluateRum([ok(SLOW), ok(SLOW), ok(SLOW), ok(100), ok(100)]).kind).toBe('between')
    expect(evaluateRum([ok(SLOW), ok(100), ok(100), ok(100), ok(100)]).kind).toBe('healthy')
  })
  it('judges only the last five of a longer batch', () => {
    expect(evaluateRum([ok(SLOW), ok(SLOW), ok(SLOW), ok(SLOW), ok(100), ok(100), ok(100), ok(100), ok(100)]).kind).toBe('healthy')
  })
  it('the threshold is inclusive', () => {
    expect(evaluateRum(Array.from({ length: 5 }, () => ok(RUM_SLOW_MS))).kind).toBe('slow')
    expect(evaluateRum(Array.from({ length: 5 }, () => ok(RUM_SLOW_MS - 1))).kind).toBe('healthy')
  })
  it('a timeout counts as slow whatever its elapsed time', () => {
    const t: RumSample = { totalMs: 100, serverMs: null, outcome: 'timeout' }
    expect(evaluateRum([t, t, t, t, ok(100)]).kind).toBe('slow')
  })
  it('a pending lower bound under the threshold is neither slow nor healthy evidence', () => {
    const p = (ms: number): RumSample => ({ totalMs: ms, serverMs: null, outcome: 'pending' })
    expect(evaluateRum([ok(SLOW), p(2000), p(2500), p(1800), p(3000)]).kind).toBe('too-few')
    expect(evaluateRum([ok(SLOW), ok(SLOW), ok(SLOW), ok(SLOW), p(2000), p(2000), ok(100)]).kind).toBe('slow')
  })
  it('a pending lower bound at or over the threshold counts slow — the slowest polls are cut off as pending', () => {
    const p: RumSample = { totalMs: 60_000, serverMs: 200, outcome: 'pending' }
    expect(evaluateRum([p, p, p, p, p])).toMatchObject({ kind: 'slow', cause: 'network-path' })
  })
  it('an alert with no worker time carries no cause line', () => {
    const v = evaluateRum(Array.from({ length: 5 }, () => ok(SLOW, null)))
    if (v.kind !== 'slow') throw new Error(v.kind)
    const { description } = formatRumAlert(v, 'SEA', 'KR', [])
    expect(description.split('\n')).toHaveLength(2)
    expect(description).not.toContain('undefined')
  })
  it('a fast error is not slow', () => {
    const e: RumSample = { totalMs: 100, serverMs: null, outcome: 'error' }
    expect(evaluateRum([e, e, e, e, e]).kind).toBe('healthy')
  })
  it('splits the cause by the worker time of the slow polls', () => {
    const slowWith = (server: number | null) => evaluateRum(Array.from({ length: 5 }, () => ok(SLOW, server)))
    expect(slowWith(200)).toMatchObject({ kind: 'slow', cause: 'network-path', medianServerMs: 200 })
    expect(slowWith(4_000)).toMatchObject({ kind: 'slow', cause: 'worker' })
    expect(slowWith(null)).toMatchObject({ kind: 'slow', cause: 'unknown', medianServerMs: null })
  })
})

describe('#1686 applyRumVerdict', () => {
  const slow = evaluateRum(Array.from({ length: 5 }, () => ok(SLOW)))
  const healthy = evaluateRum(Array.from({ length: 5 }, () => ok(100)))

  it('alerts once per country, then not again while the key is held', async () => {
    const kv = mockKV()
    const send = vi.fn(async () => true)
    expect(await applyRumVerdict(kv as never, send, slow, 'SEA', 'KR')).toBe('alerted')
    expect(await applyRumVerdict(kv as never, send, slow, 'SEA', 'KR')).toBe('none')
    expect(send).toHaveBeenCalledTimes(1)
    expect(kv.store[rumAlertKey('KR', 'SEA')]).toBe('slow')
    const embed = (send.mock.calls[0] as unknown as [{ title: string; description: string }])[0]
    expect(embed.title).toContain('KR via SEA')
    expect(embed.description).toContain('network path')
  })
  it('a healthy batch after an alert sends the recovery and holds the path as recovered', async () => {
    const kv = mockKV({ [rumAlertKey('KR', 'SEA')]: 'slow' })
    const send = vi.fn(async () => true)
    expect(await applyRumVerdict(kv as never, send, healthy, 'SEA', 'KR')).toBe('recovered')
    expect(kv.store[rumAlertKey('KR', 'SEA')]).toBe('recovered')
  })
  it('alerts and recovers per country AND colo — a user served normally elsewhere does not clear a slow path', async () => {
    const kv = mockKV()
    const send = vi.fn(async () => true)
    expect(await applyRumVerdict(kv as never, send, slow, 'SEA', 'KR')).toBe('alerted')
    expect(await applyRumVerdict(kv as never, send, healthy, 'ICN', 'KR')).toBe('none')
    expect(await applyRumVerdict(kv as never, send, slow, 'NRT', 'KR')).toBe('alerted')
    expect(await applyRumVerdict(kv as never, send, healthy, 'SEA', 'KR')).toBe('recovered')
    expect(kv.store[rumAlertKey('KR', 'NRT')]).toBe('slow')
  })
  it('alternating slow and healthy batches on one path send at most one alert and one recovery per hold', async () => {
    const kv = mockKV()
    const send = vi.fn(async () => true)
    for (let i = 0; i < 3; i++) {
      await applyRumVerdict(kv as never, send, slow, 'ICN', 'KR')
      await applyRumVerdict(kv as never, send, healthy, 'ICN', 'KR')
    }
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('a healthy batch with no alert held does nothing', async () => {
    const send = vi.fn(async () => true)
    expect(await applyRumVerdict(mockKV() as never, send, healthy, 'ICN', 'KR')).toBe('none')
    expect(send).not.toHaveBeenCalled()
  })
  it('keeps the key unset when the send fails, so the next batch retries', async () => {
    const kv = mockKV()
    expect(await applyRumVerdict(kv as never, async () => false, slow, 'SEA', 'KR')).toBe('none')
    expect(kv.store[rumAlertKey('KR', 'SEA')]).toBeUndefined()
  })
  it('attaches the affected platforms from the last infra cycle', async () => {
    const kv = mockKV({
      [INFRA_STATUS_KEY]: JSON.stringify([
        { id: 'cloudflare', name: 'Cloudflare', status: 'degraded', affected: [{ name: 'Workers', status: 'degraded' }], incidents: ['Workers API'], missing: [] },
        { id: 'github', name: 'GitHub', status: 'operational', affected: [], incidents: [], missing: [] },
      ]),
    })
    const send = vi.fn(async () => true)
    await applyRumVerdict(kv as never, send, slow, 'SEA', 'KR')
    const { description } = (send.mock.calls[0] as unknown as [{ description: string }])[0]
    expect(description).toContain('Cloudflare')
    expect(description).toContain('Workers degraded')
    expect(description).not.toContain('GitHub')
  })
})

describe('#1686 recordRumSamples', () => {
  it('writes one data point per sample with colo and country', () => {
    const writeDataPoint = vi.fn()
    recordRumSamples({ writeDataPoint } as never, [ok(1500, 30), { totalMs: 15000, serverMs: null, outcome: 'timeout' }], 'SEA', 'KR')
    expect(writeDataPoint).toHaveBeenNthCalledWith(1, { blobs: ['SEA', 'KR', 'ok'], doubles: [1500, 30], indexes: [RUM_INDEX] })
    expect(writeDataPoint).toHaveBeenNthCalledWith(2, { blobs: ['SEA', 'KR', 'timeout'], doubles: [15000, -1], indexes: [RUM_INDEX] })
  })
})

describe('#1686 withServerTiming', () => {
  const get = (path: string) => new Request(`https://w.example${path}`)
  it('adds the worker time and exposes it on the two polled endpoints', () => {
    for (const path of ['/api/status', '/api/status/cached']) {
      const res = withServerTiming(get(path), 1_000, new Response('{}', { headers: { 'Access-Control-Expose-Headers': 'ETag' } }), 1_250)
      expect(res.headers.get('Server-Timing')).toBe('worker;dur=250')
      expect(res.headers.get('Access-Control-Expose-Headers')).toBe('ETag, Server-Timing')
    }
  })
  it('leaves every other route alone', () => {
    const original = new Response('{}')
    expect(withServerTiming(get('/api/vitals'), 0, original, 10)).toBe(original)
  })
})

describe('#1686 worker wiring', () => {
  afterEach(() => vi.restoreAllMocks())
  const env = (extra: Record<string, unknown> = {}) => ({ ALLOWED_ORIGIN: '*', ...extra }) as Parameters<typeof workerModule.fetch>[1]

  it('/api/status/cached responses carry Server-Timing through the real fetch handler', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await workerModule.fetch(new Request('https://w.example/api/status/cached'), env({ STATUS_CACHE: mockKV() }), { waitUntil() {} } as never)
    expect(res.headers.get('Server-Timing')).toMatch(/^worker;dur=\d+$/)
  })
  it('/api/rum accepts a batch and writes it to WAE', async () => {
    const writeDataPoint = vi.fn()
    const body = JSON.stringify({ samples: [ok(1500, 30)] })
    const res = await workerModule.fetch(
      new Request('https://w.example/api/rum', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ai-watch.dev' }, body }),
      env({ ANALYTICS: { writeDataPoint } }), { waitUntil() {} } as never,
    )
    expect(res.status).toBe(204)
    expect(writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({ indexes: [RUM_INDEX] }))
  })
  it('/api/rum refuses a request from an origin outside the allowlist', async () => {
    const writeDataPoint = vi.fn()
    const res = await workerModule.fetch(
      new Request('https://w.example/api/rum', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ samples: [ok(1)] }) }),
      env({ ALLOWED_ORIGIN: 'https://ai-watch.dev', ANALYTICS: { writeDataPoint } }), { waitUntil() {} } as never,
    )
    expect(res.status).toBe(403)
    expect(writeDataPoint).not.toHaveBeenCalled()
  })
  it('/api/rum turns a slow batch into the operator alert', async () => {
    const kv = mockKV()
    const discord = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    const pending: Promise<unknown>[] = []
    const res = await workerModule.fetch(
      new Request('https://w.example/api/rum', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ai-watch.dev' }, body: JSON.stringify({ samples: Array.from({ length: 5 }, () => ok(SLOW)) }) }),
      env({ STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: 'https://discord.example/hook' }), { waitUntil: (p: Promise<unknown>) => pending.push(p) } as never,
    )
    await Promise.all(pending)
    expect(res.status).toBe(204)
    expect(discord).toHaveBeenCalledWith('https://discord.example/hook', expect.objectContaining({ method: 'POST' }))
    expect(kv.store[rumAlertKey('XX', 'UNK')]).toBe('slow')
  })
  it('/api/rum rejects a malformed batch', async () => {
    const res = await workerModule.fetch(
      new Request('https://w.example/api/rum', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ai-watch.dev' }, body: '{"samples":[]}' }),
      env(), { waitUntil() {} } as never,
    )
    expect(res.status).toBe(400)
  })
})
