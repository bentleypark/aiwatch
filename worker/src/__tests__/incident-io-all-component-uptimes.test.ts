import { describe, it, expect } from 'vitest'
import { parseIncidentIoAllComponentUptimes } from '../parsers/incident-io'

const esc = (o: unknown) => JSON.stringify(o).replace(/"/g, '\\"')

function pageHtml(uptimes: unknown[]): string {
  const payload = `\\"component_impacts\\":[],\\"component_uptimes\\":${esc(uptimes)}`
  return `<script>self.__next_f.push([1,"${payload}"])</script>`
}

describe('parseIncidentIoAllComponentUptimes (#1518 roster audit — the multi-id generalization of parseIncidentIoDataAvailableSince)', () => {
  it('lists every entry with a real component_id, each paired with its own data_available_since', () => {
    const html = pageHtml([
      { component_id: 'AAA', data_available_since: '2026-06-01T00:00:00Z', uptime: '100.00' },
      { component_id: 'BBB', data_available_since: '2026-08-15T00:00:00Z', uptime: '99.90' },
    ])
    expect(parseIncidentIoAllComponentUptimes(html).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'AAA', dataAvailableSince: '2026-06-01T00:00:00Z' },
      { id: 'BBB', dataAvailableSince: '2026-08-15T00:00:00Z' },
    ])
  })

  it('skips a GROUP aggregate entry (component_id: "$undefined") — it names no single component', () => {
    const html = pageHtml([
      { component_id: '$undefined', status_page_component_group_id: 'GRP', data_available_since: '2026-01-01T00:00:00Z', uptime: '99.97' },
      { component_id: 'REAL', data_available_since: '2026-06-01T00:00:00Z', uptime: '100.00' },
    ])
    expect(parseIncidentIoAllComponentUptimes(html)).toEqual([{ id: 'REAL', dataAvailableSince: '2026-06-01T00:00:00Z' }])
  })

  it('reports null for an unparseable/empty/$undefined data_available_since, distinct from absent', () => {
    const html = pageHtml([
      { component_id: 'EMPTY', data_available_since: '', uptime: '100.00' },
      { component_id: 'GONE', data_available_since: '$undefined', uptime: '$undefined' },
      { component_id: 'BAD', data_available_since: 'not-a-date', uptime: '100.00' },
    ])
    expect(parseIncidentIoAllComponentUptimes(html).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'BAD', dataAvailableSince: null },
      { id: 'EMPTY', dataAvailableSince: null },
      { id: 'GONE', dataAvailableSince: null },
    ])
  })

  it('deduplicates an id repeated across RSC chunks — the FIRST chunk to NAME it wins', () => {
    const chunk1 = pageHtml([{ component_id: 'AAA', data_available_since: '2026-06-01T00:00:00Z', uptime: '100.00' }])
    const chunk2 = pageHtml([{ component_id: 'AAA', data_available_since: '2099-01-01T00:00:00Z', uptime: '50.00' }])
    expect(parseIncidentIoAllComponentUptimes(chunk1 + chunk2)).toEqual([{ id: 'AAA', dataAvailableSince: '2026-06-01T00:00:00Z' }])
  })

  it('the first chunk wins even when IT is the unresolvable one — matches the single-id reader, which never looks past its first match either', () => {
    const chunk1 = pageHtml([{ component_id: 'AAA', data_available_since: '$undefined', uptime: '$undefined' }])
    const chunk2 = pageHtml([{ component_id: 'AAA', data_available_since: '2026-06-01T00:00:00Z', uptime: '100.00' }])
    expect(parseIncidentIoAllComponentUptimes(chunk1 + chunk2)).toEqual([{ id: 'AAA', dataAvailableSince: null }])
  })

  it('empty component_uptimes array yields no entries', () => {
    expect(parseIncidentIoAllComponentUptimes(pageHtml([]))).toEqual([])
  })

  it('no component_uptimes marker at all yields no entries', () => {
    expect(parseIncidentIoAllComponentUptimes('<html>no markers here</html>')).toEqual([])
  })
})
