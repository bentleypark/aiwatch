import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchService, SERVICES, statusSourceOf } from '../services'
import { parseParseFailDay } from '../parse-failure-log'
import type { KVLike } from '../utils'

// #1403 — the parser being right proves nothing about whether production calls it. These assert the
// CALLED path: openrouter's config, the URL the branch derives, and what each failure mode publishes.
const FIXTURE = readFileSync(
  join(__dirname, '../parsers/__tests__/fixtures/openrouter-datadog-2026-09-15.json'),
  'utf8',
)

const openrouter = SERVICES.find((service) => service.id === 'openrouter')!

function mockKV(store: Record<string, string>): KVLike {
  return {
    get: async (k: string) => store[k] ?? null,
    put: async (k: string, v: string) => { store[k] = v },
    delete: async (k: string) => { delete store[k] },
  } as unknown as KVLike
}

afterEach(() => vi.unstubAllGlobals())

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

  it('is the ONLY service on this path — a second one would need the window caveat re-checked', () => {
    // The 30-day denominator is safe here because status.openrouter.ai backfilled its history past
    // the window (checked against AIWatch's own August record). A second Datadog page would not
    // inherit that fact, so it must not join silently.
    expect(SERVICES.filter((service) => service.datadogStatusUrl).map((s) => s.id)).toEqual(['openrouter'])
  })
})

describe('#1403 Datadog Worker wiring — what each outcome publishes', () => {
  it('reads config.json and publishes incidents WITH an official computed uptime', async () => {
    const urls = stubFetch(() => new Response(FIXTURE, { status: 200 }))

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

  it('carries the provider disclosure through to ServiceStatus', async () => {
    // #1006 — /methodology promises the reader can check us against the provider, and on THIS source
    // the two figures differ by the severity RULE, not only the window. An OPEN `degraded` incident
    // disagrees at every clock: it accrues for us at 0.3 forever and scores zero under the provider's
    // rule, so this pins the wiring without depending on when the suite runs.
    const CHAT = '9fb5ccff-e128-455a-be20-59572f8d363a'
    const affected = [{ id: CHAT, name: 'Chat', status: 'degraded', type: 'Component' }]
    stubFetch(() => new Response(JSON.stringify({
      created: '2026-01-01T00:00:00Z',
      components: [{ id: CHAT, name: 'Chat', position: 0, status: 'degraded', type: 'Component' }],
      incidents: [{
        id: 'open', title: 'Degraded', currentStatus: 'identified',
        publishedDate: '2026-09-01T00:00:00Z', resolvedDate: null, resolved: false,
        componentsAffected: affected,
        timeline: [{ id: 'a', status: 'identified', description: null, startedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z', componentsAffected: affected }],
      }],
      maintenances: null,
    }), { status: 200 }))

    const service = await fetchService(openrouter, undefined, undefined, {})
    expect(service.uptimeReported).toBe(100)
    expect(service.uptimeReportedDays).toBe(90)
    expect(service.uptime30d).toBeLessThan(100)
    expect(service.status).toBe('degraded')
  })

  it('books a transient non-OK as unknown, and an unambiguous gone status as a dead source', async () => {
    stubFetch(() => new Response('', { status: 503 }))
    const store: Record<string, string> = {}
    const transient = await fetchService(openrouter, undefined, mockKV(store) as never, {})
    expect(transient.sourceUnknown).toBe(true)
    expect(transient.sourceDead).toBeUndefined()
    // An HTTP failure books a reason too. The retired parser carried a caller-set one for exactly
    // this, and on THIS host it is the likeliest failure (a 403 bot challenge to our egress). Without
    // it the counter kv-schema.md sends an operator to reads zero while the source is walled.
    const key = Object.keys(store).find((k) => k.startsWith('instatus-parse-fail:'))
    expect(key, `expected a parse-failure counter key, got: ${Object.keys(store).join(', ')}`).toBeDefined()
    expect(Object.keys(parseParseFailDay(store[key!]).counts.openrouter)).toEqual(['dd-fetch-unreadable'])

    stubFetch(() => new Response('', { status: 404 }))
    const gone = await fetchService(openrouter, undefined, undefined, {})
    expect(gone.sourceDead).toBe(true)
    expect(gone.incidentSourceStale).toBe(true)
  })
})
