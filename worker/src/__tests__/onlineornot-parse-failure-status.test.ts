import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fetchService, SERVICES } from '../services'
import { parseFailKey, parseParseFailDay } from '../parse-failure-log'

// #1123 — the WIRING half, mirroring `instatus-parse-failure-status.test.ts` (#1089). The parser
// tests pin that `parseOnlineOrNotPage` tells a clean page apart from an unreadable one; they say
// nothing about whether `fetchService` acts on either. Both halves of this fix live in the acting:
//
//   1. a genuinely clean page must publish uptime 100 + 'official' provenance — the production
//      symptom was `uptime30d: null`, rendered as "No official uptime — incident-tracked", which is
//      indistinguishable from a service we deliberately have no uptime for (#713);
//   2. an unreadable page must NOT publish "operational, no incidents". The OnlineOrNot path reads
//      no status field of its own — incidents are the only signal it consumes — so an empty list
//      pins the card green no matter what is happening upstream.

const openrouter = SERVICES.find((s) => s.id === 'openrouter')!
const fixture = (name: string) =>
  readFileSync(resolve(__dirname, '../parsers/__tests__/fixtures', name), 'utf8')

/** Every fetch returns HTTP 200 — the page is reachable; only our read of it is in question. */
function stubFetch(body: string, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })))
}

/** Minimal KV double — without one, `recordParseFailure` returns at its first line and the
 *  diagnostic half of this fix goes entirely unexercised. */
function mockKV(store: Record<string, string> = {}) {
  return {
    kv: {
      get: async (k: string) => store[k] ?? null,
      put: async (k: string, v: string) => { store[k] = v },
      delete: async (k: string) => { delete store[k] },
    } as unknown as KVNamespace,
    store,
  }
}

/** The reasons booked for a service today, across every day key the run may have written. */
function recordedReasons(store: Record<string, string>, svcId: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(store)) {
    if (!k.startsWith(parseFailKey(''))) continue
    for (const [reason, n] of Object.entries(parseParseFailDay(v).counts[svcId] ?? {})) {
      out[reason] = (out[reason] ?? 0) + n
    }
  }
  return out
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('#1123 — a clean OnlineOrNot page publishes real uptime', () => {
  it('reports 100% with official provenance on the captured incident-free page', async () => {
    // The regression proper. Pre-fix this returned `uptime30d: null` and no `uptimeSource`, which
    // dropped the Score's entire 40-point Uptime component and knocked confidence to `medium`.
    stubFetch(fixture('openrouter-onlineornot-clean-2026-07-22.html'))
    const svc = await fetchService(openrouter, undefined, undefined, {})
    expect(svc.sourceUnknown).toBeUndefined()
    expect(svc.uptime30d, 'a clean window is 100%, not "no official uptime"').toBe(100)
    expect(svc.uptimeSource, 'uptime must travel with its provenance').toBe('official')
    expect(svc.incidents).toEqual([])
    expect(svc.status).toBe('operational')
  })

  it('still surfaces incidents when the page has them, deduplicated across both containers', async () => {
    // The false-positive direction for the dedup half: the same outage appears in the root
    // `incidents` map AND the per-component daily buckets, and used to be published twice — two
    // Discord alerts and a doubled incident count for one event.
    stubFetch(fixture('openrouter-onlineornot-incidents-2025-12-06.html'))
    const svc = await fetchService(openrouter, undefined, undefined, {})
    expect(svc.sourceUnknown).toBeUndefined()
    expect(svc.incidents.map((i) => i.id)).toEqual(['LB6mQvzYAkoz', 'wn6mpXyB9WoP'])
    expect(svc.incidents.every((i) => i.impact === 'major')).toBe(true)
  })

  it('#1134: history-page failures do not discard the readable home payload', async () => {
    const home = fixture('openrouter-onlineornot-clean-2026-07-22.html')
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/incidents?')) return new Response('history unavailable', { status: 503 })
      return new Response(home, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const svc = await fetchService(openrouter, undefined, undefined, {})
    expect(svc.sourceUnknown).toBeUndefined()
    expect(svc.uptime30d).toBe(100)
    expect(svc.incidents).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(3) // home + the two /incidents history pages
  })

  it('#1134: merges in-window /incidents history into the home payload (success path)', async () => {
    // The forward direction the other tests never reach: a supplemental row actually LANDS in
    // svc.incidents. Date is pinned to just after the newest real history row (2026-04-14) so the
    // 90-day cutoff services.ts applies via Date.now() keeps the fixture's rows in range.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-04-15T00:00:00.000Z'))
    const home = fixture('openrouter-onlineornot-clean-2026-07-22.html') // empty home → recovered rows are unambiguously supplemental
    const p1 = fixture('openrouter-onlineornot-history-p1-2026-07-23.html')
    const p2 = fixture('openrouter-onlineornot-history-p2-2026-07-23.html')
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u.includes('/incidents?') && u.includes('page=1')) return new Response(p1, { status: 200 })
      if (u.includes('/incidents?') && u.includes('page=2')) return new Response(p2, { status: 200 })
      return new Response(home, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const svc = await fetchService(openrouter, undefined, undefined, {})
    const ids = svc.incidents.map((i) => i.id)
    expect(ids).toContain('lrkj1G0wmMoe') // Clerk auth — recovered from /incidents, absent from home
    expect(ids).toContain('opJAdRNJ-dlR') // Bedrock upstream — recovered
    // Display-only: supplemental rows are null-impact and must not move the official uptime.
    expect(svc.incidents.every((i) => i.impact === null)).toBe(true)
    expect(svc.uptime30d).toBe(100)
    expect(svc.uptimeSource).toBe('official')
  })
})

describe('#1123 — an unreadable OnlineOrNot page must not publish "operational, no incidents"', () => {
  it('flags sourceUnknown when the SSR envelope is gone, even on HTTP 200', async () => {
    stubFetch('<html><body>we redesigned the status page</body></html>')
    const svc = await fetchService(openrouter, undefined, undefined, {})
    expect(svc.sourceUnknown, 'an unreadable source must be flagged, not silently trusted').toBe(true)
  })

  it('flags sourceUnknown when the payload parses but is not a status page', async () => {
    const arr = ['loaderData', 'somethingElse', {}]
    const escaped = JSON.stringify(arr).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    stubFetch(`<html><script>streamController.enqueue("${escaped}")</script></html>`)
    const svc = await fetchService(openrouter, undefined, undefined, {})
    expect(svc.sourceUnknown).toBe(true)
  })

  it('does not fabricate an uptime figure on an unreadable page', async () => {
    // The inverse of the fix above: "clean → 100" must not become "unreadable → 100".
    stubFetch('<html><body>redesigned</body></html>')
    const svc = await fetchService(openrouter, undefined, undefined, {})
    expect(svc.uptime30d ?? null).toBeNull()
    expect(svc.uptimeSource ?? null).toBeNull()
  })

  // The reason string is the ENTIRE content of the 30-day diagnostic — it is what tells a future
  // maintainer which shape moved. Asserting only `sourceUnknown` leaves it free to be dropped.
  it('books the specific failure reason into the parse-failure counter', async () => {
    const { kv, store } = mockKV()
    stubFetch('<html><body>redesigned</body></html>')
    await fetchService(openrouter, undefined, kv, {})
    expect(recordedReasons(store, 'openrouter')).toEqual({ 'no-payload': 1 })
  })

  it('books a distinct reason when the containers are intact but the incidents are unreadable', async () => {
    const { kv, store } = mockKV()
    // A status page whose bucket names an incident no incident object accounts for. Indices:
    //   1 statusPage · 2 incidents · 3 activeIncidents · 4 incidentIds  (the required marker + keys)
    const arr: unknown[] = ['loaderData', 'statusPage', 'incidents', 'activeIncidents', 'incidentIds']
    arr.push({})                             // 5 — the (empty) incidents map value
    arr.push([])                             // 6 — the (empty) activeIncidents array
    arr.push(['LB6mQvzYAkoz'])               // 7 — a daily bucket's incidentIds array
    arr.push({ _2: 5, _3: 6, _4: 7 })        // 8 — the container holding all three
    const escaped = JSON.stringify(arr).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    stubFetch(`<html><script>streamController.enqueue("${escaped}")</script></html>`)
    const svc = await fetchService(openrouter, undefined, kv, {})
    expect(svc.sourceUnknown).toBe(true)
    expect(recordedReasons(store, 'openrouter')).toEqual({ 'incidents-unreadable': 1 })
  })
})

// #1123 review — this whole branch was untouched by the first cut of the fix, exactly as the #1089
// sibling's first cut missed it. The page being unreachable is at least as likely as its payload
// changing shape, and it lands on the same "we know nothing" state.
describe('#1123 — the page FETCH failing, not just the parse', () => {
  it('a 403 is INDETERMINATE (sourceUnknown), not a dead source', async () => {
    // Before the fix a real outage behind a bot-management 403 showed a green badge (httpStatus maps
    // 403 → operational). But 403 on this Cloudflare-fronted HTML page is most likely a transient
    // challenge to OUR egress, so it must NOT be promoted to `sourceDead` (which would flap openrouter
    // in and out of the rankings at poll rate) — it is an unreadable read, booked for diagnosis.
    const { kv, store } = mockKV()
    stubFetch('<html>Just a moment…</html>', 403)
    const svc = await fetchService(openrouter, undefined, kv, {})
    expect(svc.sourceUnknown).toBe(true)
    expect(svc.sourceDead ?? false).toBe(false)
    expect(recordedReasons(store, 'openrouter')).toEqual({ 'fetch-unreadable': 1 })
  })

  it('a 404 IS a dead source (the page is gone, not blocked)', async () => {
    stubFetch('nope', 404)
    const svc = await fetchService(openrouter, undefined, undefined, {})
    expect(svc.sourceDead).toBe(true)
    expect(svc.incidentSourceStale).toBe(true)
    expect(svc.status).toBe('operational')
  })

  it('a 503 is an indeterminate read — sourceUnknown, booked as fetch-unreadable', async () => {
    const { kv, store } = mockKV()
    stubFetch('upstream down', 503)
    const svc = await fetchService(openrouter, undefined, kv, {})
    expect(svc.sourceUnknown).toBe(true)
    expect(recordedReasons(store, 'openrouter')).toEqual({ 'fetch-unreadable': 1 })
  })
})
