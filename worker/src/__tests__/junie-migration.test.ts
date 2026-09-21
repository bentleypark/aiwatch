import { describe, it, expect, vi, afterEach } from 'vitest'
import { SERVICES, filterIncidents, filterByComponentStatus, fetchService, resolveSvcStatus } from '../services'
import { attachIncidentIoComponentNames, computeIncidentIoUptime, parseIncidentIoIncidentComponentIds } from '../parsers/incident-io'
import { isProbeFailing, PROBE_TARGETS, PROBE_FAILING_FLOOR_MS } from '../probe'
import { STATUS_URL } from '../../../src/utils/statusPageUrls'
import type { Incident } from '../types'
import type { TrackingStateBlob } from '../utils'

// #1004 — JetBrains moved their AI status page from Atlassian Statuspage (status.jetbrains.ai) to
// incident.io (status.jetbrains.cloud). The old host now 301s to the new SITE ROOT — the redirect drops
// the path — so the configured apiUrl resolved to a 200 text/html page, `summaryRes.json()` threw,
// fetchService fell into its catch, and after 3 consecutive failures junie sat on the fetch-failure
// fallback: a FALSE `degraded` badge for a service JetBrains reported as fully operational.
//
// #1004 follow-on (~2026-07-15) — JetBrains then REMOVED the standalone "Junie" component the first
// migration had adopted. Junie's badge, uptime and breakdown now span "JetBrains Central Console" and
// "JetBrains AI" (#1462).
//
// The tests below are deliberately of two kinds, because they catch different things:
//   - the CONFIG assertions are a REVERT guard. They pin our own constants, so a future upstream
//     migration leaves them green — they cannot detect one. (Nothing can, today: the #992
//     new-component detector watches component rosters on a page that FETCHED successfully, and a
//     whole-page migration breaks the fetch itself. That gap is real and unclosed.)
//   - the BEHAVIOURAL assertions are the ones that would have failed. The incident.io feed drops
//     component tags, which silently guts the #683 incident scoping — a far worse bug than the one
//     being fixed, and invisible to any config pin.

// #1004 follow-on — JetBrains REMOVED the standalone "Junie" component (DEAD_JUNIE_ID) ~2026-07-15,
// a week after the first migration adopted it. Junie now scopes to the TWO components "JetBrains AI" and
// "JetBrains Central Console". Grazie + the upstream provider components stay OUT (#683 neutrality).
// Badge, uptime and breakdown read BOTH (#1462).
const AI_ID = '01KX3EN535A0SKSZK3S84949V1'         // "JetBrains AI"
const CONSOLE_ID = '01KST6ZB60NWW1MAB3ECRMJFS0'    // "JetBrains Central Console"
const GRAZIE_ID = '01KX3EN5354CVBD36GANTX2BC4'     // a sibling product; a Grazie-only incident must not touch Junie
const DEAD_JUNIE_ID = '01KX3EN5353NA7819G7ND9Q3KA' // the standalone "Junie" component JetBrains removed

const junie = SERVICES.find((s) => s.id === 'junie')!

describe('junie config (#1004 revert guard)', () => {
  it('points at the incident.io host, not the retired Atlassian one', () => {
    expect(junie.statusUrl).toBe('https://status.jetbrains.cloud')
    expect(junie.apiUrl).toBe('https://status.jetbrains.cloud/api/v2/summary.json')
    // The 301 off the old host carries no path, so any status.jetbrains.ai URL lands on HTML.
    expect(JSON.stringify(junie)).not.toContain('status.jetbrains.ai')
  })

  it('badge, uptime and breakdown span Central Console and JetBrains AI (#1462)', () => {
    expect(junie.statusComponentId).toBe(CONSOLE_ID)                       // primary: miss-check + calendarDays
    expect(junie.statusComponentIds).toEqual([CONSOLE_ID, AI_ID])          // worst-of badge + uptime scope
    expect(junie.displayComponentIds).toEqual([CONSOLE_ID, AI_ID])         // ≡ statusComponentIds
    expect(junie.incidentComponents).toEqual(['JetBrains AI', 'JetBrains Central Console'])
    // both the retired Atlassian hash AND the removed standalone-Junie ULID must be gone everywhere.
    expect(JSON.stringify(junie)).not.toContain('9vbyyqkkjxl4')
    expect(JSON.stringify(junie)).not.toContain(DEAD_JUNIE_ID)
  })

  it('pins incidentIoComponentId to Central Console — the uptime gate and the published-figure source', () => {
    // incident.io keeps uptime in the page HTML's __next_f (component_uptimes), never in summary.json.
    expect(junie.incidentIoComponentId).toBe(CONSOLE_ID)
    expect(junie.incidentIoBaseUrl).toBe('https://status.jetbrains.cloud/incidents')
  })
})

// Guards the class of half-done migration this issue actually was: someone updates `apiUrl` and forgets
// `statusUrl` or `incidentIoBaseUrl`, leaving one field pointing at a host that 301s. Scope is every
// service that declares an `apiUrl` — the machine endpoint is what the agreement is against.
describe('every service points its status URLs at ONE host', () => {
  const hostOf = (u: string) => new URL(u).host.replace(/^www\./, '')
  // A provider may legitimately serve its HUMAN page from a vanity domain while the machine endpoint
  // stays on the vendor host (deepseek: status.deepseek.com → deepseek.statuspage.io). Pinned so the
  // list stays a deliberate, short one — the invariant still holds for every other in-scope service.
  const VANITY_DOMAIN = new Set(['deepseek'])

  it.each(SERVICES.filter((s) => s.apiUrl).map((s) => [s.id, s] as const))(
    '%s — statusUrl / apiUrl / incidentIoBaseUrl agree',
    (id, svc) => {
      const apiHost = hostOf(svc.apiUrl!)
      if (!VANITY_DOMAIN.has(id)) expect(hostOf(svc.statusUrl)).toBe(apiHost)
      // incidentIoBaseUrl is scraped, not just linked — a stale host here silently kills incident text
      // enrichment, so it must always track apiUrl.
      if (svc.incidentIoBaseUrl) expect(hostOf(svc.incidentIoBaseUrl)).toBe(apiHost)
    },
  )
})

// #1004 — the SPA's "Status Page ↗" link hand-mirrors `statusUrl`. This migration had to update both by
// hand; nothing failed if it hadn't, and the link would have pointed at a 301'd host indefinitely.
describe('src/utils/statusPageUrls.js mirrors the worker config', () => {
  // Pre-existing divergences, pinned so a NEW one can't slip in silently. These are the human-facing
  // page for a provider whose MACHINE endpoint lives elsewhere; not verified as intentional — if one
  // turns out to be a typo, fix it and delete the entry here.
  const KNOWN_DIVERGENT = new Set(['cohere', 'groq', 'perplexity'])

  it('every service id resolves to the same status URL on both sides', () => {
    const drift = SERVICES
      .filter((s) => !KNOWN_DIVERGENT.has(s.id))
      .filter((s) => STATUS_URL[s.id as keyof typeof STATUS_URL] !== s.statusUrl)
      .map((s) => `${s.id}: ui=${STATUS_URL[s.id as keyof typeof STATUS_URL]} worker=${s.statusUrl}`)
    expect(drift).toEqual([])
  })

  it('has an entry for every service, and no stale ones', () => {
    expect(Object.keys(STATUS_URL).sort()).toEqual(SERVICES.map((s) => s.id).sort())
  })
})

// ── incident.io drops component tags — the silent blind spot this migration would have opened ──

/** A `component_impacts` entry in the page's real backslash-escaped form. */
const impact = (incidentId: string, componentId: string) =>
  `{\\"component_id\\":\\"${componentId}\\",\\"end_at\\":\\"2026-07-13T10:00:00Z\\",\\"id\\":\\"IMP${componentId.slice(-4)}\\",` +
  `\\"start_at\\":\\"2026-07-13T09:00:00Z\\",\\"status\\":\\"degraded_performance\\",\\"status_page_incident_id\\":\\"${incidentId}\\"}`

const uptimeEntry = (id: string, uptime: string, since = '2026-07-09T12:46:46Z') =>
  `{\\"component_id\\":\\"${id}\\",\\"data_available_since\\":\\"${since}\\",` +
  `\\"status_page_component_group_id\\":\\"$undefined\\",\\"uptime\\":\\"${uptime}\\"}`

/** The page HTML shape: one RSC push carrying component_impacts followed by component_uptimes. */
const pageHtml = (impacts: string[], uptimes: string[] = [uptimeEntry(AI_ID, '100.00')]) =>
  `<script>self.__next_f.push([1,"a:{\\"component_impacts\\":[${impacts.join(',')}],` +
  `\\"component_uptimes\\":[${uptimes.join(',')}],\\"incident_links\\":[]}"])</script>`

const COMPONENTS = [
  { id: AI_ID, name: 'JetBrains AI' },
  { id: CONSOLE_ID, name: 'JetBrains Central Console' },
  { id: GRAZIE_ID, name: 'Grazie' },
]

/** An incident exactly as `parseIncidents` yields it off the incident.io v2 API: NO componentNames. */
const apiIncident = (id: string, title: string): Incident => ({
  id, title, status: 'investigating', startedAt: '2026-07-13T09:00:00Z', duration: null, timeline: [],
} as unknown as Incident)

describe('attachIncidentIoComponentNames (#1004)', () => {
  it('rebuilds componentNames the incident.io JSON API omits', () => {
    // Verified live: status.jetbrains.cloud 0/14, status.smith.langchain.com 0/25, status.langfuse.com
    // 0/25 and status.openai.com 0/25 incidents carry a non-empty `components` array.
    const html = pageHtml([impact('INC1', AI_ID), impact('INC2', GRAZIE_ID)])
    const out = attachIncidentIoComponentNames(
      [apiIncident('INC1', 'JetBrains AI is slow'), apiIncident('INC2', 'NLP errors')], html, COMPONENTS,
    )
    expect(out[0].componentNames).toEqual(['JetBrains AI'])
    expect(out[1].componentNames).toEqual(['Grazie'])
  })

  it('leaves an incident untagged when the page has no impact for it (no invention)', () => {
    const out = attachIncidentIoComponentNames([apiIncident('INC9', 'Unmapped')], pageHtml([impact('INC1', AI_ID)]), COMPONENTS)
    expect(out[0].componentNames).toBeUndefined()
  })

  it('never emits a raw ULID as a component name (an unknown id is skipped)', () => {
    const out = attachIncidentIoComponentNames([apiIncident('INC1', 'x')], pageHtml([impact('INC1', '01UNKNOWNID')]), COMPONENTS)
    expect(out[0].componentNames).toBeUndefined()
  })

  it('does not overwrite names the API DID provide', () => {
    const tagged = { ...apiIncident('INC1', 'x'), componentNames: ['FromAPI'] } as Incident
    const out = attachIncidentIoComponentNames([tagged], pageHtml([impact('INC1', AI_ID)]), COMPONENTS)
    expect(out[0].componentNames).toEqual(['FromAPI'])
  })

  it('returns the incidents untouched when the page carries no impacts at all', () => {
    const incidents = [apiIncident('INC1', 'x')]
    expect(attachIncidentIoComponentNames(incidents, '<html>nothing</html>', COMPONENTS)).toBe(incidents)
  })

  it('collects every component an incident impacted', () => {
    const html = pageHtml([impact('INC1', AI_ID), impact('INC1', GRAZIE_ID), impact('INC1', AI_ID)])
    expect(parseIncidentIoIncidentComponentIds(html)['INC1']).toEqual([AI_ID, GRAZIE_ID])
  })
})

// The integration test that actually encodes the bug: push the REAL feed shape through the REAL
// `filterIncidents` with the REAL junie config. Without the enrichment above, `incidentComponents:
// ['Junie']` matches nothing (every incident is untagged) and junie loses EVERY incident — forever,
// silently, and with no `includeUntaggedIncidents` valve to save it (that valve is gated on
// `incidentKeywords`, which junie does not set). #940's lesson: a transform must be proven through the
// real filter, not asserted in isolation.
describe('junie incidents survive filterIncidents on the incident.io feed (#1004 + #683)', () => {
  // INC1 = JetBrains AI, INC3 = Central Console (both in Junie's scope); INC2 = Grazie (scoped out).
  const html = pageHtml([impact('INC1', AI_ID), impact('INC2', GRAZIE_ID), impact('INC3', CONSOLE_ID)])
  const fromApi = [
    apiIncident('INC1', 'JetBrains AI requests failing'),
    apiIncident('INC2', 'Raised error rates from NLP services'),
    apiIncident('INC3', 'Central Console incident'),
  ]

  it('WITHOUT the tag rebuild, every incident is dropped (the bug)', () => {
    expect(filterIncidents(fromApi, junie)).toEqual([])
  })

  it('WITH the tag rebuild, JetBrains AI + Central Console survive and the Grazie one is scoped out', () => {
    const tagged = attachIncidentIoComponentNames(fromApi, html, COMPONENTS)
    const filtered = filterIncidents(tagged, junie)
    expect(filtered.map((i) => i.id).sort()).toEqual(['INC1', 'INC3'])
  })
})

// #1462 — with the badge on Central Console alone, an outage tagged only on JetBrains AI left the badge
// `operational` and dropped the ACTIVE incident (`filterByComponentStatus` removes an unresolved incident
// while the badge reads operational), so it only surfaced once resolved.
describe('junie reads BOTH components for badge, incidents and uptime (#1462)', () => {
  const summary = (aiStatus: string, consoleStatus = 'operational') => ({
    status: { indicator: 'none' },
    components: [
      { id: CONSOLE_ID, name: 'JetBrains Central Console', status: consoleStatus },
      { id: AI_ID, name: 'JetBrains AI', status: aiStatus },
    ],
  })

  it('a JetBrains-AI-only outage moves the badge off operational', () => {
    expect(resolveSvcStatus(junie, summary('partial_outage'), [])).not.toBe('operational')
    expect(resolveSvcStatus(junie, summary('operational', 'partial_outage'), [])).not.toBe('operational')
    expect(resolveSvcStatus(junie, summary('operational'), [])).toBe('operational')
  })

  it('an ACTIVE JetBrains-AI-tagged incident survives the component-status filter', () => {
    const active = { ...apiIncident('INC1', 'AI Platform API failing'), componentNames: ['JetBrains AI'], impact: 'major' } as Incident
    const status = resolveSvcStatus(junie, summary('partial_outage'), [active])
    expect(filterByComponentStatus([active], status, junie, COMPONENTS)).toHaveLength(1)
  })

  it('uptime is a worst-of over both: an outage on JetBrains AI lowers it, over the full 30d window', () => {
    const now = Date.parse('2026-07-15T00:00:00Z')
    const html = pageHtml([impact('INC1', AI_ID)], [
      uptimeEntry(CONSOLE_ID, '100.00', '2026-05-29T00:00:00Z'),
      uptimeEntry(AI_ID, '100.00', '2025-02-12T00:00:00Z'),
    ])
    const out = computeIncidentIoUptime(html, junie.statusComponentIds!, now)
    expect(out).toMatchObject({ days: 30, missing: [] })
    expect(out!.pct).toBeLessThan(100)
  })
})

// ── The producer of the flag the whole display fix rests on ──

// Without this, `sourceUnknown: true` could be deleted from the fetch-failure catch and every other
// test in this file would still pass — while Junie went back to rendering a false amber `degraded`.
// This is the assertion that encodes the bug's MECHANISM: a 200 text/html body (what the migrated host
// 301s to) is an indeterminate SOURCE read, not a verdict about the service.
describe('a 200 text/html status page is an unknown SOURCE, not a degraded service (#1004)', () => {
  const html = '<!doctype html><html><body>incident.io status page</body></html>'

  /** KV double whose fetch-fail counter actually increments, so the 3-strike threshold is exercised. */
  function countingKv() {
    const store = new Map<string, string>()
    return {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v) },
      delete: async (k: string) => { store.delete(k) },
    } as unknown as KVNamespace
  }

  afterEach(() => vi.restoreAllMocks())

  it('stays operational under the 3-strike threshold, then degrades — flagged sourceUnknown throughout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })))
    const kv = countingKv()
    // #1224 — the fetch-fail streak lives in this shared in-memory blob now, not individual KV keys,
    // so it must be threaded through every call the same way `fetchAllServices` threads it in production.
    const trackingStore: TrackingStateBlob = {}

    const first = await fetchService(junie, undefined, kv, trackingStore)
    expect(first.status).toBe('operational')      // one bad read is not an outage
    expect(first.sourceUnknown).toBe(true)        // …but it is not a clean read either

    const second = await fetchService(junie, undefined, kv, trackingStore)
    expect(second.status).toBe('operational')

    const third = await fetchService(junie, undefined, kv, trackingStore)
    expect(third.status).toBe('unknown')         // the fallback that looked like a real outage
    expect(third.sourceUnknown).toBe(true)        // …and the flag that lets the UI say otherwise
    expect(third.uptime30d).toBeNull()            // nothing was read, so nothing is claimed
  })
})

// ── The producer of `probeContradicted` (the guard that keeps a REAL outage amber) ──

// These cover the PURE predicate only. Deleting `svc.probeContradicted = true` from the
// cross-validation leaves every case below green — proven by mutation in review — so the wired half
// lives in `probe-contradicted-wiring.test.ts`, which drives `fetchAllServices`. Both are needed:
// this file pins what the predicate decides, that one pins that the decision is still read.
describe('isProbeFailing — only ACTUAL failure contradicts an unreadable source (#1004)', () => {
  const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString()
  const snap = (minsAgo: number, rtt: number) => ({ t: at(minsAgo), data: { cohere: { status: rtt > 0 ? 200 : 0, rtt } } })

  it('a failing probe (rtt <= 0 — what failedProbe() writes) contradicts', () => {
    expect(isProbeFailing([snap(2, -1), snap(7, -1)], 'cohere')).toBe(true)
  })

  it('a >3x median spike majority contradicts', () => {
    // The median is computed over ALL snapshots (not just recent ones), so a realistic set needs a
    // healthy baseline: 6 old samples at 500ms → median 500 → threshold 1500 → the two recent 4000ms
    // samples are spikes. (Feeding only spiked samples would drag the median up with them — which is
    // why the rtt<=0 case above, not the spike case, is what a real outage usually looks like.)
    const baseline = [20, 25, 30, 35, 40, 45].map((m) => snap(m, 500))
    // Keeps this case on the multiplicative bar: raise the floor past 1500 and the assertion below
    // would be satisfied by the floor instead, while the test's name still claimed the spike rule.
    expect(PROBE_FAILING_FLOOR_MS).toBeLessThan(500 * 3)
    expect(isProbeFailing([snap(2, 4000), snap(7, 4000), ...baseline], 'cohere')).toBe(true)
  })

  it('a HEALTHY probe does not — the bug a `!isProbeHealthy` negation would have had', () => {
    // isProbeHealthy needs >=2 samples, so ONE healthy sample returns false. Deriving "contradicted"
    // from that negation would have kept the false amber badge on a perfectly healthy service.
    expect(isProbeFailing([snap(2, 120)], 'cohere')).toBe(false)
    expect(isProbeFailing([snap(2, 120), snap(7, 130)], 'cohere')).toBe(false)
  })

  it('an unprobed service is never contradicted (junie has no probe target)', () => {
    expect(PROBE_TARGETS.some((t) => t.id === 'junie')).toBe(false)
    expect(isProbeFailing([snap(2, -1), snap(7, -1)], 'junie')).toBe(false)
  })

  it('too few samples to judge → not contradicted (honest default: stay neutral)', () => {
    expect(isProbeFailing([snap(2, -1)], 'cohere')).toBe(false)
    expect(isProbeFailing([], 'cohere')).toBe(false)
  })

  it('stale samples outside the recency window do not contradict', () => {
    expect(isProbeFailing([snap(60, -1), snap(70, -1)], 'cohere')).toBe(false)
  })
})
