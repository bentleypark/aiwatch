import { describe, it, expect } from 'vitest'
import { SERVICES, filterIncidents } from '../services'
import { parseIncidents } from '../parsers/statuspage'
import type { StatuspageResponse } from '../parsers/statuspage'

// #1430 — the windsurf card reads www.devinstatus.com, which also carries Devin Cloud.
const windsurf = SERVICES.find((s) => s.id === 'windsurf')!

function incident(id: string, name: string, components: string[]) {
  return {
    id, name, status: 'resolved', impact: 'major',
    created_at: '2026-09-03T21:28:28.243Z', resolved_at: '2026-09-03T22:41:32.617Z',
    components: components.map((n, i) => ({ id: `${id}-${i}`, name: n })),
    incident_updates: [],
  }
}

// The first two are live incidents from the page (2026-09-22 read); the rest carry Desktop tags, which no
// live incident has yet.
const feed = {
  incidents: [
    incident('26pf0c5sr4zw', 'Degradation in new Devin Sessions', ['Cloud Agent', 'Cloud Agent (Enterprise)']),
    incident('k0pr38j0qnzp', 'Devin sessions unable to start', []),
    incident('desktop-agent', 'Desktop agent errors', ['Desktop Agent']),
    incident('desktop-tab', 'Tab completions slow', ['Desktop Tab', 'Desktop Tab (Enterprise)']),
    incident('cloud-and-desktop', 'Auth outage', ['Cloud Agent', 'Desktop Agent']),
    incident('enterprise-only', 'Enterprise desktop agent errors', ['Desktop Agent (Enterprise)']),
  ],
} as unknown as StatuspageResponse

describe('windsurf incidents are scoped to the Desktop components (#1430)', () => {
  const kept = filterIncidents(parseIncidents(feed), windsurf).map((i) => i.id)

  it('drops Cloud-tagged and untagged incidents', () => {
    expect(kept).not.toContain('26pf0c5sr4zw')
    expect(kept).not.toContain('k0pr38j0qnzp')
  })

  it('keeps an incident naming Desktop Agent or Desktop Tab, alone or beside a Cloud component', () => {
    expect(kept).toEqual(expect.arrayContaining(['desktop-agent', 'desktop-tab', 'cloud-and-desktop']))
  })

  it('does not treat the Enterprise copy as a match for the component it copies', () => {
    expect(kept).not.toContain('enterprise-only')
  })
})
