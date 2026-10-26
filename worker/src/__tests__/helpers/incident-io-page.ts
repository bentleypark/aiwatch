// A prefetched incident.io status page, in the shape `fetchService` reads: the RSC payload carrying
// `component_impacts` + `component_uptimes`, and the Atlassian-compatible `summary.json` beside it.
const DAY = 86_400_000
const esc = (o: unknown) => JSON.stringify(o).replace(/"/g, '\\"')

const OLD = '2026-06-01T00:00:00Z'

export type Entry = { id: string; since?: string | null; published?: string; group?: string }

export function pageHtml(entries: Entry[], outage?: { id: string; hours: number }): string {
  const start = Date.now() - 5 * DAY
  const impacts = outage
    ? [{
        component_id: outage.id,
        start_at: new Date(start).toISOString(),
        end_at: new Date(start + outage.hours * 3_600_000).toISOString(),
        status: 'full_outage',
        status_page_incident_id: 'inc-1',
      }]
    : []
  const uptimes = entries.map((e) => ({
    component_id: e.id,
    data_available_since: e.since === undefined ? OLD : (e.since ?? '$undefined'),
    status_page_component_group_id: e.group ?? '$undefined',
    uptime: e.published ?? '100.00',
  }))
  return `<script>self.__next_f.push([1,"\\"component_impacts\\":${esc(impacts)},\\"component_uptimes\\":${esc(uptimes)}"])</script>`
}

export const summary = (entries: Entry[], name = 'Status') => ({
  page: { id: 'p1', name, updated_at: new Date().toISOString() },
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: entries.map((e) => ({ id: e.id, name: e.id, status: 'operational' })),
  incidents: [],
})

export function fakeKv() {
  const puts: string[] = []
  const kv = { get: async () => null, put: async (key: string) => { puts.push(key) }, delete: async () => {} }
  return { kv, puts }
}
