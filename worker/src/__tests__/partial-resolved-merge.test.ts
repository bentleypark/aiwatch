import { describe, expect, it } from 'vitest'
import { buildIncidentAlerts, type ScoredService } from '../alerts'
import { buildRssFeed } from '../rss'
import type { Incident, ServiceStatus } from '../types'

// #1350 — a merged group whose first member recovered: still active, no resolvedAt, but carrying that
// member's `resolved` row. resolvedAtOf would read that row as the incident's resolution; these pin the
// `status === 'resolved'` gates in the /feed builder and the Resolved alert.
const PARTIAL: Incident = {
  id: 'grok-0903',
  title: 'Grok is experiencing issues [iOS, Web]',
  status: 'investigating',
  impact: 'major',
  startedAt: '2026-09-03T13:30:00Z',
  resolvedAt: null,
  duration: null,
  timeline: [
    { stage: 'investigating', text: 'Grok is experiencing issues.', at: '2026-09-03T13:30:00Z' },
    { stage: 'resolved', text: 'We have resolved the situation.', at: '2026-09-03T17:04:59Z' },
  ],
}

const svc = { id: 'grok', name: 'Grok', provider: 'xAI', category: 'app', status: 'degraded', latency: null, uptime30d: null, lastChecked: '2026-09-03T17:05:00Z', incidents: [PARTIAL] } as ServiceStatus
const NOW = Date.parse('2026-09-03T17:05:30Z')

describe('partially-resolved merged group (#1350)', () => {
  it('/feed carries it as active and emits no resolved item', () => {
    const xml = buildRssFeed([svc], { scope: 'all' }, new Date(NOW))
    expect(xml).toContain('aiwatch:grok:grok-0903</guid>')
    expect(xml).not.toContain(':resolved</guid>')
  })

  it('an announced incident gets no Resolved alert', () => {
    const alerts = buildIncidentAlerts([svc as unknown as ScoredService], new Map([['grok-0903', new Set(['grok'])]]), NOW)
    expect(alerts.map((a) => a.key)).not.toContain('alerted:res:grok-0903')
  })
})
