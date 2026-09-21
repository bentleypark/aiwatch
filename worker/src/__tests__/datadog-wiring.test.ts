import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchService, SERVICES, statusSourceOf } from '../services'
import { parseParseFailDay } from '../parse-failure-log'
import type { KVLike } from '../utils'

// #1403 — the parser being right proves nothing about whether production calls it. These assert the
// CALLED path: openrouter's config, the URL the branch derives, and what each failure mode publishes.
const FIXTURE_RAW = readFileSync(
  join(__dirname, '../parsers/__tests__/fixtures/openrouter-datadog-2026-09-15.json'),
  'utf8',
)
const FIXTURE = JSON.parse(FIXTURE_RAW)

const openrouter = SERVICES.find((service) => service.id === 'openrouter')!

function mockKV(store: Record<string, string>): KVLike {
  return {
    get: async (k: string) => store[k] ?? null,
    put: async (k: string, v: string) => { store[k] = v },
    delete: async (k: string) => { delete store[k] },
  } as unknown as KVLike
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** Capture the URLs the branch asks for, so "it fetched something" cannot pass for "it fetched the
 *  right document". */
function stubFetch(response: () => Response) {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    return response()
  }))
  return urls
}

describe('#1403 openrouter is wired to the Datadog path, not the retired one', () => {
  it('carries datadogStatusUrl and no OnlineOrNot config', () => {
    expect(openrouter.datadogStatusUrl).toBe('https://status.openrouter.ai')
    // The retired fields are gone from the type, so this is a runtime assertion that no config
    // object still carries them as excess properties.
    expect(Object.keys(openrouter).some((key) => key.toLowerCase().includes('onlineornot'))).toBe(false)
    expect(statusSourceOf(openrouter)).toBe('Datadog Status Page')
  })

  it('resolves the SHIPPED scope to the API components, excluding the website leaf', () => {
    // Round 3 caught this: appending the `Web & Application Services` id to the config restored the
    // exact behaviour this scope exists to remove, and 5503 tests stayed green — the parser suite
    // exercises a hand-written copy of the scope, never the value that ships. This drives the REAL
    // config through the REAL captured page.
    const scoped = (FIXTURE.components as Array<{ id: string; type: string; components?: Array<{ name: string }> }>)
      .find((c) => c.id === openrouter.datadogComponentGroupId)
    expect(scoped?.type).toBe('ComponentGroup')
    expect(scoped?.components?.map((c) => c.name)).toEqual([
      'Chat (/api/v1/chat/completions)', 'Video (/api/v1/videos)', 'Image (/api/v1/image)',
      'TTS (/api/v1/audio/speech)', 'STT (/api/v1/audio/transcriptions)', 'Embeddings (/api/v1/embeddings)',
    ])
    // The website leaf sits OUTSIDE that group — which is what keeps it out of the badge and uptime.
    expect((FIXTURE.components as Array<{ id: string; name: string }>)
      .some((c) => c.name === 'Web & Application Services' && c.id !== openrouter.datadogComponentGroupId)).toBe(true)
  })

  it('is the ONLY service on this path — a second one would need the window caveat re-checked', () => {
    // Every caveat recorded for this path was established against ONE page. A second Datadog service
    // must not join silently and inherit them unchecked.
    expect(SERVICES.filter((service) => service.datadogStatusUrl).map((s) => s.id)).toEqual(['openrouter'])
  })
})

describe('#1403 Datadog Worker wiring — what each outcome publishes', () => {
  it('reads config.json and publishes incidents WITH an official computed uptime', async () => {
    const urls = stubFetch(() => new Response(FIXTURE_RAW, { status: 200 }))

    const service = await fetchService(openrouter, undefined, undefined, {})

    expect(urls).toEqual(['https://status.openrouter.ai/config.json'])
    expect(service.status).toBe('operational')
    expect(service.incidents).toHaveLength(4)
    expect(service.incidents[0].id).toMatch(/^datadog:/)
    // The migration must not demote openrouter to the no-official-uptime path: that would drop its
    // 40-point Uptime component and move it out of the high-confidence ranking table (#1186).
    expect(service.uptimeSource).toBe('official')
    expect(typeof service.uptime30d).toBe('number')
    expect(typeof service.todayWeightedOutageSec).toBe('number')
    // The fixture's incidents age out of the trailing window in production time, so this asserts the
    // SHAPE here and leaves the arithmetic to datadog.test.ts's frozen clock. The disclosure's own
    // wiring is pinned by the next test, on a document that disagrees at any `now`.
    expect(service.uptime30d).toBeLessThanOrEqual(100)
    // A successful read is not a stale or unreadable source.
    expect(service.sourceUnknown).toBeUndefined()
    expect(service.incidentSourceStale).toBeUndefined()
    expect(service.sourceDead).toBeUndefined()
  })

  it('publishes the parser\'s VERDICT, not a hardcoded operational', async () => {
    // Pre-existing gap, closed here because this path is new: the parser suite covers `worstVerdict`,
    // but nothing pinned the wiring from that verdict to `ServiceStatus.status`. Replacing it with a
    // literal `'operational'` passed all 5501 tests. A `major_outage` component with NO incidents is
    // the discriminating case — an incident-backed degradation is re-derived downstream, so only the
    // component-status path exposes the break.
    const group = openrouter.datadogComponentGroupId
    stubFetch(() => new Response(JSON.stringify({
      created: '2026-01-01T00:00:00Z',
      components: [{
        id: group, name: 'API - Gateway', type: 'ComponentGroup',
        components: [{ id: 'c0', name: 'Chat', position: 0, status: 'major_outage', type: 'Component' }],
      }],
      incidents: [],
      maintenances: null,
    }), { status: 200 }))

    const service = await fetchService(openrouter, undefined, undefined, {})
    expect(service.status).toBe('down')
    expect(service.incidents).toEqual([])
  })

  it('does not publish "operational, no incidents" when the document is unreadable', async () => {
    // A 200 carrying the app shell — the exact state that made this issue: the page answers fine and
    // says nothing we can read. It must never clear the incident list AND look healthy.
    stubFetch(() => new Response('<!DOCTYPE html><html><body></body></html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    }))
    const store: Record<string, string> = {}

    const service = await fetchService(openrouter, undefined, mockKV(store) as never, {})

    expect(service.sourceUnknown).toBe(true)
    expect(service.uptime30d).toBeNull()
    expect(service.uptimeSource).toBeUndefined()

    // And it BOOKS the reason. Without this the branch could be bypassed entirely and still look
    // right from the outside: the resulting TypeError lands in the function's outer catch, which
    // publishes the same `sourceUnknown` — so the observable verdict alone cannot tell a handled
    // refusal from an unhandled crash. The reason bucket is what distinguishes them, and it is the
    // only thing that tells an operator WHICH fix this needs.
    const key = Object.keys(store).find((k) => k.startsWith('instatus-parse-fail:'))
    expect(key, `expected a parse-failure counter key, got: ${Object.keys(store).join(', ')}`).toBeDefined()
    expect(Object.keys(parseParseFailDay(store[key!]).counts.openrouter)).toEqual(['dd-envelope-unreadable'])
  })

  it('threads a SHORT window through to ServiceStatus as the #1004 disclosure', async () => {
    // Deleting a clock-dependent assertion in an earlier round left this emission covered by nothing:
    // removing the `uptimeWindowDays` spread from `services.ts` passed the whole suite, which would
    // ship a short-window figure as if it covered 30 and silently drop openrouter out of
    // `isArchiveRestoreEligible`. Built RELATIVE to `Date.now()`, so it cannot rot the way the
    // deleted assertion did — the page is always five days old when this runs.
    const group = openrouter.datadogComponentGroupId
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
    const affected = [{ id: 'c0', name: 'Chat', status: 'degraded', type: 'Component' }]
    stubFetch(() => new Response(JSON.stringify({
      created: daysAgo(5),
      components: [{
        id: group, name: 'API - Gateway', type: 'ComponentGroup',
        components: [{ id: 'c0', name: 'Chat', position: 0, status: 'operational', type: 'Component' }],
      }],
      incidents: [{
        id: 'i', title: 'Degraded', currentStatus: 'resolved',
        publishedDate: daysAgo(4), resolvedDate: daysAgo(3), resolved: true,
        componentsAffected: [],
        timeline: [
          { id: 'a', status: 'investigating', description: null, startedAt: daysAgo(4), createdAt: 'x', componentsAffected: affected },
          { id: 'b', status: 'resolved', description: null, startedAt: daysAgo(3), createdAt: 'x', componentsAffected: [{ id: 'c0', name: 'Chat', status: 'operational', type: 'Component' }] },
        ],
      }],
      maintenances: null,
    }), { status: 200 }))

    const service = await fetchService(openrouter, undefined, undefined, {})
    expect(service.uptimeWindowDays).toBe(5)
    expect(service.uptimeSource).toBe('official')
  })

  it('says its per-day impact record is INCOMPLETE, so the calendar keeps painting incidents', async () => {
    // #1004/#1292 — this path publishes no per-day impact of its own. Once openrouter emits
    // `uptimeWindowDays` it becomes `isArchiveRestoreEligible`, and the restore writes a `dailyImpact`
    // map onto the snapshot; with `dailyImpactComplete` absent, `calendar.js`'s
    // `dailyImpactComplete ?? days === 30` reads TRUE on the Overview 30-bar strip and skips the
    // incident-painting phase entirely — openrouter's own incidents stop appearing there.
    stubFetch(() => new Response(FIXTURE_RAW, { status: 200 }))
    const service = await fetchService(openrouter, undefined, undefined, {})
    expect(service.dailyImpactComplete).toBe(false)
  })

  it('books a transient non-OK as unknown, and an unambiguous gone status as a dead source', async () => {
    stubFetch(() => new Response('', { status: 503 }))
    const store: Record<string, string> = {}
    const trackingStore = {}
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const transient = await fetchService(openrouter, undefined, mockKV(store) as never, trackingStore)
    expect(transient.sourceUnknown).toBe(true)
    expect(transient.sourceDead).toBeUndefined()
    // An HTTP failure books a reason too. The retired parser carried a caller-set one for exactly
    // this, and on THIS host it is the likeliest failure (a 403 bot challenge to our egress). Without
    // it the counter kv-schema.md sends an operator to reads zero while the source is walled.
    const key = Object.keys(store).find((k) => k.startsWith('instatus-parse-fail:'))
    expect(key, `expected a parse-failure counter key, got: ${Object.keys(store).join(', ')}`).toBeDefined()
    expect(Object.keys(parseParseFailDay(store[key!]).counts.openrouter)).toEqual(['dd-fetch-unreadable'])
    expect(trackingStore).toEqual({ openrouter: { failCount: 1, failCountAt: expect.any(String), sourceReadFailure: { source: 'datadog-config', phase: 'http', httpStatus: 503 } } })
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'status_source_read_failure', serviceId: 'openrouter', source: 'datadog-config', phase: 'http', httpStatus: 503, latencyMs: expect.any(Number) }))

    stubFetch(() => new Response('', { status: 404 }))
    const gone = await fetchService(openrouter, undefined, undefined, {})
    expect(gone.sourceDead).toBe(true)
    expect(gone.incidentSourceStale).toBe(true)
  })

  it('records a config body read as transport, not HTTP', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const trackingStore = {}
    stubFetch(() => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('connection lost')) } }), { status: 200 }))

    await fetchService(openrouter, undefined, undefined, trackingStore)

    expect(trackingStore).toEqual({ openrouter: { failCount: 1, failCountAt: expect.any(String), sourceReadFailure: { source: 'datadog-config', phase: 'transport', httpStatus: 200, errorKind: 'network' } } })
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'status_source_read_failure', serviceId: 'openrouter', source: 'datadog-config', phase: 'transport', httpStatus: 200, errorKind: 'network', latencyMs: expect.any(Number) }))
  })
})
