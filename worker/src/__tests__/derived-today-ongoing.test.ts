// #1623 — today's `status_history` row is the service's unresolved incident while its resource is down.
// It must reach the live list under the id it closes with, and it must never alert, feed /feed, be
// analyzed, be quoted as the provider's text, or lend an elapsed time read off its estimated start.
import { describe, it, expect } from 'vitest'
import { parseBetterStackDowntimeIncidents, zonedDayStartMs, type BetterStackIndex } from '../parsers/betterstack'
import { accumulateMonthlyIncidents } from '../monthly-archive'
import { buildIncidentAlerts, canIncidentStillAlert } from '../alerts'
import { buildFeedWithMeta } from '../rss'
import { causalIncidents } from '../incident-text'
import { buildDailySummary } from '../daily-summary'
import { renderStatuslineBrief, type BriefService } from '../statusline'
import type { Incident, ServiceStatus } from '../types'

const H = 3600
const NOW = Date.parse('2026-08-28T13:00:00Z') // UTC page: 13h of 2026-08-28 elapsed

function page(status: string, days: Array<[string, number]>): BetterStackIndex {
  return {
    data: { attributes: { aggregate_state: 'operational', timezone: 'UTC' } },
    included: [{
      type: 'status_page_resource', id: 'r',
      attributes: {
        public_name: 'api.hconeai.com', status,
        status_history: days.map(([day, sec]) => ({
          day, status: sec > 0 ? 'downtime' : 'operational', downtime_duration: sec, maintenance_duration: 0,
        })),
      },
    }],
  }
}

const todayRow = (status: string, todaySec: number, now = NOW) =>
  parseBetterStackDowntimeIncidents(page(status, [['2026-08-27', 24 * H], ['2026-08-28', todaySec]]), { now })
    .find((i) => i.derivedDay === '2026-08-28')

describe('#1623 — the parser emits today', () => {
  it('as the unresolved incident while the resource is in downtime', () => {
    const inc = todayRow('downtime', 13 * H)!
    expect(inc).toMatchObject({
      id: 'bs-hist:r:2026-08-28', title: 'api.hconeai.com — down', status: 'investigating',
      duration: null, resolvedAt: null, derived: 'status_history', derivedDay: '2026-08-28',
    })
  })

  it('estimates the start from the accrued seconds, never before local midnight', () => {
    expect(todayRow('downtime', 2 * H)!.startedAt).toBe(new Date(NOW - 2 * H * 1000).toISOString())
    expect(todayRow('downtime', 20 * H)!.startedAt).toBe(new Date(zonedDayStartMs('2026-08-28', 'UTC')).toISOString())
  })

  it('as the day total so far, resolved, once the resource has recovered — same id', () => {
    const inc = todayRow('operational', 2 * H)!
    expect(inc).toMatchObject({ id: 'bs-hist:r:2026-08-28', title: 'api.hconeai.com — down', status: 'resolved', duration: '2h 0m' })
    expect(inc.startedAt).toBe('2026-08-28T12:00:00.000Z') // the closed rows' noon anchor
  })

  it('is not mistaken by the #1295 guard for a day a feed row already banked yesterday', () => {
    const feedYesterday = {
      id: 'feed-1', title: 'api.hconeai.com — down', status: 'resolved', impact: 'minor', componentNames: [], timeline: [],
      startedAt: '2026-08-27T15:00:00.000Z', resolvedAt: '2026-08-27T16:00:00.000Z', duration: '1h 0m',
    } as Incident
    const skipped: string[] = []
    const svcOf = (incidents: Incident[]) => ({ id: 'helicone', name: 'Helicone', incidents } as unknown as ServiceStatus)
    const data = accumulateMonthlyIncidents(null, [svcOf([feedYesterday])], '2026-08', [])
    accumulateMonthlyIncidents(data, [svcOf([feedYesterday, todayRow('operational', 2 * H)!])], '2026-08', [], (_s, inc) => skipped.push(inc.id))
    expect(skipped).toEqual([])
  })

  it('not at all below the downtime floor', () => {
    expect(todayRow('downtime', 300)).toBeUndefined()
  })

  it('under the id tomorrow\'s closed row carries', () => {
    const tomorrow = Date.parse('2026-08-29T01:00:00Z')
    const closed = parseBetterStackDowntimeIncidents(page('downtime', [['2026-08-28', 24 * H], ['2026-08-29', H]]), { now: tomorrow })
    expect(closed.find((i) => i.derivedDay === '2026-08-28')).toMatchObject({ id: todayRow('downtime', 13 * H)!.id, status: 'resolved' })
  })
})

describe('#1623 — incidents:monthly banks a synthesized row only once its day has closed', () => {
  const svc = (incidents: Incident[]) => ({ id: 'helicone', name: 'Helicone', incidents } as unknown as ServiceStatus)

  it('leaves the live today-row out', () => {
    const data = accumulateMonthlyIncidents(null, [svc([todayRow('downtime', 13 * H)!])], '2026-08', [])
    expect(data.services.helicone).toBeUndefined()
  })

  it('banks it under its id once the day closes, with no stale row from the live phase', () => {
    let data = accumulateMonthlyIncidents(null, [svc([todayRow('downtime', 13 * H)!])], '2026-08', [])
    const closed = parseBetterStackDowntimeIncidents(page('downtime', [['2026-08-28', 24 * H], ['2026-08-29', H]]), { now: Date.parse('2026-08-29T01:00:00Z') })
    data = accumulateMonthlyIncidents(data, [svc(closed)], '2026-08', [])
    const rows = (data.services.helicone.incidents ?? []).filter((e) => e.id === 'bs-hist:r:2026-08-28')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ finalStatus: 'resolved', durationMin: 1440, title: 'api.hconeai.com — down' })
  })

  it('does not bank a same-day recovery before the day closes', () => {
    const data = accumulateMonthlyIncidents(null, [svc([todayRow('operational', 2 * H)!])], '2026-08', [])
    expect(data.services.helicone).toBeUndefined()
  })
})

describe('#1623 — the today-row stays off every push and every quoted claim', () => {
  const ongoing = todayRow('downtime', 13 * H)!
  const scored = { id: 'helicone', name: 'Helicone', provider: 'Helicone', category: 'api', status: 'degraded', incidents: [ongoing] }

  it('raises no alert, new or resolved', () => {
    expect(canIncidentStillAlert(ongoing, NOW)).toBe(false)
    expect(buildIncidentAlerts([scored as never], new Map(), NOW)).toEqual([])
    const closedAfterAlert = { ...ongoing, status: 'resolved' as const, resolvedAt: new Date(NOW).toISOString(), duration: '13h 0m' }
    expect(buildIncidentAlerts([{ ...scored, incidents: [closedAfterAlert] } as never], new Map([[ongoing.id, new Set(['helicone'])]]), NOW)).toEqual([])
  })

  it('CONTROL — a provider incident of the same shape does alert', () => {
    const published = { ...ongoing, id: 'p1', derived: undefined, derivedDay: undefined }
    expect(buildIncidentAlerts([{ ...scored, incidents: [published] } as never], new Map(), NOW)).toHaveLength(1)
  })

  it('emits no /feed item', () => {
    const { xml } = buildFeedWithMeta([scored as unknown as ServiceStatus], { scope: 'all' }, new Date(NOW))
    expect(xml).not.toContain('<item>')
  })

  it('is not a cause for upstream attribution', () => {
    expect(causalIncidents({ incidents: [ongoing] })).toEqual([])
  })

  it('lends no elapsed time to the daily summary', () => {
    const out = buildDailySummary({
      services: [scored as unknown as ServiceStatus], aiUsage: null,
      incidentCountToday: { newCount: 0, resolvedCount: 0 }, redditCount: 0,
    })
    expect(out).toContain('Helicone (degraded)')
    expect(out).not.toContain('investigating')
  })

  it('is not quoted on the statusline brief', () => {
    const out = renderStatuslineBrief([{ ...scored, aiwatchScore: 58, scoreGrade: 'fair' } as unknown as BriefService])
    expect(out).toContain('Helicone')
    expect(out).not.toContain('api.hconeai.com — down')
  })
})
