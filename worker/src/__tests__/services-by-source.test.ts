import { describe, it, expect } from 'vitest'
import { SERVICES, statusSourceOf, servicesByStatusSource } from '../services'

// #1384 review — `statusSourceOf` is what `/methodology` §1's per-source counts are summed from, so
// a service it cannot classify silently shrinks a published number. It is a DISPLAY taxonomy, not a
// mirror of `fetchServiceUntagged`'s dispatch (see its docblock): eleven services carry both
// `incidentIoBaseUrl` and `apiUrl` and are fetched through the apiUrl branch while being listed
// under incident.io, which is the vendor whose page it is.
describe('#1384 every monitored service resolves to exactly one status source', () => {
  it('classifies all of them — an unclassified service would vanish from the page total', () => {
    const unclassified = SERVICES.filter((s) => statusSourceOf(s) == null).map((s) => s.id)
    expect(unclassified).toEqual([])
  })

  it('partitions SERVICES — no service counted twice, none dropped', () => {
    const buckets = servicesByStatusSource()
    const ids = Object.values(buckets).flat()
    expect(ids.length, 'sum of the per-source counts must be the roster size').toBe(SERVICES.length)
    expect(new Set(ids).size, 'a service must not appear under two sources').toBe(ids.length)
  })

  it('puts an incident.io service on the incident.io row even though the apiUrl branch fetches it', () => {
    // The claim the first docblock got backwards. Pinned so a future reader does not "fix" the order
    // to match the dispatch and silently move 11 services to the Atlassian row.
    const both = SERVICES.filter((s) => s.incidentIoBaseUrl && s.apiUrl)
    expect(both.length, 'expected services carrying both fields').toBeGreaterThan(0)
    for (const s of both) expect(statusSourceOf(s), s.id).toBe('incident.io')
  })

  it('puts a Statuspage-compatible page with only an incident.io COMPONENT id on Statuspage', () => {
    const t = SERVICES.find((s) => s.id === 'turbopuffer')!
    expect(t.incidentIoBaseUrl, 'fixture premise: no base URL').toBeUndefined()
    expect(statusSourceOf(t)).toBe('Atlassian Statuspage')
  })
})
