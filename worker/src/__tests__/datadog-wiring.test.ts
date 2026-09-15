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
    // openrouter's full window rests on one un-corroborated `Backfill` record (see the parser's
    // header). A second Datadog page would not inherit that, so it must not join silently.
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

  it('says its per-day impact record is INCOMPLETE, so the calendar keeps painting incidents', async () => {
    // #1004/#1292 — this path publishes no per-day impact of its own. Once openrouter emits
    // `uptimeWindowDays` it becomes `isArchiveRestoreEligible`, and the restore writes a `dailyImpact`
    // map onto the snapshot; with `dailyImpactComplete` absent, `calendar.js`'s
    // `dailyImpactComplete ?? days === 30` reads TRUE on the Overview 30-bar strip and skips the
    // incident-painting phase entirely — openrouter's own incidents stop appearing there.
    stubFetch(() => new Response(FIXTURE_RAW, { status: 200 }))
    const service = await fetchService(openrouter, undefined, undefined, {})
    expect(service.dailyImpactComplete).toBe(false)
    // The trigger: this service now carries a short window, which is what makes the restore eligible.
    expect(service.uptimeWindowDays).toBeTypeOf('number')
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
