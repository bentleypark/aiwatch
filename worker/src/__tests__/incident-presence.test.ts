import { describe, expect, it } from 'vitest'
import { buildIncidentAlerts, type ScoredService } from '../alerts'
import { servicesMissing } from '../alerted-gone'
import { accumulateMonthlyIncidents, prunePhantomIncidents, type MonthlyIncidents } from '../monthly-archive'
import { liveIncidentIds } from '../withdrawn'
import type { Incident, ServiceStatus } from '../types'

// #1698 — an incident moved from `incidents` to `referenceIncidents` is still on the provider's page.
// Every consumer that asks "is it on the page?" must answer yes.

const inc = (o: Partial<Incident> & Pick<Incident, 'id' | 'status' | 'startedAt'>): Incident =>
  ({ title: o.id, impact: 'minor', duration: null, timeline: [], ...o }) as Incident

const API = inc({ id: 'api0', status: 'resolved', startedAt: '2026-10-01T00:00:00Z', resolvedAt: '2026-10-01T01:00:00Z', duration: '1h 0m' })
const WEB_OPEN = inc({ id: 'web1', status: 'investigating', startedAt: '2026-10-10T00:00:00Z' })
const WEB_RESOLVED = { ...WEB_OPEN, status: 'resolved', resolvedAt: '2026-10-10T02:00:00Z', duration: '2h 0m' } as Incident

const svc = (reference: Incident[]) =>
  ({ id: 'openrouter', name: 'OpenRouter', provider: 'OpenRouter', category: 'api', status: 'operational', incidents: [API], referenceIncidents: reference }) as unknown as ServiceStatus

const banked = (): MonthlyIncidents => ({
  lastUpdated: '',
  services: {
    openrouter: {
      count: 1, totalMinutes: 0, longestMinutes: 0, dates: ['2026-10-10'], incidentIds: ['web1'], durations: { web1: 0 },
      incidents: [{ id: 'web1', title: 'web1', startedAt: WEB_OPEN.startedAt, resolvedAt: null, durationMin: 0, finalStatus: 'investigating', impact: 'minor' }],
    },
  },
}) as unknown as MonthlyIncidents

describe('#1698 a reference incident is present on the page', () => {
  it('the #975 phantom prune keeps its unresolved row', () => {
    let data = banked()
    for (let n = 0; n < 4; n++) data = prunePhantomIncidents(data, [svc([WEB_OPEN])], [])
    expect(data.services.openrouter.incidentIds).toEqual(['web1'])
  })

  it('the accumulator refreshes its banked row when it resolves', () => {
    const data = accumulateMonthlyIncidents(banked(), [svc([WEB_RESOLVED])], '2026-10', [])
    const row = data.services.openrouter.incidents!.find((e) => e.id === 'web1')
    expect(row?.finalStatus).toBe('resolved')
    expect(row?.durationMin).toBe(120)
  })

  it('the accumulator does not bank a reference incident it has not recorded', () => {
    const data = accumulateMonthlyIncidents(null, [svc([WEB_OPEN])], '2026-10', [])
    expect(data.services.openrouter.incidentIds).toEqual(['api0'])
  })

  it('the withdrawal path sees its id as live', () => {
    expect(liveIncidentIds([svc([WEB_OPEN])]).has('web1')).toBe(true)
  })

  it('the announced-incident watch does not report it missing', () => {
    expect(servicesMissing('web1', ['openrouter'], new Map([['openrouter', svc([WEB_OPEN])]]))).toEqual([])
  })

  it('an alerted one gets its Resolved alert; an unalerted one gets no New alert', () => {
    const alerted = buildIncidentAlerts([svc([WEB_RESOLVED]) as unknown as ScoredService], new Map([['web1', new Set(['openrouter'])]]), Date.parse('2026-10-10T03:00:00Z'))
    expect(alerted.map((a) => a.key)).toContain('alerted:res:web1')
    const fresh = buildIncidentAlerts([svc([{ ...WEB_OPEN, startedAt: '2026-10-10T02:30:00Z' }]) as unknown as ScoredService], new Map(), Date.parse('2026-10-10T03:00:00Z'))
    expect(fresh.map((a) => a.key)).not.toContain('alerted:new:web1')
  })

  it('the Resolved alert names only the services that were announced', () => {
    const claudeai = { ...svc([]), id: 'claudeai', name: 'claude.ai', incidents: [WEB_RESOLVED], referenceIncidents: undefined }
    const alerts = buildIncidentAlerts(
      [svc([WEB_RESOLVED]), claudeai] as unknown as ScoredService[],
      new Map([['web1', new Set(['claudeai'])]]),
      Date.parse('2026-10-10T03:00:00Z'),
    )
    const resolved = alerts.find((a) => a.key === 'alerted:res:web1')
    expect(resolved?.svcIds).toEqual(['claudeai'])
  })
})
