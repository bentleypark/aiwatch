import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  readPublicApi,
  listsAnIncident,
  recordPublicApiSample,
  recordPublicApiObservation,
  runMistralPublicApiProbe,
  mapPublicIncidentImpact,
  parsePublicActiveIncidents,
  recordActiveIncidentsOverlay,
  isStorableOverlayIncident,
  MISTRAL_PUBLIC_API_BASE,
  MISTRAL_PUBLIC_API_INDEX,
  MISTRAL_PUBLIC_API_SOURCE,
  MISTRAL_PUBLIC_SAMPLE_KV_KEY,
  MISTRAL_ACTIVE_OVERLAY_KV_KEY,
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

// Captured 2026-09-29 via `npx wrangler kv key get --remote --namespace-id
// e49508d80bb144e9a7ff872f2be771a4 mistral:public-sample`, used verbatim.
const REAL_ACTIVE_INCIDENT = {
  id: 'fcc64184-7c9a-45d8-9fb4-e2c862f7e195',
  name: 'Elevated error rate on some of our services',
  status: 'monitoring',
  created_at: '2026-09-29T05:48:01-07:00',
  updated_at: '2026-09-29T06:56:16-07:00',
  monitoring_at: null,
  resolved_at: null,
  impact: 'critical',
  shortlink: 'https://rootly.com/account/incidents/1730-lot-of-dashboard-errors',
  started_at: '2026-09-29T05:48:01-07:00',
  page_id: 'ae27f3c4-86a4-4290-a053-87252545d7f9',
  incident_updates: [
    { id: 'cf530c0d-060e-4c4e-9dcf-0efa2037b5a0', status: 'monitoring', body: 'Metrics are back to normal. We are still monitoring the services actively.', created_at: '2026-09-29T06:56:16-07:00', updated_at: '2026-09-29T06:56:16-07:00', display_at: '2026-09-29T06:56:16-07:00' },
    { id: '5d0b3f4c-b230-4cf0-ab80-8fc190ae7c32', status: 'identified', body: 'Root cause has been identified. Services are coming back up.', created_at: '2026-09-29T06:21:47-07:00', updated_at: '2026-09-29T06:21:47-07:00', display_at: '2026-09-29T06:21:47-07:00' },
    { id: '8521262c-b905-41eb-87ac-20c70082f66d', status: 'investigating', body: 'We identified an elevated error rate on some of our surfaces (Vibe, Studio, Settings page).\nInvestigations are ongoing', created_at: '2026-09-29T05:54:01-07:00', updated_at: '2026-09-29T05:54:01-07:00', display_at: '2026-09-29T05:54:01-07:00' },
  ],
}

describe('mapPublicIncidentImpact — Rootly public API vocabulary', () => {
  it('passes through the three severities', () => {
    expect(mapPublicIncidentImpact('critical')).toBe('critical')
    expect(mapPublicIncidentImpact('major')).toBe('major')
    expect(mapPublicIncidentImpact('minor')).toBe('minor')
  })

  it('maps none and an unrecognised value both to null, warning only on the latter', () => {
    expect(mapPublicIncidentImpact('none')).toBeNull()
    expect(mapPublicIncidentImpact(undefined)).toBeNull()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(mapPublicIncidentImpact('wobbly')).toBeNull()
    expect(console.warn).toHaveBeenCalledOnce()
  })

  it('is case- and whitespace-insensitive', () => {
    expect(mapPublicIncidentImpact(' Critical ')).toBe('critical')
  })
})

describe('parsePublicActiveIncidents — real captured payload (2026-09-29)', () => {
  it('parses the real sample into our Incident shape', () => {
    const { incidents, dropped } = parsePublicActiveIncidents(JSON.stringify({ incidents: [REAL_ACTIVE_INCIDENT] }))
    expect(dropped).toBe(0)
    expect(incidents).toHaveLength(1)
    const [inc] = incidents
    expect(inc.id).toBe(REAL_ACTIVE_INCIDENT.id)
    expect(inc.title).toBe(REAL_ACTIVE_INCIDENT.name)
    expect(inc.impact).toBe('critical')
    expect(inc.status).toBe('monitoring')
    expect(inc.resolvedAt).toBeNull()
    expect(inc.duration).toBeNull()
    expect(inc.startedAt).toBe(new Date(REAL_ACTIVE_INCIDENT.started_at).toISOString())
    // Newest-first in the raw feed; our timeline is ascending.
    expect(inc.timeline.map((t) => t.stage)).toEqual(['investigating', 'identified', 'monitoring'])
  })

  it('drops an entry missing an id or a parseable start, and counts it rather than crashing', () => {
    const { incidents, dropped } = parsePublicActiveIncidents(JSON.stringify({
      incidents: [
        { ...REAL_ACTIVE_INCIDENT, id: undefined },
        { ...REAL_ACTIVE_INCIDENT, started_at: 'not a date' },
      ],
    }))
    expect(incidents).toHaveLength(0)
    expect(dropped).toBe(2)
  })

  // #1510 round 8 review finding: Mistral has published untitled active incidents (#1471). Dropping
  // every empty-name entry silently hid a real, impactful, in-scope incident. `rootlyIncidentTitle`
  // (shared with the scrape path) derives a title from the first update's body instead.
  it('falls back to a timeline-derived title when the raw name is empty, rather than dropping', () => {
    const { incidents, dropped } = parsePublicActiveIncidents(JSON.stringify({
      incidents: [{ ...REAL_ACTIVE_INCIDENT, name: '' }],
    }))
    expect(dropped).toBe(0)
    expect(incidents).toHaveLength(1)
    expect(incidents[0].title).not.toBe('')
    expect(incidents[0].title.length).toBeGreaterThan(0)
  })

  it('drops an entry with an empty name AND no usable update text — nothing to fall back to', () => {
    const { incidents, dropped } = parsePublicActiveIncidents(JSON.stringify({
      incidents: [{ ...REAL_ACTIVE_INCIDENT, name: '', incident_updates: [] }],
    }))
    expect(incidents).toHaveLength(0)
    expect(dropped).toBe(1)
  })

  it('a resolved incident keeps resolvedAt and gets a real duration', () => {
    const resolved = { ...REAL_ACTIVE_INCIDENT, status: 'resolved', resolved_at: '2026-09-29T07:00:00-07:00' }
    const { incidents } = parsePublicActiveIncidents(JSON.stringify({ incidents: [resolved] }))
    expect(incidents[0].status).toBe('resolved')
    expect(incidents[0].resolvedAt).not.toBeNull()
    expect(incidents[0].duration).not.toBeNull()
  })

  it('null/unparseable text is a parse failure, distinct from valid JSON with no incidents field', () => {
    expect(parsePublicActiveIncidents(null)).toEqual({ incidents: [], dropped: 0, parseFailed: true })
    expect(parsePublicActiveIncidents('not json')).toEqual({ incidents: [], dropped: 0, parseFailed: true })
    expect(parsePublicActiveIncidents(JSON.stringify({}))).toEqual({ incidents: [], dropped: 0, parseFailed: false })
  })

  it('a body truncated by readPublicApi\'s RAW_MAX_CHARS (still "ok") is a parse failure, not an empty list', () => {
    // Mirrors what readPublicApi actually stores: `outcome: 'ok'` is decided off the FULL body, then
    // `raw` is cut to 64 KiB (`grep -n RAW_MAX_CHARS worker/src/mistral-public-api.ts`) — so an
    // over-sized real payload reaches here cut mid-structure, same as a genuinely large page would be.
    const many = Array.from({ length: 400 }, () => REAL_ACTIVE_INCIDENT)
    const oversized = JSON.stringify({ incidents: many })
    expect(oversized.length).toBeGreaterThan(64 * 1024)
    const truncated = oversized.slice(0, 64 * 1024)
    const { incidents, parseFailed } = parsePublicActiveIncidents(truncated)
    expect(parseFailed).toBe(true)
    expect(incidents).toHaveLength(0)
  })
})

describe('isStorableOverlayIncident — re-validates a value read back out of KV', () => {
  const valid = () => parsePublicActiveIncidents(JSON.stringify({ incidents: [REAL_ACTIVE_INCIDENT] })).incidents[0]

  it('accepts a well-formed Incident (our own writer\'s shape)', () => {
    expect(isStorableOverlayIncident(valid())).toBe(true)
  })

  it('rejects an element missing a required field, or carrying the wrong type for one', () => {
    expect(isStorableOverlayIncident({ ...valid(), id: undefined })).toBe(false)
    expect(isStorableOverlayIncident({ ...valid(), title: '' })).toBe(false)
    expect(isStorableOverlayIncident({ ...valid(), status: 'started' })).toBe(false)
    expect(isStorableOverlayIncident({ ...valid(), impact: 'wobbly' })).toBe(false)
    expect(isStorableOverlayIncident({ ...valid(), startedAt: 'not a date' })).toBe(false)
    expect(isStorableOverlayIncident({ ...valid(), timeline: 'not an array' })).toBe(false)
  })

  it('rejects null, a non-object, and an empty object', () => {
    expect(isStorableOverlayIncident(null)).toBe(false)
    expect(isStorableOverlayIncident('a string')).toBe(false)
    expect(isStorableOverlayIncident({})).toBe(false)
  })
})

describe('recordActiveIncidentsOverlay', () => {
  it('writes the parsed active list on a successful read, even when empty', async () => {
    const kv = mockKV()
    await recordActiveIncidentsOverlay(kv as never, result({ outcome: 'ok', raw: JSON.stringify({ incidents: [] }) }))
    expect(kv.store[MISTRAL_ACTIVE_OVERLAY_KV_KEY]).toBe('[]')
  })

  it('writes the real incident through to the overlay key', async () => {
    const kv = mockKV()
    await recordActiveIncidentsOverlay(kv as never, result({ outcome: 'ok', raw: JSON.stringify({ incidents: [REAL_ACTIVE_INCIDENT] }) }))
    expect(JSON.parse(kv.store[MISTRAL_ACTIVE_OVERLAY_KV_KEY])).toHaveLength(1)
  })

  it('does NOT overwrite on a failed/unreadable read — a transient fetch failure must not erase a real reading', async () => {
    const kv = mockKV({ [MISTRAL_ACTIVE_OVERLAY_KV_KEY]: '[{"id":"prior"}]' })
    await recordActiveIncidentsOverlay(kv as never, result({ outcome: 'challenged', raw: null }))
    expect(kv.store[MISTRAL_ACTIVE_OVERLAY_KV_KEY]).toBe('[{"id":"prior"}]')
  })

  it('an "ok" outcome whose raw body is truncated/unparseable does NOT overwrite with an empty list either', async () => {
    // Pins the `parseFailed` check (`grep -n parseFailed worker/src/mistral-public-api.ts`): gating
    // the write on `outcome` alone erased a real prior reading with `[]` on a truncated-but-'ok' body.
    const kv = mockKV({ [MISTRAL_ACTIVE_OVERLAY_KV_KEY]: '[{"id":"prior"}]' })
    await recordActiveIncidentsOverlay(kv as never, result({ outcome: 'ok', raw: '{"incidents":[{"id":"a"' }))
    expect(kv.store[MISTRAL_ACTIVE_OVERLAY_KV_KEY]).toBe('[{"id":"prior"}]')
  })

  it('no-op with no KV binding', async () => {
    await expect(recordActiveIncidentsOverlay(undefined, result())).resolves.toBeUndefined()
  })

  it('warns when an entry is dropped, so the loss leaves a trace', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kv = mockKV()
    await recordActiveIncidentsOverlay(kv as never, result({
      outcome: 'ok',
      raw: JSON.stringify({ incidents: [{ ...REAL_ACTIVE_INCIDENT, id: undefined }] }),
    }))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped 1'))
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
  it('records the row, the sample, and the active-incident overlay in one cycle', async () => {
    const kv = mockKV()
    const writeDataPoint = vi.fn()
    await runMistralPublicApiProbe({ STATUS_CACHE: kv as never, ANALYTICS: { writeDataPoint } as never }, 'now',
      route({ 'status.json': () => json(STATUS_ACTIVE), 'incidents.json': () => json(INCIDENTS_ACTIVE) }))
    expect(writeDataPoint).toHaveBeenCalledTimes(1)
    // The sample (unchanged-content dedup) and the overlay (fresh every cycle) are two separate writes.
    expect(kv.put).toHaveBeenCalledTimes(2)
    expect(kv.store[MISTRAL_ACTIVE_OVERLAY_KV_KEY]).toBeDefined()
  })

  // #1510 Slice 2's required pin, WRITER side (reader side: `grep -n "no page-wide indicator"
  // worker/src/__tests__/mistral-active-overlay.test.ts`) — drives the real
  // `runMistralPublicApiProbe` cron entry point, not just the pure parser.
  it('writes only the per-incident impact to the overlay — a severe status.json indicator never leaks into it', async () => {
    const kv = mockKV()
    const noneImpact = { ...REAL_ACTIVE_INCIDENT, impact: 'none' }
    await runMistralPublicApiProbe({ STATUS_CACHE: kv as never }, 'now', route({
      'status.json': () => json(JSON.stringify({ status: { indicator: 'major' }, incidents: [noneImpact] })),
      'incidents.json': () => json(JSON.stringify({ incidents: [noneImpact] })),
    }))
    const written = JSON.parse(kv.store[MISTRAL_ACTIVE_OVERLAY_KV_KEY])
    expect(written).toHaveLength(1)
    expect(written[0].impact).toBeNull()
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
