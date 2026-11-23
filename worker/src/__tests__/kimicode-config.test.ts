// #1690 — pin the Kimi Code config against status.moonshot.cn as served 2026-11-20 (summary.json components
// and the incidents tagged on the "Kimi Code" group).

import { describe, it, expect } from 'vitest'
import { SERVICES, resolveSvcStatus, filterIncidents, applyTitleMap, atlassianRosterAuditServices, uptimeScopeOf, tagAutoMonitorIncidents } from '../services'
import { shouldHoldNewIncident } from '../alerts'
import { computeUptimeData } from '../parsers/statuspage'
import type { Incident } from '../types'

const kimicode = SERVICES.find((s) => s.id === 'kimicode')!
const kimi = SERVICES.find((s) => s.id === 'kimi')!
const kimiapp = SERVICES.find((s) => s.id === 'kimiapp')!

const GROUP = 'cyrtlddz0q8c'
// In the order the provider's page lists them (components.json `position`), which is the order the card's breakdown shows.
const MEMBERS: Array<[string, string]> = [
  ['t1ffjsrj7j9d', 'K3.1 Pro'], ['qhrvl9ccfvp6', 'K3.1 Pro Highspeed'], ['1l34rxbvx0gt', 'K3'],
  ['bs3h7057mc6g', 'K2.8 Preview'], ['qrqn4ss6d252', 'K2.7 Code Highspeed'], ['dyw7p8553q3z', 'Remote Control'],
]
// A page component outside the group: the Kimi API card's own component.
const OPEN_API: [string, string] = ['8psr5dfdld0s', 'Open API']

// An Atlassian group header carries the worst status of its members.
const summary = (degraded: string[]) => {
  const worst = degraded.some((id) => id === GROUP || MEMBERS.some(([m]) => m === id)) ? 'degraded_performance' : 'operational'
  return {
    status: { indicator: degraded.length ? 'minor' : 'none' },
    components: [
      { id: GROUP, name: 'Kimi Code', group: true, group_id: null, status: worst },
      ...MEMBERS.map(([id, name]) => ({ id, name, group: false, group_id: GROUP, status: degraded.includes(id) ? 'degraded_performance' : 'operational' })),
      { id: OPEN_API[0], name: OPEN_API[1], group: false, group_id: null, status: degraded.includes(OPEN_API[0]) ? 'degraded_performance' : 'operational' },
    ],
  }
}

const incident = (title: string, componentNames: string[]): Incident => ({
  id: 'i1', title, status: 'investigating', impact: 'critical', startedAt: '2026-11-17T09:38:00Z', duration: null,
  componentIds: [], componentNames,
} as unknown as Incident)

// The distinct titles the group has published, as served (the last four were active on 2026-11-20).
const TITLES = [
  'Kimi Code K3 TTFT 响应延迟升高',
  'Kimi Code K3 OTPS 响应生成速度严重下降',
  'Kimi Code K3 OTPS 响应生成速度下降',
  'Kimi Code K2.8 Preview TTFT 响应延迟升高',
  'Kimi Code K3 模型服务出现错误',
  'Kimi Code K2.7 Code Highspeed TTFT 响应延迟严重升高',
  'Kimi Code K3 模型服务持续波动',
  'Kimi Code K3 请求处理严重异常',
  'Kimi Code K3.1 Pro 请求处理严重异常',
  'Kimi Code K3.1 Pro Highspeed 请求处理严重异常',
  'Kimi Code K2.8 Preview 请求处理严重异常',
]

describe('kimicode config (#1690)', () => {
  it('is a coding agent on the shared Moonshot page, tracking the six group members in the page order, not the group aggregate', () => {
    expect(kimicode.category).toBe('agent')
    expect(kimicode.statusUrl).toBe(kimi.statusUrl)
    expect(kimicode.statusComponentIds).toEqual(MEMBERS.map(([id]) => id))
    expect(kimicode.statusComponentId).toBe(MEMBERS[0][0])
    expect(uptimeScopeOf(kimicode)).toEqual(MEMBERS.map(([id]) => id))
    expect(uptimeScopeOf(kimicode)).not.toContain(GROUP)
  })

  it('is roster-audited, with the page shared with kimiapp (one audit for the page, see atlassian-roster-audit-services)', () => {
    expect(atlassianRosterAuditServices().map((s) => s.id)).toContain('kimicode')
  })

  // The group's own timeline averages its members, so one member's outage reads as a sixth of it. Worst-of the members keeps it.
  it('uptime is worst-of the members: three days of one member down cost the card three days, not half a day', () => {
    const NOW = Date.parse('2026-11-20T12:00:00Z')
    const dates = Array.from({ length: 30 }, (_, i) => new Date(NOW - (29 - i) * 86_400_000).toISOString().slice(0, 10))
    const downDays = new Set(dates.slice(10, 13))
    const days = (down: boolean) => dates.map((date) => (down && downDays.has(date) ? { date, outages: { m: 86_400 } } : { date, outages: {} }))
    const timelines: Record<string, { days: Array<{ date: string; outages: { m?: number } }> }> = {}
    const K3 = '1l34rxbvx0gt'
    for (const [id] of MEMBERS) timelines[id] = { days: days(id === K3) }
    // The group's own timeline, as Atlassian publishes it: the members' outage averaged (1/6 of each day).
    timelines[GROUP] = { days: dates.map((date) => (downDays.has(date) ? { date, outages: { m: 86_400 / 6 } } : { date, outages: {} })) }
    const worstOf = computeUptimeData(timelines, uptimeScopeOf(kimicode), 30, NOW).uptimePercent!
    const groupOnly = computeUptimeData(timelines, GROUP, 30, NOW).uptimePercent!
    expect(worstOf).toBeCloseTo(90, 0)
    expect(groupOnly).toBeGreaterThan(98)
  })

  it('any member degraded degrades the badge, whichever member it is', () => {
    for (const [id, name] of MEMBERS) {
      expect(resolveSvcStatus(kimicode, summary([id]), []), name).toBe('degraded')
    }
  })

  it('a degraded component outside the group leaves the badge operational', () => {
    expect(resolveSvcStatus(kimicode, summary([OPEN_API[0]]), [])).toBe('operational')
  })

  it('scopes incidents by the title prefix: Kimi Code titles stay, the page\'s other incidents do not', () => {
    const kept = filterIncidents(TITLES.map((t) => incident(t, ['K3'])), kimicode)
    expect(kept).toHaveLength(TITLES.length)
    for (const other of ['开放平台 API 服务异常', 'API 服务可用性低', '短信登录异常']) {
      expect(filterIncidents([incident(other, ['Open API'])], kimicode), other).toEqual([])
    }
  })

  it('keeps a Kimi Code incident whatever its component is named, since members are renamed and added', () => {
    expect(filterIncidents([incident('Kimi Code K3 TTFT 响应延迟升高', ['Coding Model'])], kimicode)).toHaveLength(1)
    expect(filterIncidents([incident('Kimi Code K9 TTFT 响应延迟升高', ['K9'])], kimicode)).toHaveLength(1)
  })

  it('translates each of the eleven published titles to English', () => {
    const translated = applyTitleMap(TITLES.map((t) => incident(t, ['K3'])), kimicode)
    for (const inc of translated) expect(inc.title, inc.title).not.toMatch(/[㐀-鿿]/)
    expect(new Set(translated.map((i) => i.title)).size).toBe(TITLES.length)
  })

  it('does not leak into the Kimi API or Kimi App cards, which scope by exact component name', () => {
    const inc = [incident('Kimi Code K3 TTFT 响应延迟升高', ['K3'])]
    expect(filterIncidents(inc, kimi)).toEqual([])
    expect(filterIncidents(inc, kimiapp)).toEqual([])
  })
})

// A formulaic alarm opens a fresh `critical` incident per blip, so the same title repeats inside a day. The worker tag is what
// lets the dashboard fold the repeats into one row; `critical` incidents never alert as a flap, so the tag changes the grouping only.
describe('kimicode autoMonitor tagging (#1690)', () => {
  const tag = (title: string) => tagAutoMonitorIncidents([incident(title, ['K3'])], kimicode)[0].autoMonitor === true

  it('tags every published title, and each tagged title is also translated', () => {
    for (const title of TITLES) {
      expect(tag(title), title).toBe(true)
      const [out] = applyTitleMap(tagAutoMonitorIncidents([incident(title, ['K3'])], kimicode), kimicode)
      expect(out.title, title).not.toMatch(/[㐀-鿿]/)
    }
  })

  it('tags the same alarm for a model the page adds later', () => {
    expect(tag('Kimi Code K9 Max TTFT 响应延迟升高')).toBe(true)
    expect(tag('Kimi Code K9 Max 请求处理严重异常')).toBe(true)
  })

  it('tags the pasted pair, so two same-day K3 latency alarms carry the same group key', () => {
    const pair = tagAutoMonitorIncidents([
      incident('Kimi Code K3 TTFT 响应延迟升高', ['K3']),
      incident('Kimi Code K3 TTFT 响应延迟升高', ['K3']),
    ], kimicode)
    expect(pair.map((i) => i.autoMonitor)).toEqual([true, true])
    expect(new Set(applyTitleMap(pair, kimicode).map((i) => i.title)).size).toBe(1)
  })

  it('leaves a human-written or partial title untagged', () => {
    for (const title of ['Kimi Code 登录异常', 'Kimi Code pricing change', 'Kimi Code K3 TTFT', 'K3 TTFT 响应延迟升高', 'API 服务可用性低']) {
      expect(tag(title), title).toBe(false)
    }
  })

  it('does not hold a critical alarm: the tag groups the rows without delaying the alert', () => {
    const [tagged] = tagAutoMonitorIncidents([incident('Kimi Code K3 请求处理严重异常', ['K3'])], kimicode)
    expect(tagged.autoMonitor).toBe(true)
    expect(kimicode.autoMonitorCriticalHoldable).toBeUndefined()
    const state = { alreadyAlerted: false, firstSeenMs: null, nowMs: Date.parse('2026-11-20T13:00:00Z') }
    expect(shouldHoldNewIncident('kimicode', kimicode, tagged, state)).toBe(false)
  })
})

