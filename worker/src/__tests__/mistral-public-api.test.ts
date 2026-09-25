import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  readPublicApi,
  listsAnIncident,
  recordPublicApiSample,
  recordPublicApiObservation,
  runMistralPublicApiProbe,
  MISTRAL_PUBLIC_API_BASE,
  MISTRAL_PUBLIC_API_INDEX,
  MISTRAL_PUBLIC_API_SOURCE,
  MISTRAL_PUBLIC_SAMPLE_KV_KEY,
  type PublicApiFetch,
  type PublicApiResult,
} from '../mistral-public-api'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})
import { SERVICES, fetchAllServices } from '../services'
import type { ServiceStatus } from '../services'
import workerModule from '../index'
import { mockKV, TEST_TIMEOUT_MS } from './helpers/unreadable-source'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const STATUS_QUIET = JSON.stringify({ page: { name: 'Mistral AI Status' }, status: { indicator: 'none', description: 'All Systems Operational' }, incidents: [] })
const INCIDENTS_QUIET = JSON.stringify({ page: { name: 'Mistral AI Status' }, incidents: [], pagination: { total_count: 0 } })
const ONE_INCIDENT = { name: 'API Degradation', status: 'started', impact: 'minor', started_at: '2026-09-25T10:30:00Z', resolved_at: null, url: 'https://status.mistral.ai/incidents/abc', incident_updates: [] }
const STATUS_ACTIVE = JSON.stringify({ status: { indicator: 'minor' }, incidents: [ONE_INCIDENT] })
const INCIDENTS_ACTIVE = JSON.stringify({ incidents: [ONE_INCIDENT], pagination: { total_count: 1 } })

const json = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' }, ...init })

/** A fetch that answers by endpoint; anything else fails loudly. */
const route = (answers: Record<string, () => Response | Promise<Response>>): PublicApiFetch => async (url) => {
  const key = url.replace(`${MISTRAL_PUBLIC_API_BASE}/`, '')
  const answer = answers[key]
  if (!answer) throw new Error(`unexpected fetch ${url}`)
  return answer()
}

const result = (over: Partial<PublicApiResult> = {}): PublicApiResult =>
  ({ outcome: 'ok', httpStatus: 200, incidentCount: 0, indicator: 'none', raw: '{}', ...over })

describe('readPublicApi — what the Worker egress was answered with', () => {
  it('reads a quiet 200 JSON page: ok, zero incidents, the documented indicator', async () => {
    const r = await readPublicApi('status.json', route({ 'status.json': () => json(STATUS_QUIET) }))
    expect(r).toMatchObject({ outcome: 'ok', httpStatus: 200, incidentCount: 0, indicator: 'none' })
    expect(r.raw).toBe(STATUS_QUIET)
  })

  it('counts a listed incident on each endpoint', async () => {
    expect((await readPublicApi('incidents.json', route({ 'incidents.json': () => json(INCIDENTS_ACTIVE) }))).incidentCount).toBe(1)
    expect((await readPublicApi('status.json', route({ 'status.json': () => json(STATUS_ACTIVE) }))).incidentCount).toBe(1)
  })

  it('a cf-mitigated header is a challenge even when the status is 403', async () => {
    const r = await readPublicApi('status.json', route({ 'status.json': () => new Response('Just a moment…', { status: 403, headers: { 'cf-mitigated': 'challenge' } }) }))
    expect(r).toMatchObject({ outcome: 'challenged', httpStatus: 403, raw: null })
  })

  it('a non-200 without that header is non-200, not a challenge', async () => {
    const r = await readPublicApi('incidents.json', route({ 'incidents.json': () => new Response('', { status: 401 }) }))
    expect(r).toMatchObject({ outcome: 'non-200', httpStatus: 401 })
  })

  it('a 200 that is not JSON is not-json, and a thrown fetch is error', async () => {
    expect(await readPublicApi('status.json', route({ 'status.json': () => new Response('<html>', { status: 200 }) })))
      .toMatchObject({ outcome: 'not-json', httpStatus: 200, raw: null })
    expect(await readPublicApi('status.json', async () => { throw new Error('timeout') }))
      .toMatchObject({ outcome: 'error', httpStatus: 0 })
  })

  it('reports no count when the JSON carries no incidents array, and drops an indicator outside the documented four', async () => {
    const r = await readPublicApi('status.json', route({ 'status.json': () => json('{"status":{"indicator":"wobbly"}}') }))
    expect(r).toMatchObject({ outcome: 'ok', incidentCount: null, indicator: null })
  })

  it('bounds the raw text it keeps', async () => {
    const big = JSON.stringify({ incidents: [], pad: 'x'.repeat(200_000) })
    const r = await readPublicApi('status.json', route({ 'status.json': () => json(big) }))
    expect(r.raw!.length).toBe(64 * 1024)
  })
})

describe('recordPublicApiSample — keep a real active-incident payload, write only on change', () => {
  const quiet = [result(), result()] as const
  const active = [result({ incidentCount: 1, indicator: 'minor', raw: STATUS_ACTIVE }), result({ incidentCount: 1, raw: INCIDENTS_ACTIVE })] as const

  it('touches KV not at all while nothing is listed (control)', async () => {
    const kv = mockKV()
    expect(await recordPublicApiSample(kv as never, ...quiet, 'now')).toBe('skipped')
    expect(kv.get).not.toHaveBeenCalled()
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('stores both raw responses once an incident is listed, with the retention TTL', async () => {
    const kv = mockKV()
    expect(await recordPublicApiSample(kv as never, ...active, '2026-09-25T10:35:00.000Z')).toBe('written')
    expect(kv.put).toHaveBeenCalledTimes(1)
    const [key, value, opts] = kv.put.mock.calls[0] as unknown as [string, string, unknown]
    expect(key).toBe(MISTRAL_PUBLIC_SAMPLE_KV_KEY)
    expect(JSON.parse(value)).toEqual({ capturedAt: '2026-09-25T10:35:00.000Z', statusJson: STATUS_ACTIVE, incidentsJson: INCIDENTS_ACTIVE })
    expect(opts).toEqual({ expirationTtl: 2_592_000 })
  })

  it('does not rewrite an identical payload on the next cycle, but does when either response changes', async () => {
    const kv = mockKV()
    await recordPublicApiSample(kv as never, ...active, 't1')
    expect(await recordPublicApiSample(kv as never, ...active, 't2')).toBe('unchanged')
    expect(kv.put).toHaveBeenCalledTimes(1)
    const changed = [active[0], result({ incidentCount: 1, raw: INCIDENTS_ACTIVE.replace('started', 'investigating') })] as const
    expect(await recordPublicApiSample(kv as never, ...changed, 't3')).toBe('written')
    expect(kv.put).toHaveBeenCalledTimes(2)
    const statusOnly = [result({ incidentCount: 1, indicator: 'major', raw: STATUS_ACTIVE.replace('minor', 'major') }), changed[1]] as const
    expect(await recordPublicApiSample(kv as never, ...statusOnly, 't4')).toBe('written')
    expect(kv.put).toHaveBeenCalledTimes(3)
  })

  it('keeps the last active sample when the incident clears', async () => {
    const kv = mockKV()
    await recordPublicApiSample(kv as never, ...active, 't1')
    await recordPublicApiSample(kv as never, ...quiet, 't2')
    expect(JSON.parse(kv.store[MISTRAL_PUBLIC_SAMPLE_KV_KEY]).capturedAt).toBe('t1')
  })

  it('an incident on status.json alone is enough, and a corrupt prior value is replaced', async () => {
    expect(listsAnIncident(active[0], quiet[1])).toBe(true)
    expect(listsAnIncident(quiet[0], active[1])).toBe(true)
    const kv = mockKV({ [MISTRAL_PUBLIC_SAMPLE_KV_KEY]: 'not json' })
    expect(await recordPublicApiSample(kv as never, active[0], quiet[1], 't')).toBe('written')
  })
})

describe('recordPublicApiObservation — one bounded WAE row per cycle', () => {
  it('carries the outcome per endpoint, the indicator, and the counts', () => {
    const writeDataPoint = vi.fn()
    recordPublicApiObservation({ writeDataPoint } as never, result({ incidentCount: 2, indicator: 'major' }), result({ outcome: 'challenged', httpStatus: 403, incidentCount: null }))
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: [MISTRAL_PUBLIC_API_SOURCE, 'ok', 'challenged', 'major'],
      doubles: [1, 200, 403, 2, -1],
      indexes: [MISTRAL_PUBLIC_API_INDEX],
    })
  })

  it('marks an unreadable status.json as unknown / -1, never as an all-clear', () => {
    const writeDataPoint = vi.fn()
    recordPublicApiObservation({ writeDataPoint } as never,
      result({ outcome: 'challenged', httpStatus: 403, incidentCount: null, indicator: null }), result())
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: [MISTRAL_PUBLIC_API_SOURCE, 'challenged', 'ok', 'unknown'],
      doubles: [1, 403, 200, -1, 0],
      indexes: [MISTRAL_PUBLIC_API_INDEX],
    })
  })

  it('never throws: no binding, or a failing write', () => {
    expect(() => recordPublicApiObservation(undefined, result(), result())).not.toThrow()
    const failing = { writeDataPoint: () => { throw new Error('wae down') } }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => recordPublicApiObservation(failing as never, result(), result())).not.toThrow()
  })
})

describe('runMistralPublicApiProbe', () => {
  it('records the row and the sample in one cycle', async () => {
    const kv = mockKV()
    const writeDataPoint = vi.fn()
    await runMistralPublicApiProbe({ STATUS_CACHE: kv as never, ANALYTICS: { writeDataPoint } as never }, 'now',
      route({ 'status.json': () => json(STATUS_ACTIVE), 'incidents.json': () => json(INCIDENTS_ACTIVE) }))
    expect(writeDataPoint).toHaveBeenCalledTimes(1)
    expect(kv.put).toHaveBeenCalledTimes(1)
  })

  it('binds each endpoint to its own columns of the row', async () => {
    const writeDataPoint = vi.fn()
    await runMistralPublicApiProbe({ ANALYTICS: { writeDataPoint } as never }, 'now', route({
      'status.json': () => json(STATUS_ACTIVE),
      'incidents.json': () => new Response('', { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
    }))
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: [MISTRAL_PUBLIC_API_SOURCE, 'ok', 'challenged', 'minor'],
      doubles: [1, 200, 403, 1, -1],
      indexes: [MISTRAL_PUBLIC_API_INDEX],
    })
  })

  it('swallows a KV failure so the cron cycle is unaffected', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kv = mockKV()
    kv.put.mockRejectedValue(new Error('kv down'))
    await expect(runMistralPublicApiProbe({ STATUS_CACHE: kv as never }, 'now',
      route({ 'status.json': () => json(STATUS_ACTIVE), 'incidents.json': () => json(INCIDENTS_ACTIVE) }))).resolves.toBeUndefined()
  })
})

describe('wiring — the real scheduled handler runs the probe each cycle', () => {
  const event = { scheduledTime: Date.parse('2026-08-12T12:07:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent
  const OPERATIONAL: ServiceStatus[] = SERVICES.map(s => ({ id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus))

  it('reads both public endpoints and writes one observation row, without touching any status', async () => {
    const seen: string[] = []
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith(MISTRAL_PUBLIC_API_BASE)) {
        seen.push(url.replace(`${MISTRAL_PUBLIC_API_BASE}/`, ''))
        return json(url.endsWith('status.json') ? STATUS_QUIET : INCIDENTS_QUIET)
      }
      throw new Error('network disabled in test')
    }))
    vi.mocked(fetchAllServices).mockResolvedValue({ raw: OPERATIONAL, enriched: OPERATIONAL, pageComponents: {}, upstreamFeeds: [] })
    const pending: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException: () => {} } as unknown as ExecutionContext
    const writeDataPoint = vi.fn()
    const kv = mockKV()
    await workerModule.scheduled(event, { STATUS_CACHE: kv, ANALYTICS: { writeDataPoint } } as never, ctx)
    await Promise.allSettled(pending)
    expect(seen.sort()).toEqual(['incidents.json', 'status.json'])
    expect(writeDataPoint.mock.calls.filter(([p]) => p.indexes[0] === MISTRAL_PUBLIC_API_INDEX)).toHaveLength(1)
    expect(kv.store[MISTRAL_PUBLIC_SAMPLE_KV_KEY]).toBeUndefined()
  }, TEST_TIMEOUT_MS)
})
