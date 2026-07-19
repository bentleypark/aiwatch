import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseIncidentIoGlobalPage, computeIncidentIoUptime } from '../incident-io'
import { parseIncidents, normalizeStatus } from '../statuspage'
import { SERVICES, resolveSvcStatus, resolveSvcComponents } from '../../services'

// #1066 — LangSmith migrated to an incident.io "global"/multi-region page whose Atlassian v2 compat API
// returns `components: []`. parseIncidentIoGlobalPage rebuilds the summary.json shape from the page-root
// RSC so the rest of the pipeline (resolveSvcStatus / parseIncidents / calendar / miss-tracker) is unchanged.

// ── Synthetic RSC builder (the real backslash-escaped `self.__next_f.push` shape) ────────────────────
// A component catalog entry, and an incidents array, both as they appear escaped inside the RSC string.
const comp = (id: string, name: string) =>
  `\\"component\\":{\\"component_id\\":\\"${id}\\",\\"data_available_since\\":\\"2026-07-10T00:00:00Z\\",` +
  `\\"description\\":\\"$undefined\\",\\"display_uptime\\":true,\\"hidden\\":false,\\"name\\":\\"${name}\\"}`

interface SynIncident {
  id: string; name: string; status: string; type?: string; published_at: string
  affected: Array<{ id: string; current: string; status: string }>
  end_at?: string
  updates?: Array<{ to: string; msg: string; at: string }>
}
const incident = (i: SynIncident) => {
  const acs = i.affected.map((a) =>
    `{\\"component_id\\":\\"${a.id}\\",\\"current_status\\":\\"${a.current}\\",\\"status\\":\\"${a.status}\\"}`).join(',')
  const updates = (i.updates ?? []).map((u) =>
    `{\\"message_string\\":\\"${u.msg}\\",\\"published_at\\":\\"${u.at}\\",\\"to_status\\":\\"${u.to}\\"}`).join(',')
  const summaries = `[{\\"start_at\\":\\"${i.published_at}\\",\\"end_at\\":\\"${i.end_at ?? '$undefined'}\\",\\"worst_component_status\\":\\"partial_outage\\"}]`
  return `{\\"affected_components\\":[${acs}],\\"id\\":\\"${i.id}\\",\\"name\\":\\"${i.name}\\",` +
    `\\"published_at\\":\\"${i.published_at}\\",\\"status\\":\\"${i.status}\\",\\"status_page_id\\":\\"PG\\",` +
    `\\"status_summaries\\":${summaries},\\"type\\":\\"${i.type ?? 'incident'}\\",\\"updates\\":[${updates}]}`
}
// incident_links = the FULL history feed (lightweight); component_impacts = timing + attribution.
const link = (l: { id: string; name: string; status: string; at: string }) =>
  `{\\"id\\":\\"${l.id}\\",\\"name\\":\\"${l.name}\\",\\"permalink\\":\\"https://statuspage.incident.io/x/${l.id}\\",` +
  `\\"published_at\\":\\"${l.at}\\",\\"status\\":\\"${l.status}\\"}`
const impact = (i: { inc: string; comp: string; start: string; end: string; status: string }) =>
  `{\\"component_id\\":\\"${i.comp}\\",\\"end_at\\":\\"${i.end}\\",\\"id\\":\\"IMP\\",\\"start_at\\":\\"${i.start}\\",` +
  `\\"status\\":\\"${i.status}\\",\\"status_page_incident_id\\":\\"${i.inc}\\"}`
const page = (comps: string[], incs: string[], links: string[] = [], impacts: string[] = []) =>
  `<script>self.__next_f.push([1,"x:[{${comps.join('},{')}}],` +
  `\\"incident_links\\":[${links.join(',')}],` +
  `\\"component_impacts\\":[${impacts.join(',')}],\\"component_uptimes\\":[],` +
  `\\"incidents\\":[${incs.join(',')}]"])</script>`

const API = '01KX6FV0RRSSTKC5V2GPAMCEQR'
const RUN = '01KX6FV0RR5XXJ0SM3NXZRKMBY'
const APP = '01KX6FV0RRKA56PXCRWEHJTMXM'

describe('parseIncidentIoGlobalPage (#1066)', () => {
  it('rebuilds the component catalog with all-operational default (no active incidents)', () => {
    const html = page([comp(API, 'LangSmith API'), comp(RUN, 'LangSmith Run Ingestion')], [])
    const res = parseIncidentIoGlobalPage(html)
    expect(res).not.toBeNull()
    expect(res!.components).toEqual([
      { id: API, name: 'LangSmith API', status: 'operational' },
      { id: RUN, name: 'LangSmith Run Ingestion', status: 'operational' },
    ])
    expect(res!.status.indicator).toBe('none')
  })

  it('an ACTIVE partial_outage degrades exactly its component; a resolved one does not', () => {
    const html = page(
      [comp(API, 'LangSmith API'), comp(RUN, 'LangSmith Run Ingestion')],
      [
        incident({ id: 'I1', name: 'API errors', status: 'investigating', published_at: '2026-07-18T10:00:00Z',
          affected: [{ id: API, current: 'partial_outage', status: 'partial_outage' }] }),
        incident({ id: 'I2', name: 'old', status: 'resolved', published_at: '2026-07-01T00:00:00Z', end_at: '2026-07-01T01:00:00Z',
          affected: [{ id: RUN, current: 'operational', status: 'partial_outage' }] }),
      ],
    )
    const res = parseIncidentIoGlobalPage(html)!
    const byId = Object.fromEntries(res.components!.map((c) => [c.id, c.status]))
    expect(byId[API]).toBe('partial_outage')  // active → degraded
    expect(byId[RUN]).toBe('operational')     // resolved incident must not degrade
    // normalizeStatus maps the emitted vocab correctly (partial_outage → degraded).
    expect(normalizeStatus(byId[API])).toBe('degraded')
    expect(res.status.indicator).toBe('minor')
  })

  it('full_outage is emitted as major_outage so normalizeStatus reads it as down (not operational)', () => {
    const html = page([comp(API, 'LangSmith API')],
      [incident({ id: 'I3', name: 'API down', status: 'investigating', published_at: '2026-07-18T10:00:00Z',
        affected: [{ id: API, current: 'full_outage', status: 'full_outage' }] })])
    const res = parseIncidentIoGlobalPage(html)!
    expect(res.components![0].status).toBe('major_outage')
    expect(normalizeStatus(res.components![0].status)).toBe('down')
    expect(res.status.indicator).toBe('critical')
  })

  it('drops maintenance-type entries (announced maintenance is not an outage)', () => {
    const html = page([comp(API, 'LangSmith API')],
      [incident({ id: 'M1', name: 'API Maintenance', status: 'investigating', type: 'maintenance',
        published_at: '2026-07-18T10:00:00Z', affected: [{ id: API, current: 'under_maintenance', status: 'under_maintenance' }] })])
    const res = parseIncidentIoGlobalPage(html)!
    expect(res.components![0].status).toBe('operational')
    expect(res.incidents).toHaveLength(0)
  })

  it('maps a resolved incident to the Atlassian shape parseIncidents consumes (text + resolvedAt)', () => {
    const html = page([comp(RUN, 'LangSmith Run Ingestion')],
      [incident({ id: 'I4', name: 'Ingestion is delayed', status: 'resolved',
        published_at: '2026-07-12T21:28:58Z', end_at: '2026-07-12T21:59:18Z',
        affected: [{ id: RUN, current: 'operational', status: 'partial_outage' }],
        updates: [
          { to: 'investigating', msg: 'We are seeing some failures in trace ingestion.', at: '2026-07-12T21:28:58Z' },
          { to: 'resolved', msg: 'Ingestion has recovered.', at: '2026-07-12T21:59:18Z' },
        ] })])
    const res = parseIncidentIoGlobalPage(html)!
    const incidents = parseIncidents(res)
    expect(incidents).toHaveLength(1)
    const inc = incidents[0]
    expect(inc.title).toBe('Ingestion is delayed')
    expect(inc.status).toBe('resolved')
    expect(inc.resolvedAt).toBe('2026-07-12T21:59:18Z')
    expect(inc.componentNames).toEqual(['LangSmith Run Ingestion'])
    // timeline text comes straight from message_string → no enrichment fetch needed
    expect(inc.timeline.map((t) => t.text)).toEqual([
      'We are seeing some failures in trace ingestion.',
      'Ingestion has recovered.',
    ])
  })

  it('includes the FULL history from incident_links (not just the recent `incidents` feed), joined with impacts', () => {
    // A history-only incident (in incident_links + component_impacts, absent from the recent feed) must
    // still appear, with resolvedAt + duration derived from its impact record.
    const html = page(
      [comp(RUN, 'LangSmith Run Ingestion')],
      [], // empty recent feed
      [
        link({ id: 'H1', name: 'Old outage', status: 'resolved', at: '2026-05-13T12:00:00Z' }),
        link({ id: 'H2', name: 'Older outage', status: 'resolved', at: '2026-04-30T09:00:00Z' }),
      ],
      [
        impact({ inc: 'H1', comp: RUN, start: '2026-05-13T12:00:00Z', end: '2026-05-13T12:45:00Z', status: 'partial_outage' }),
        impact({ inc: 'H2', comp: RUN, start: '2026-04-30T09:00:00Z', end: '2026-04-30T12:31:00Z', status: 'full_outage' }),
      ],
    )
    const incidents = parseIncidents(parseIncidentIoGlobalPage(html)!)
    expect(incidents.map((i) => i.id).sort()).toEqual(['H1', 'H2'])
    const h1 = incidents.find((i) => i.id === 'H1')!
    expect(h1.title).toBe('Old outage')
    expect(h1.status).toBe('resolved')
    expect(h1.resolvedAt).toBe('2026-05-13T12:45:00Z') // from the impact end_at
    expect(h1.duration).toBe('45m')
    expect(h1.componentNames).toEqual(['LangSmith Run Ingestion'])
  })

  it('derives the outage window from impact records, not published_at (no negative duration)', () => {
    // Real case: "Increased latency" was published_at 12:58, but its impacts ran 12:18→12:56 — using
    // published_at as the start gave a −3m duration. Start must come from the earliest impact.
    const html = page(
      [comp(API, 'LangSmith API')],
      [],
      [link({ id: 'LATE', name: 'Increased latency', status: 'resolved', at: '2026-05-13T12:58:36Z' })],
      [
        impact({ inc: 'LATE', comp: API, start: '2026-05-13T12:18:00Z', end: '2026-05-13T12:40:00Z', status: 'degraded_performance' }),
        impact({ inc: 'LATE', comp: API, start: '2026-05-13T12:52:00Z', end: '2026-05-13T12:56:00Z', status: 'degraded_performance' }),
      ],
    )
    const inc = parseIncidents(parseIncidentIoGlobalPage(html)!)[0]
    expect(inc.startedAt).toBe('2026-05-13T12:18:00Z') // earliest impact start, NOT published_at
    expect(inc.resolvedAt).toBe('2026-05-13T12:56:00Z') // latest impact end
    expect(inc.duration).toBe('38m')
    expect(Date.parse(inc.resolvedAt!)).toBeGreaterThanOrEqual(Date.parse(inc.startedAt))
  })

  it('drops maintenance-status entries from incident_links', () => {
    const html = page(
      [comp(API, 'LangSmith API')],
      [],
      [
        link({ id: 'H1', name: 'Real outage', status: 'resolved', at: '2026-05-01T00:00:00Z' }),
        link({ id: 'MNT', name: 'API Maintenance', status: 'maintenance_complete', at: '2026-04-28T00:00:00Z' }),
      ],
      [impact({ inc: 'H1', comp: API, start: '2026-05-01T00:00:00Z', end: '2026-05-01T00:30:00Z', status: 'partial_outage' })],
    )
    const res = parseIncidentIoGlobalPage(html)!
    expect(res.incidents!.map((i) => i.name)).toEqual(['Real outage'])
  })

  it('the recent detailed feed wins over its history link (keeps timeline text), no duplicate row', () => {
    const html = page(
      [comp(RUN, 'LangSmith Run Ingestion')],
      [incident({ id: 'D1', name: 'Ingestion is delayed', status: 'resolved',
        published_at: '2026-07-12T21:28:58Z', end_at: '2026-07-12T21:59:18Z',
        affected: [{ id: RUN, current: 'operational', status: 'partial_outage' }],
        updates: [{ to: 'investigating', msg: 'trace ingestion failing', at: '2026-07-12T21:28:58Z' }] })],
      [link({ id: 'D1', name: 'Ingestion is delayed', status: 'resolved', at: '2026-07-12T21:28:58Z' })],
    )
    const incidents = parseIncidents(parseIncidentIoGlobalPage(html)!)
    expect(incidents).toHaveLength(1) // deduped by id
    expect(incidents[0].timeline.map((t) => t.text)).toEqual(['trace ingestion failing'])
  })

  it('returns null when the page carries no component catalog (shape change / wrong format)', () => {
    expect(parseIncidentIoGlobalPage('<html>not incident.io</html>')).toBeNull()
    expect(parseIncidentIoGlobalPage('')).toBeNull()
  })
})

// ── Shape-lock against the REAL migrated page (captured 2026-07-18) ──────────────────────────────────
describe('parseIncidentIoGlobalPage — real LangSmith global page fixture (#1066)', () => {
  const html = readFileSync(resolve(__dirname, 'fixtures/langsmith-global-page.html'), 'utf8')

  it('extracts all 10 LangSmith components with the three badge surfaces present', () => {
    const res = parseIncidentIoGlobalPage(html)
    expect(res).not.toBeNull()
    expect(res!.components).toHaveLength(10)
    const byId = Object.fromEntries(res!.components!.map((c) => [c.id, c]))
    expect(byId[API]?.name).toBe('LangSmith API')
    expect(byId[RUN]?.name).toBe('LangSmith Run Ingestion')
    expect(byId[APP]?.name).toBe('LangSmith Application')
    // The page is currently clean → the badge worst-of resolves operational, and the migration
    // "component not found" alert can no longer fire (all configured ids are present).
    for (const id of [API, RUN, APP]) expect(byId[id]?.status).toBe('operational')
    expect(res!.status.indicator).toBe('none')
  })

  it('reconstructs the FULL ~90-day history (14 links − 3 maintenance = 11), with durations', () => {
    const res = parseIncidentIoGlobalPage(html)!
    const incidents = parseIncidents(res)
    // The bug this fixes: only the 2 recent `incidents`-feed entries showed; the older history
    // (incident_links) was dropped. All 11 non-maintenance incidents must now be present.
    expect(incidents).toHaveLength(11)
    // Maintenance entries are excluded.
    expect(incidents.some((i) => /maintenance/i.test(i.title))).toBe(false)
    // History reaches back to April (not just July), and every incident has title + valid startedAt.
    const dates = incidents.map((i) => i.startedAt).sort()
    expect(dates[0] < '2026-05-01').toBe(true)
    for (const inc of incidents) {
      expect(inc.title.length).toBeGreaterThan(0)
      expect(Date.parse(inc.startedAt)).not.toBeNaN()
      expect(inc.duration).toBeTruthy() // computed from component_impacts start/end
      // No resolve before its start (the published_at-after-impact bug would produce a negative duration).
      expect(Date.parse(inc.resolvedAt!)).toBeGreaterThanOrEqual(Date.parse(inc.startedAt))
    }
  })

  it('uptime still computes from the same RSC (the badge worst-of), with a sub-30-day window', () => {
    // component data_available_since is 2026-07-10 on the migrated page → the window is short and honest.
    const io = computeIncidentIoUptime(html, [RUN, API, APP], Date.parse('2026-07-18T00:00:00Z'))
    expect(io).not.toBeNull()
    expect(io!.pct).toBeGreaterThan(0)
    expect(io!.pct).toBeLessThanOrEqual(100)
    expect(io!.days).toBeLessThan(30)
  })
})

// ── Incident severity, multi-component, active rows, shortlink ───────────────────────────────────────
describe('parseIncidentIoGlobalPage — incident row fields (#1066)', () => {
  it('maps impact severity worst-of across an incident\'s components (full>partial>degraded)', () => {
    const cases: Array<[string, 'critical' | 'major' | 'minor']> = [
      ['full_outage', 'critical'], ['partial_outage', 'major'], ['degraded_performance', 'minor'],
    ]
    for (const [ioStatus, atlassian] of cases) {
      const html = page([comp(API, 'LangSmith API')], [],
        [link({ id: 'S', name: 'x', status: 'resolved', at: '2026-05-01T00:00:00Z' })],
        [impact({ inc: 'S', comp: API, start: '2026-05-01T00:00:00Z', end: '2026-05-01T01:00:00Z', status: ioStatus })])
      expect(parseIncidents(parseIncidentIoGlobalPage(html)!)[0].impact).toBe(atlassian)
    }
  })

  it('an incident spanning multiple components: worst-of severity + ALL component names', () => {
    const html = page(
      [comp(API, 'LangSmith API'), comp(RUN, 'LangSmith Run Ingestion')],
      [],
      [link({ id: 'M', name: 'Multi', status: 'resolved', at: '2026-05-01T00:00:00Z' })],
      [
        impact({ inc: 'M', comp: RUN, start: '2026-05-01T00:00:00Z', end: '2026-05-01T00:30:00Z', status: 'degraded_performance' }),
        impact({ inc: 'M', comp: API, start: '2026-05-01T00:05:00Z', end: '2026-05-01T00:40:00Z', status: 'full_outage' }),
      ],
    )
    const inc = parseIncidents(parseIncidentIoGlobalPage(html)!)[0]
    expect(inc.impact).toBe('critical') // worst-of full_outage
    expect([...(inc.componentNames ?? [])].sort()).toEqual(['LangSmith API', 'LangSmith Run Ingestion'])
    expect(inc.startedAt).toBe('2026-05-01T00:00:00Z') // earliest across both impacts
    expect(inc.resolvedAt).toBe('2026-05-01T00:40:00Z') // latest across both impacts
  })

  it('an ACTIVE (ongoing) incident: resolved_at null + non-resolved status + degraded component', () => {
    const html = page([comp(API, 'LangSmith API')],
      [incident({ id: 'A', name: 'ongoing', status: 'investigating', published_at: '2026-07-18T10:00:00Z',
        affected: [{ id: API, current: 'partial_outage', status: 'partial_outage' }] })])
    const res = parseIncidentIoGlobalPage(html)!
    const inc = parseIncidents(res)[0]
    expect(inc.status).toBe('investigating')
    expect(inc.resolvedAt).toBeNull()
    expect(res.components!.find((c) => c.id === API)!.status).toBe('partial_outage')
  })

  it('sets shortlink from the incident_links permalink (so enrichIncidentIoText can backfill text)', () => {
    const html = page([comp(API, 'LangSmith API')], [],
      [link({ id: 'P', name: 'x', status: 'resolved', at: '2026-05-01T00:00:00Z' })],
      [impact({ inc: 'P', comp: API, start: '2026-05-01T00:00:00Z', end: '2026-05-01T00:10:00Z', status: 'partial_outage' })])
    const res = parseIncidentIoGlobalPage(html)!
    expect((res.incidents![0] as { shortlink?: string }).shortlink).toBe('https://statuspage.incident.io/x/P')
  })

  it('an ACTIVE incident present only in incident_links is not mislabeled resolved', () => {
    // Row-level honesty: status stays non-resolved. (Component degrade still needs the detailed feed's
    // affected_components, which links lack — documented limitation, active always carries a detailed entry.)
    const html = page([comp(API, 'LangSmith API')], [],
      [link({ id: 'L', name: 'stuck', status: 'investigating', at: '2026-07-18T10:00:00Z' })],
      [impact({ inc: 'L', comp: API, start: '2026-07-18T10:00:00Z', end: '2026-07-18T10:30:00Z', status: 'partial_outage' })])
    const inc = parseIncidents(parseIncidentIoGlobalPage(html)!)[0]
    expect(inc.status).toBe('investigating')
    expect(inc.resolvedAt).toBeNull()
  })
})

// ── Fail-safe: unreadable load-bearing data withholds (does not fabricate operational) ───────────────
describe('parseIncidentIoGlobalPage — fail-safe (#1066/#713)', () => {
  it('returns null when the `incidents` array is present but unparseable (withhold, not fabricate)', () => {
    // Component catalog is fine, but the load-bearing `incidents` array is corrupt → must withhold so the
    // caller flags sourceUnknown instead of showing an all-operational badge during a possible outage.
    const broken = `<script>self.__next_f.push([1,"x:[{${comp(API, 'LangSmith API')}}],` +
      `\\"incidents\\":[{\\"id\\":\\"BAD\\",\\"status\\":\\"investigating\\",\\"affected_\`corrupt"])</script>`
    expect(parseIncidentIoGlobalPage(broken)).toBeNull()
  })

  it('a missing/empty `incidents` array is a VALID no-active-incidents state (not a failure)', () => {
    const html = page([comp(API, 'LangSmith API')], []) // empty incidents array
    const res = parseIncidentIoGlobalPage(html)
    expect(res).not.toBeNull()
    expect(res!.components![0].status).toBe('operational')
  })

  it('drops an incident that can be placed nowhere in time (no impact start AND no published_at)', () => {
    // A history link lacking published_at, with no matching component_impacts → un-timeable. It must be
    // dropped, NOT emitted with a 1970 `new Date(0)` start. A well-formed sibling is still kept.
    const noTimeLink = `{\\"id\\":\\"NOTIME\\",\\"name\\":\\"broken\\",\\"permalink\\":\\"https://x/NOTIME\\",\\"status\\":\\"resolved\\"}`
    const html = page([comp(API, 'LangSmith API')], [],
      [noTimeLink, link({ id: 'OK', name: 'fine', status: 'resolved', at: '2026-05-01T00:00:00Z' })],
      [impact({ inc: 'OK', comp: API, start: '2026-05-01T00:00:00Z', end: '2026-05-01T00:10:00Z', status: 'partial_outage' })])
    const incidents = parseIncidents(parseIncidentIoGlobalPage(html)!)
    expect(incidents.map((i) => i.id)).toEqual(['OK']) // NOTIME dropped, no 1970 timestamp emitted
  })
})

// ── Integration: the reconstructed summary flows through the real langsmith config ───────────────────
describe('parseIncidentIoGlobalPage → resolveSvcStatus with the real langsmith config (#1066)', () => {
  const langsmith = SERVICES.find((s) => s.id === 'langsmith')!
  const fixture = readFileSync(resolve(__dirname, 'fixtures/langsmith-global-page.html'), 'utf8')

  it('the clean real page resolves the badge worst-of to operational + 10-component breakdown', () => {
    const rebuilt = parseIncidentIoGlobalPage(fixture)!
    expect(resolveSvcStatus(langsmith, rebuilt, [])).toBe('operational')
    expect(resolveSvcComponents(langsmith, rebuilt)).toHaveLength(10)
  })

  it('an active full_outage on a badge component drives the real config to `down`', () => {
    const html = page(
      [comp(API, 'LangSmith API'), comp(RUN, 'LangSmith Run Ingestion'), comp(APP, 'LangSmith Application')],
      [incident({ id: 'D', name: 'API down', status: 'investigating', published_at: '2026-07-18T10:00:00Z',
        affected: [{ id: API, current: 'full_outage', status: 'full_outage' }] })],
    )
    const rebuilt = parseIncidentIoGlobalPage(html)!
    // API is in langsmith.statusComponentIds → worst-of major_outage → down.
    expect(resolveSvcStatus(langsmith, rebuilt, [])).toBe('down')
  })
})
