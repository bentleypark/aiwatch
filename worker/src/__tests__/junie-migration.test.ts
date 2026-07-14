import { describe, it, expect, vi, afterEach } from 'vitest'
import { SERVICES, filterIncidents, fetchService } from '../services'
import { attachIncidentIoComponentNames, parseIncidentIoIncidentComponentIds, parseIncidentIoUptime } from '../parsers/incident-io'
import { isProbeFailing, PROBE_TARGETS } from '../probe'
import { STATUS_URL } from '../../../src/utils/statusPageUrls'
import type { Incident } from '../types'

// #1004 — JetBrains moved their AI status page from Atlassian Statuspage (status.jetbrains.ai) to
// incident.io (status.jetbrains.cloud). The old host now 301s to the new SITE ROOT — the redirect drops
// the path — so the configured apiUrl resolved to a 200 text/html page, `summaryRes.json()` threw,
// fetchService fell into its catch, and after 3 consecutive failures junie sat on the fetch-failure
// fallback: a FALSE `degraded` badge for a service JetBrains reported as fully operational.
//
// The tests below are deliberately of two kinds, because they catch different things:
//   - the CONFIG assertions are a REVERT guard. They pin our own constants, so a future upstream
//     migration leaves them green — they cannot detect one. (Nothing can, today: the #992
//     new-component detector watches component rosters on a page that FETCHED successfully, and a
//     whole-page migration breaks the fetch itself. That gap is real and unclosed.)
//   - the BEHAVIOURAL assertions are the ones that would have failed. The incident.io feed drops
//     component tags, which silently guts the #683 incident scoping — a far worse bug than the one
//     being fixed, and invisible to any config pin.

const JUNIE_ID = '01KX3EN5353NA7819G7ND9Q3KA'
const AI_PLATFORM_ID = '01KX3EN535A0SKSZK3S84949V1'
const GRAZIE_ID = '01KX3EN5354CVBD36GANTX2BC4'

const junie = SERVICES.find((s) => s.id === 'junie')!

describe('junie config (#1004 revert guard)', () => {
  it('points at the incident.io host, not the retired Atlassian one', () => {
    expect(junie.statusUrl).toBe('https://status.jetbrains.cloud')
    expect(junie.apiUrl).toBe('https://status.jetbrains.cloud/api/v2/summary.json')
    // The 301 off the old host carries no path, so any status.jetbrains.ai URL lands on HTML.
    expect(JSON.stringify(junie)).not.toContain('status.jetbrains.ai')
  })

  it('carries the new incident.io ULIDs, not the dead Atlassian hashes', () => {
    expect(junie.statusComponentId).toBe(JUNIE_ID)
    expect(junie.displayComponentIds).toEqual([JUNIE_ID, AI_PLATFORM_ID])
    expect(JSON.stringify(junie)).not.toContain('9vbyyqkkjxl4')
  })

  it('sets incidentIoComponentId — the flag that routes uptime through the incident.io parser', () => {
    // incident.io keeps uptime in the page HTML's __next_f (component_uptimes), never in summary.json,
    // so without this flag uptime30d stays null even on the right host.
    expect(junie.incidentIoComponentId).toBe(JUNIE_ID)
    expect(junie.incidentIoBaseUrl).toBe('https://status.jetbrains.cloud/incidents')
  })
})

// Guards the class of half-done migration this issue actually was: someone updates `apiUrl` and forgets
// `statusUrl` or `incidentIoBaseUrl`, leaving one field pointing at a host that 301s. Applies to all 43.
describe('every service points its status URLs at ONE host', () => {
  const hostOf = (u: string) => new URL(u).host.replace(/^www\./, '')
  // A provider may legitimately serve its HUMAN page from a vanity domain while the machine endpoint
  // stays on the vendor host (deepseek: status.deepseek.com → deepseek.statuspage.io). Pinned so the
  // list stays a deliberate, short one — the invariant still holds for the other 42.
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

const uptimeEntry = (id: string, uptime: string) =>
  `{\\"component_id\\":\\"${id}\\",\\"data_available_since\\":\\"2026-07-09T12:46:46Z\\",` +
  `\\"status_page_component_group_id\\":\\"$undefined\\",\\"uptime\\":\\"${uptime}\\"}`

/** The page HTML shape: one RSC push carrying component_impacts followed by component_uptimes. */
const pageHtml = (impacts: string[], uptimes: string[] = [uptimeEntry(JUNIE_ID, '100.00')]) =>
  `<script>self.__next_f.push([1,"a:{\\"component_impacts\\":[${impacts.join(',')}],` +
  `\\"component_uptimes\\":[${uptimes.join(',')}],\\"incident_links\\":[]}"])</script>`

const COMPONENTS = [
  { id: JUNIE_ID, name: 'Junie' },
  { id: AI_PLATFORM_ID, name: 'AI Platform' },
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
    const html = pageHtml([impact('INC1', JUNIE_ID), impact('INC2', GRAZIE_ID)])
    const out = attachIncidentIoComponentNames(
      [apiIncident('INC1', 'Junie is slow'), apiIncident('INC2', 'NLP errors')], html, COMPONENTS,
    )
    expect(out[0].componentNames).toEqual(['Junie'])
    expect(out[1].componentNames).toEqual(['Grazie'])
  })

  it('leaves an incident untagged when the page has no impact for it (no invention)', () => {
    const out = attachIncidentIoComponentNames([apiIncident('INC9', 'Unmapped')], pageHtml([impact('INC1', JUNIE_ID)]), COMPONENTS)
    expect(out[0].componentNames).toBeUndefined()
  })

  it('never emits a raw ULID as a component name (an unknown id is skipped)', () => {
    const out = attachIncidentIoComponentNames([apiIncident('INC1', 'x')], pageHtml([impact('INC1', '01UNKNOWNID')]), COMPONENTS)
    expect(out[0].componentNames).toBeUndefined()
  })

  it('does not overwrite names the API DID provide', () => {
    const tagged = { ...apiIncident('INC1', 'x'), componentNames: ['FromAPI'] } as Incident
    const out = attachIncidentIoComponentNames([tagged], pageHtml([impact('INC1', JUNIE_ID)]), COMPONENTS)
    expect(out[0].componentNames).toEqual(['FromAPI'])
  })

  it('returns the incidents untouched when the page carries no impacts at all', () => {
    const incidents = [apiIncident('INC1', 'x')]
    expect(attachIncidentIoComponentNames(incidents, '<html>nothing</html>', COMPONENTS)).toBe(incidents)
  })

  it('collects every component an incident impacted', () => {
    const html = pageHtml([impact('INC1', JUNIE_ID), impact('INC1', AI_PLATFORM_ID), impact('INC1', JUNIE_ID)])
    expect(parseIncidentIoIncidentComponentIds(html)['INC1']).toEqual([JUNIE_ID, AI_PLATFORM_ID])
  })
})

// The integration test that actually encodes the bug: push the REAL feed shape through the REAL
// `filterIncidents` with the REAL junie config. Without the enrichment above, `incidentComponents:
// ['Junie']` matches nothing (every incident is untagged) and junie loses EVERY incident — forever,
// silently, and with no `includeUntaggedIncidents` valve to save it (that valve is gated on
// `incidentKeywords`, which junie does not set). #940's lesson: a transform must be proven through the
// real filter, not asserted in isolation.
describe('junie incidents survive filterIncidents on the incident.io feed (#1004 + #683)', () => {
  const html = pageHtml([impact('INC1', JUNIE_ID), impact('INC2', GRAZIE_ID)])
  const fromApi = [apiIncident('INC1', 'Junie requests failing'), apiIncident('INC2', 'Raised error rates from NLP services')]

  it('WITHOUT the tag rebuild, every incident is dropped (the bug)', () => {
    expect(filterIncidents(fromApi, junie)).toEqual([])
  })

  it('WITH the tag rebuild, the Junie incident survives and the Grazie one is still scoped out', () => {
    const tagged = attachIncidentIoComponentNames(fromApi, html, COMPONENTS)
    const filtered = filterIncidents(tagged, junie)
    expect(filtered.map((i) => i.id)).toEqual(['INC1'])
  })
})

describe('junie uptime is reachable through the configured id (#857 shape)', () => {
  it('the configured incidentIoComponentId resolves a component_uptimes value', () => {
    // Guards the "right host, uptime silently null" failure — the #857 class. It cannot prove the ULID
    // still matches the LIVE page; that is what the production verify-after assert is for.
    const pct = parseIncidentIoUptime(pageHtml([], [uptimeEntry(junie.incidentIoComponentId as string, '99.87')]), junie.incidentIoComponentId!)
    expect(pct).toBe(99.87)
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

    const first = await fetchService(junie, undefined, kv)
    expect(first.status).toBe('operational')      // one bad read is not an outage
    expect(first.sourceUnknown).toBe(true)        // …but it is not a clean read either

    const second = await fetchService(junie, undefined, kv)
    expect(second.status).toBe('operational')

    const third = await fetchService(junie, undefined, kv)
    expect(third.status).toBe('degraded')         // the fallback that looked like a real outage
    expect(third.sourceUnknown).toBe(true)        // …and the flag that lets the UI say otherwise
    expect(third.uptime30d).toBeNull()            // nothing was read, so nothing is claimed
  })
})

// ── The producer of `probeContradicted` (the guard that keeps a REAL outage amber) ──

// Without this, `svc.probeContradicted = true` could be deleted from the cross-validation and every
// consumer test (src/utils/statusDisplay.test.js) would still pass — while a probe-corroborated outage
// got neutralised into "we can't tell". The `debugging_fix_the_called_path_not_the_tested_twin` shape.
describe('isProbeFailing — only ACTUAL failure contradicts an unreadable source (#1004)', () => {
  const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString()
  const snap = (minsAgo: number, rtt: number) => ({ t: at(minsAgo), data: { cohere: { status: rtt > 0 ? 200 : 0, rtt } } })

  it('a failing probe (rtt <= 0 — what failedProbe() writes) contradicts', () => {
    expect(isProbeFailing([snap(2, -1), snap(7, -1)], 'cohere')).toBe(true)
  })

  it('a >3x median spike majority contradicts', () => {
    // The median is computed over ALL snapshots (not just recent ones), so a realistic set needs a
    // healthy baseline: 6 old samples at ~100ms → median 100 → threshold 300 → the two recent 4000ms
    // samples are spikes. (Feeding only spiked samples would drag the median up with them — which is
    // why the rtt<=0 case above, not the spike case, is what a real outage usually looks like.)
    const baseline = [20, 25, 30, 35, 40, 45].map((m) => snap(m, 100))
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
