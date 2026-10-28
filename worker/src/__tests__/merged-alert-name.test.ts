import { describe, it, expect } from 'vitest'
import { buildIncidentAlerts, buildWithdrawalAlerts, mergedAlertName } from '../alerts'
import { buildFeedWithMeta } from '../rss'
import type { ServiceStatus } from '../services'
import type { ScoredService } from '../alerts'
import type { Incident } from '../types'

describe('#1837 mergedAlertName', () => {
  it.each([
    [['Cursor'], ['Anysphere'], 'Cursor'],
    [['claude.ai', 'Claude Code'], ['Anthropic', 'Anthropic'], 'Anthropic (claude.ai, Claude Code)'],
    [['Grok Bot', 'Cursor'], ['SpaceXSI', 'Anysphere'], 'Grok Bot, Cursor'],
  ])('%j from %j → %s', (names, providers, expected) => {
    expect(mergedAlertName(names, providers)).toBe(expected)
  })
})

// Live shape: gh45ycs0zs0g (2026-10-09) was tagged Cloud Agents + Grok Bot on Cursor's status page.
const NOW = Date.parse('2026-10-09T12:00:00Z')
const shared = {
  id: 'gh45ycs0zs0g', title: 'Investigating service degradation — Cloud Agents and Grok Bot', status: 'investigating',
  startedAt: new Date(NOW - 20 * 60_000).toISOString(), impact: 'minor', duration: null, timeline: [],
  componentNames: ['Cloud Agents', 'Grok Bot'],
} as unknown as Incident
const svc = (id: string, name: string, provider: string, category: ScoredService['category']) => ({
  id, name, provider, category, status: 'degraded', incidents: [shared], uptime30d: null, latency: null, aiwatchScore: null, scoreGrade: null,
}) as unknown as ScoredService

describe('#1837 one incident on the Grok Bot and Cursor cards', () => {
  it('the new and resolved alerts name both cards without one provider', () => {
    const services = [svc('grokbot', 'Grok Bot', 'SpaceXSI', 'app'), svc('cursor', 'Cursor', 'Anysphere', 'agent')]
    const [opened] = buildIncidentAlerts(services, new Map(), NOW)
    expect(opened.title).toContain('Grok Bot, Cursor — ')
    expect(opened.title).not.toContain('SpaceXSI')

    const resolved = services.map((s) => ({ ...s, status: 'operational', incidents: [{ ...shared, status: 'resolved', duration: '1h' }] })) as unknown as ScoredService[]
    const [closed] = buildIncidentAlerts(resolved, new Map([['gh45ycs0zs0g', new Set(['grokbot', 'cursor'])]]), NOW)
    expect(closed.title).toContain('Grok Bot, Cursor — ')
    expect(closed.title).not.toContain('SpaceXSI')
  })
})

describe('#1837 a shared Grok Bot + Cursor incident', () => {
  it('a withdrawal notice names both cards without one provider', () => {
    const services = [svc('grokbot', 'Grok Bot', 'SpaceXSI', 'app'), svc('cursor', 'Cursor', 'Anysphere', 'agent')]
      .map((s) => ({ ...s, status: 'operational', incidents: [] })) as unknown as ScoredService[]
    const tomb = (svcId: string) => ({ svcId, incId: 'gh45ycs0zs0g', title: shared.title, startedAt: shared.startedAt, prunedAt: new Date(NOW).toISOString() })
    const [a] = buildWithdrawalAlerts([tomb('grokbot'), tomb('cursor')], new Set(['gh45ycs0zs0g']), services, () => {})
    expect(a.title).toBe('⚪ Grok Bot, Cursor — Incident Withdrawn')
  })
})

it('#1837 the /feed item for a shared Grok Bot + Cursor incident is titled like the Discord alert', () => {
  const services = [svc('grokbot', 'Grok Bot', 'SpaceXSI', 'app'), svc('cursor', 'Cursor', 'Anysphere', 'agent')] as unknown as ServiceStatus[]
  const { xml } = buildFeedWithMeta(services, { scope: 'all' }, new Date(NOW))
  expect(xml).toContain('Grok Bot, Cursor — ')
  expect(xml).not.toContain('SpaceXSI (')
})
