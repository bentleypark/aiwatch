import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchService, SERVICES } from '../services'

// #1089 — the WIRING half. `instatus.test.ts` pins that the parser distinguishes an unreadable payload
// from a genuinely empty one; that says nothing about whether `fetchService` acts on the distinction.
// The bug lived in the acting, not the parsing: the badge is `hasOngoing ? 'degraded' : httpStatus`, so
// a failed parse collapsing to `[]` published a green badge — a false RECOVERY — while the incident was
// still open upstream. A pure-parser test would stay green through that entire failure.
//
// Drives the real `fetchService` entry point (the `auto-monitor-tag.test.ts` harness pattern) so the
// call chain parse → flag → derive is exercised, not a hand-assembled imitation of it.

const mistral = SERVICES.find((s) => s.id === 'mistral')!

/** A structurally VALID Nuxt payload carrying one ONGOING incident. */
function healthyNuxtHtml() {
  const arr: unknown[] = [
    'Audio API Degraded', 'INVESTIGATING', '2026-07-17T07:55:56.406Z', 0, 'MEDIUM', '4288f6a2', [], [],
    { id: 5, name: 0, lastUpdateStatus: 1, created_at: 2, duration: 3, severity: 4, services: 6, incidentUpdates: 7 },
    [8],
    { incidents: 9 },
    { 'incidents-by-date-2026': 10 },
  ]
  return `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`
}

/**
 * Both fetches return HTTP 200 — that is the crux. The page is *reachable*, so `httpStatus` is
 * `operational`; only the incident payload is unreadable. A guard keyed on the HTTP status would miss
 * this entirely, which is exactly how the bug survived: #761 fixed a *throwing* scrape URL, and this
 * case never throws.
 */
function stubFetch(scrapeBody: string) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(scrapeBody, { status: 200 })))
}

afterEach(() => vi.unstubAllGlobals())

describe('#1089 — an unreadable Instatus payload must not publish a recovery', () => {
  it('does NOT return operational when the incident payload is unreadable', async () => {
    // The regression test proper. Pre-fix this returned `status: 'operational'` with no marker, and the
    // plugin monitor turned that into "✅ Mistral API has recovered".
    stubFetch('<html><body>we redesigned the status page</body></html>')
    const svc = await fetchService(mistral, undefined, undefined, {})
    expect(svc.sourceUnknown, 'an unreadable source must be flagged, not silently trusted').toBe(true)
  })

  it('flags sourceUnknown even though the page returned HTTP 200', async () => {
    // Guards against "just check res.ok" — the page is fine, our read of it is not.
    stubFetch('<script id="__NUXT_DATA__" type="application/json">{oops</script>')
    const svc = await fetchService(mistral, undefined, undefined, {})
    expect(svc.sourceUnknown).toBe(true)
  })

  it('leaves sourceUnknown unset on a healthy payload, and still reports the ongoing incident', async () => {
    // The false-positive direction. If this ever flips, every Mistral poll would claim an unreadable
    // source and the badge would be permanently caveated — worse than the bug being fixed.
    stubFetch(healthyNuxtHtml())
    const svc = await fetchService(mistral, undefined, undefined, {})
    expect(svc.sourceUnknown).toBeUndefined()
    expect(svc.incidents.some((i) => i.status !== 'resolved'), 'the ongoing incident should survive').toBe(true)
  })

  it('a genuinely empty page is NOT flagged — quiet is not the same as unreadable', async () => {
    // The distinction the whole change rests on, asserted at the wiring level rather than the parser.
    const arr: unknown[] = ['x', 'y', 'z', 0, 'MEDIUM', 'id', [], [], {}, [], { incidents: 9 }, { 'incidents-by-date-2026': 10 }]
    stubFetch(`<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`)
    const svc = await fetchService(mistral, undefined, undefined, {})
    expect(svc.sourceUnknown).toBeUndefined()
  })
})

describe('#1089 review — the scrape FETCH failures, not just the parse', () => {
  // Review round 1 (Critical): the first cut only covered "scrape returned 200, payload unreadable".
  // A 404 or a thrown fetch skipped the parse block entirely, left `incidents` empty with no marker,
  // and fell through to `httpStatus` exactly as before. The 404 case IS #761's URL-drift scenario —
  // the likeliest real trigger — so the fix would have missed the most probable cause in production.

  it('a 404 scrape does not read as "no incidents"', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).includes('/activity/') ? new Response('nope', { status: 404 }) : new Response('<html></html>', { status: 200 })))
    const svc = await fetchService(mistral, undefined, undefined, {})
    expect(svc.sourceUnknown, 'a 404 scrape must flag the source, not publish operational').toBe(true)
  })

  it('a throwing scrape does not read as "no incidents"', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/activity/')) throw new Error('ECONNRESET')
      return new Response('<html></html>', { status: 200 })
    }))
    const svc = await fetchService(mistral, undefined, undefined, {})
    expect(svc.sourceUnknown).toBe(true)
  })

  it('carries the measured latency through the guard', async () => {
    // Review round 1 (Important 3): the early return dropped `latency` — all three Instatus services
    // are category:'api', so this was real data loss on every parse failure.
    stubFetch('<html><body>redesigned</body></html>')
    const svc = await fetchService(mistral, undefined, undefined, {})
    expect(svc.sourceUnknown).toBe(true)
    expect(svc.latency, 'latency is measured independently of the scrape').not.toBeNull()
  })

  it('carries the uptime provenance with the uptime figure', async () => {
    // Review round 1 (Important 4): `uptime30d` shipped with no `uptimeSource`, which ServiceDetails,
    // the Uptime page and monthly-archive all read as "unavailable".
    //
    // The main-page fetch is INDEPENDENT of the scrape, so it must carry a real uptime payload here or
    // the assertion is vacuous — an earlier version of this test guarded on `if (uptime != null)` with
    // a fixture that had none, so it asserted nothing at all while reading as coverage.
    const NOW = Date.now(), DAY = 86_400_000
    const arr: unknown[] = ['API', 99.599, 'ignored']
    const dayIdx: number[] = []
    for (let i = 0; i < 90; i++) {
      arr.push([]); const evList = arr.length - 1
      arr.push({ date: new Date(NOW - i * DAY).toISOString(), events: evList })
      dayIdx.push(arr.length - 1)
    }
    arr.push(dayIdx); const daysList = arr.length - 1
    arr.push({ id: 0, name: 0, uptime: 1, days: daysList })
    const mainPage = `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`

    // Main page parses (uptime present); the scrape is unreadable.
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).includes('/activity/') ? new Response('broken', { status: 404 }) : new Response(mainPage, { status: 200 })))
    const svc = await fetchService(mistral, undefined, undefined, {})
    expect(svc.sourceUnknown).toBe(true)
    expect(svc.uptime30d, 'fixture must actually yield an uptime, else this test is vacuous').not.toBeNull()
    expect(svc.uptimeSource, 'uptime must travel with its provenance').toBe('official')
  })
})
