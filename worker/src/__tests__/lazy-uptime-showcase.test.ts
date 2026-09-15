// #1389 — Atlassian moved the uptime payload off the status document (`LAZY_UPTIME_SHOWCASE`,
// 2026-09-10) and every Atlassian-sourced service silently lost `uptime30d`.
//
// What these pin, in order of how much they would have cost us:
//  1. The two transports compute the same thing over the same 90-day payload — including the parts that
//     only exist BEYOND the trailing 30 days (`uptimeReported`), which a 30-day fixture cannot see.
//  2. `hasLazyUptimeShowcase` separates a page that MOVED its data from one that never had any, and the
//     gate that uses it keeps the request off every other page. That distinction is why the original
//     failure was silent: on an incident.io page, finding no inline blob is correct and expected.
//  3. The wiring — `fetchAllServices` really does fetch the showcase and really does publish uptime
//     from it. The pure halves stay green if the production call is deleted
//     (`debugging_fix_the_called_path_not_the_tested_twin`), so the last cases drive the real entry
//     point in both directions: showcase reachable → uptime; showcase unreadable → null.
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parseUptimeData,
  computeUptimeData,
  extractInlineUptimeData,
  hasLazyUptimeShowcase,
  parseUptimeShowcase,
} from '../parsers/statuspage'
import { fetchUptimeShowcase, showcaseUrl } from '../uptime-showcase'
import { fetchAllServices, uptimeScopeForPage, uptimeScopeOf, SERVICES } from '../services'
import { TEST_TIMEOUT_MS, mockKV } from './helpers/unreadable-source'
import {
  CLAUDE_API, CLAUDE_AI, CLAUDE_CODE, PAGE, CLAUDE_SUMMARY_URL,
  FIXTURE_UPTIME_30D, FIXTURE_UPTIME_90D, FIXTURE_DAYS,
  ninetyDays, legacyPage, lazyPage, stubLazyClaudePage, showcaseResponse,
} from './helpers/lazy-status-page'

const DAYS = ninetyDays('2026-09-10')
const TIMELINES = { [CLAUDE_API]: { component: { code: CLAUDE_API, name: 'API' }, days: DAYS } }
const AT = Date.parse('2026-09-10T12:00:00Z')

describe('the showcase transport computes what the inline blob computed (#1389)', () => {
  it('produces an IDENTICAL result to the legacy inline page, across the whole 90-day payload', () => {
    const fromInline = parseUptimeData(legacyPage(TIMELINES), CLAUDE_API, 30, AT)
    const fromShowcase = computeUptimeData(
      parseUptimeShowcase({ components: {}, timelines: TIMELINES, values: [{ component: CLAUDE_API, ninety: 99.5, thirty: 99.9 }] }),
      CLAUDE_API, 30, AT,
    )
    // Every field, not just the percentage: the calendar, the window length, the provider-figure
    // disclosure and the #1017 archive input all ride the same computation.
    expect(fromShowcase).toEqual(fromInline)
  })

  it('separates the trailing-30 figure from the provider\'s ~90-day one', () => {
    // The half a 30-day fixture cannot reach. `uptimeReported`/`uptimeReportedDays` exist only when the
    // payload is LONGER than the window (`scored.length > trailing.length`), and they are what #1006
    // puts beside our number so a reader can check us against the provider. Under the old fixture,
    // widening the window from 30 to 90 was green.
    const r = computeUptimeData(parseUptimeShowcase({ timelines: TIMELINES }), CLAUDE_API, 30, AT)
    expect(r.uptimePercent).toBe(FIXTURE_UPTIME_30D)
    expect(r.windowDays).toBe(30)
    expect(r.uptimeReported).toBe(FIXTURE_UPTIME_90D)
    expect(r.uptimeReportedDays).toBe(FIXTURE_DAYS)
  })

  it('ignores the response\'s own `values[]` aggregate (#1006 — we compute, we do not copy)', () => {
    // The provider ships a ready-made `thirty` figure. Taking it would be one line less code and a
    // differently-defined number in a field the Reliability Ranking compares across services.
    const r = computeUptimeData(
      parseUptimeShowcase({ timelines: TIMELINES, values: [{ component: CLAUDE_API, thirty: 42.0 }] }),
      CLAUDE_API, 30, AT,
    )
    expect(r.uptimePercent).toBe(FIXTURE_UPTIME_30D)
  })
})

describe('extractInlineUptimeData / hasLazyUptimeShowcase tell the two page shapes apart', () => {
  it('the legacy page yields the blob and is NOT flagged lazy', () => {
    const html = legacyPage(TIMELINES)
    expect(extractInlineUptimeData(html)).toEqual(TIMELINES)
    expect(hasLazyUptimeShowcase(html)).toBe(false)
  })

  it('the lazy page yields NO blob and IS flagged lazy', () => {
    const html = lazyPage([CLAUDE_API, CLAUDE_AI, CLAUDE_CODE])
    // The regression proper: the loader's `window.uptimeData = window.uptimeData || {}` seed must not
    // be mistaken for the data. Parsing the seed would produce an empty-but-present object, which reads
    // downstream as "the component is not tracked" — a wrong answer that looks like a right one.
    expect(extractInlineUptimeData(html)).toBeNull()
    expect(hasLazyUptimeShowcase(html)).toBe(true)
  })

  it('a page with neither is flagged lazy in NEITHER direction (the incident.io case)', () => {
    // parseUptimeData runs against incident.io HTML too, where finding nothing is correct and must stay
    // silent. If this flipped, every incident.io page would take an extra subrequest per cycle and the
    // warn built on this predicate would fire on services that are working fine.
    const html = '<!doctype html><html><body>incident.io status page</body></html>'
    expect(extractInlineUptimeData(html)).toBeNull()
    expect(hasLazyUptimeShowcase(html)).toBe(false)
  })

  it('the loader\'s own source literals are not counted as placeholders', () => {
    // `data-uptime-lazy="<code>"` and `data-uptime-lazy="' + code + '"` appear in the inlined ES5
    // loader on every page that shipped this. A looser match would report a page as lazy purely because
    // it carries the script.
    const scriptOnly = [
      '<script>',
      '  var placeholder = document.querySelector(\'[data-uptime-lazy="<code>"]\');',
      '  var el = document.querySelector(\'[data-uptime-lazy="\' + code + \'"]\');',
      '</script>',
    ].join('\n')
    expect(hasLazyUptimeShowcase(scriptOnly)).toBe(false)
  })
})

describe('uptimeScopeOf / uptimeScopeForPage — one definition, two readers', () => {
  it('is the badge worst-of when there is one, else the single primary', () => {
    const cursor = SERVICES.find((s) => s.id === 'cursor')!
    const claude = SERVICES.find((s) => s.id === 'claude')!
    expect(uptimeScopeOf(cursor)).toEqual(cursor.statusComponentIds)
    expect(uptimeScopeOf(claude)).toEqual([claude.statusComponentId])
  })

  it('is EMPTY for a service with no statusComponentId — the gate the uptime branch applies', () => {
    // turbopuffer is configured by `incidentIoComponentId` alone, so a code fetched for it could not be
    // used by anything.
    expect(uptimeScopeOf(SERVICES.find((s) => s.id === 'turbopuffer')!)).toEqual([])
  })

  it('the page request is exactly the union of its services\' scopes — no display-only ids', () => {
    // Derived from the configs rather than hardcoded, so a legitimate badge-scope edit moves both sides
    // together instead of failing on a count that says nothing about the property under test.
    for (const apiUrl of [CLAUDE_SUMMARY_URL, 'https://status.cursor.com/api/v2/summary.json']) {
      const expected = new Set(SERVICES.filter((s) => s.apiUrl === apiUrl).flatMap(uptimeScopeOf))
      expect(new Set(uptimeScopeForPage(apiUrl))).toEqual(expected)
    }
    // …and the discriminating negative: Cursor's DISPLAY roster is seven, its badge scope five. Asking
    // for the display ids would fetch timelines nothing reads.
    expect(uptimeScopeForPage('https://status.cursor.com/api/v2/summary.json')).not.toContain('xwjpvdf81qh9')
    // Three services genuinely share the Anthropic document — the union property, not a count.
    expect(uptimeScopeForPage(CLAUDE_SUMMARY_URL).sort()).toEqual([CLAUDE_API, CLAUDE_AI, CLAUDE_CODE].sort())
  })

  it('returns [] for an unknown page rather than every service\'s ids', () => {
    expect(uptimeScopeForPage('https://example.invalid/api/v2/summary.json')).toEqual([])
  })
})

describe('fetchUptimeShowcase fails OPEN — it can return data or nothing, never a wrong number', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('builds the batch URL the page\'s own loader builds', () => {
    expect(showcaseUrl(PAGE, [CLAUDE_API, CLAUDE_AI]))
      .toBe(`${PAGE}/uptime_showcase?components=${CLAUDE_API}%2C${CLAUDE_AI}`)
    // A trailing slash on statusUrl must not produce a double slash the server 404s.
    expect(showcaseUrl(`${PAGE}/`, [CLAUDE_API])).toBe(`${PAGE}/uptime_showcase?components=${CLAUDE_API}`)
  })

  it('returns the timelines on a good response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ timelines: TIMELINES }), { status: 200 })))
    expect(await fetchUptimeShowcase(PAGE, [CLAUDE_API])).toEqual(TIMELINES)
  })

  it.each([
    ['a 404 (page has not rolled out the showcase)', async () => new Response('Not Found', { status: 404 })],
    ['a 200 that is not JSON', async () => new Response('<!doctype html>', { status: 200 })],
    ['a 200 JSON body with no `timelines` key', async () => new Response(JSON.stringify({ components: {}, values: [] }), { status: 200 })],
    ['a `timelines` that is an ARRAY, not a map', async () => new Response(JSON.stringify({ timelines: [] }), { status: 200 })],
    ['a thrown fetch', async () => { throw new Error('TLS: cert does not match host') }],
  ])('returns null on %s', async (_label, impl) => {
    vi.stubGlobal('fetch', vi.fn(impl))
    expect(await fetchUptimeShowcase(PAGE, [CLAUDE_API])).toBeNull()
  })

  it('returns an EMPTY map as itself — a page that publishes nothing for our component', async () => {
    // Verified live: an untracked component answers 200 `{"components":{},"timelines":{},"values":[]}`,
    // not a 404. It must read as "asked, answered, nothing tracked" and NOT as a transport failure —
    // the call site depends on that distinction to fall through to the inline blob.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ components: {}, timelines: {}, values: [] }), { status: 200 })))
    expect(await fetchUptimeShowcase(PAGE, [CLAUDE_API])).toEqual({})
  })

  it('does not fire a request when there is nothing to ask for', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await fetchUptimeShowcase(PAGE, [])).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ── The wired half ──
//
// Three `fetchAllServices` drives, not seven. Each one fans out across 45 services, and under vitest's
// unbounded file parallelism enough of them push `cache-reseed-wiring.test.ts` — which drives the real
// cron handler on the DEFAULT 5s per-test budget, and whose own header records this exact symptom —
// past its timeout, turning `npm run test:worker` red at an unrelated location. So each case here
// carries every assertion that shares its premise rather than taking its own run: the showcase fetch
// lives in the per-page prefetch, which only `fetchAllServices` exercises, so the premise is the
// expensive part and the assertions are free.

describe('fetchAllServices publishes uptime from the showcase (the wiring)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
  const today = () => new Date().toISOString().split('T')[0]

  /** Runs one cycle against the post-rollout Anthropic page, capturing showcase URLs and the warn. */
  async function run(showcase: (url: string) => Response) {
    const seen: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubLazyClaudePage((url) => { seen.push(url); return showcase(url) })
    const { raw } = await fetchAllServices(mockKV() as unknown as KVNamespace, [])
    return {
      claude: raw.find((s) => s.id === 'claude'),
      seen,
      lazyWarns: warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('lazy uptime placeholders')),
    }
  }

  it('recovers uptime, asks ONCE per lazy page, asks no other page, and says nothing', async () => {
    const { claude, seen, lazyWarns } = await run(() => showcaseResponse(today()))

    expect(claude?.uptime30d).toBe(FIXTURE_UPTIME_30D)
    expect(claude?.uptimeSource).toBe('official')
    // The provider's own figure survives the new transport too — the disclosure #1006 exists for, and
    // the field a 30-day fixture silently drops.
    expect(claude?.uptimeReported).toBe(FIXTURE_UPTIME_90D)
    expect(claude?.uptimeReportedDays).toBe(FIXTURE_DAYS)
    // NOT filtered to the Anthropic page: the gate's whole job is to keep this request off the ~20
    // incident.io pages that would answer 404, and a filtered assertion records those calls and then
    // discards them. Subrequest count is a hard Workers limit, not a style preference.
    expect(seen.filter((u) => !u.startsWith(PAGE)), 'no showcase request may go to a non-lazy page').toEqual([])
    expect(seen, 'three services share this document — one request, not three').toHaveLength(1)
    for (const code of [CLAUDE_API, CLAUDE_AI, CLAUDE_CODE]) {
      expect(decodeURIComponent(seen[0])).toContain(code)
    }
    expect(lazyWarns, 'a healthy cycle is silent').toEqual([])
  }, TEST_TIMEOUT_MS)

  it('leaves uptime NULL — never invented — when the showcase cannot be read, and says so', async () => {
    // The other direction, and what makes the case above load-bearing: delete the production showcase
    // call and that one goes red, but a fallback that GUESSED a number would keep it green.
    // #713 — absence of records is not evidence of absence of downtime.
    const { claude, lazyWarns } = await run(() => new Response('Not Found', { status: 404 }))

    expect(claude?.uptime30d).toBeNull()
    expect(claude?.status, 'and a missing uptime is not an outage verdict').toBe('operational')
    // The log-level companion. Without an assertion here, deleting the warn — or rescoping it to "uptime
    // came out null", which would fire forever on a page publishing nothing for our component — is green.
    expect(lazyWarns.length, 'one per service on the page').toBeGreaterThan(0)
    expect(lazyWarns.join('\n')).toContain('claude')
  }, TEST_TIMEOUT_MS)

  it('falls back to the inline blob when the showcase answers an EMPTY map, silently', async () => {
    // The silent-override case. `{}` is truthy, so taking mere presence as the signal would let an
    // empty response shadow a blob that has data — uptime null, and neither warn able to fire. That is
    // the #1389 failure shape reintroduced, which is why the call site tests for non-empty.
    //
    // It is also the false-positive direction for the warn: a page can advertise placeholders for
    // components it serves while publishing nothing for the one we track, and that is a source behaving
    // correctly, not a transport failure.
    const days = ninetyDays(today())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      if (url.includes('/uptime_showcase')) return new Response(JSON.stringify({ timelines: {} }), { status: 200 })
      if (url === PAGE || url === `${PAGE}/`) {
        // A page carrying BOTH shapes — the transition window of the next rollout.
        return new Response(
          lazyPage([CLAUDE_API]) + legacyPage({ [CLAUDE_API]: { days } }),
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        )
      }
      if (url.startsWith(CLAUDE_SUMMARY_URL)) {
        return new Response(JSON.stringify({
          status: { indicator: 'none', description: 'All Systems Operational' },
          components: [{ id: CLAUDE_API, name: 'Claude API', status: 'operational' }],
          incidents: [], scheduled_maintenances: [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: { indicator: 'none' }, components: [], incidents: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    const { raw } = await fetchAllServices(mockKV() as unknown as KVNamespace, [])

    expect(raw.find((s) => s.id === 'claude')?.uptime30d).toBe(FIXTURE_UPTIME_30D)
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('lazy uptime placeholders'))).toEqual([])
  }, TEST_TIMEOUT_MS)
})
