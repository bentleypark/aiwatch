// #1973 — pin the Speechmatics config against status.speechmatics.com components.json as served 2026-11-12.

import { describe, it, expect } from 'vitest'
import { SERVICES, atlassianRosterAuditServices, uptimeScopeOf, resolveSvcStatus, resolveSvcComponents, filterIncidents } from '../services'
import { rosterAgedInFindings } from '../roster-audit'
import { atlassianRosterEntries } from '../parsers/statuspage'
import type { Incident } from '../types'

const speechmatics = SERVICES.find((s) => s.id === 'speechmatics')!

// [id, name, created_at, group_id, group header?]
const PAGE: Array<[string, string, string, string | null, boolean]> = [
  ['0xl0llrch7gp', 'Batch SaaS - EU1', '2021-05-07T00:00:00Z', '97t96hn8yhhh', false],
  ['0htcxsthlztx', 'Batch SaaS - US1', '2021-05-07T00:00:00Z', 'qt6472p3hlz3', false],
  ['xm7gcqj0ydlp', 'Batch SaaS - AU', '2023-01-26T00:00:00Z', 'yj6jx8y7xlkk', false],
  ['97t96hn8yhhh', 'Batch SaaS - EU', '2023-06-05T00:00:00Z', null, true],
  ['522jbljg5r9x', 'Batch SaaS - EU2', '2023-06-05T00:00:00Z', '97t96hn8yhhh', false],
  ['qt6472p3hlz3', 'Batch SaaS - US', '2023-06-05T00:00:00Z', null, true],
  ['w9x6rlqxp72k', 'Batch SaaS - US2', '2023-06-05T00:00:00Z', 'qt6472p3hlz3', false],
  ['yj6jx8y7xlkk', 'Batch SaaS - AU', '2023-06-05T00:00:00Z', null, true],
  ['hdcysbmzk9ys', 'Docs (docs.speechmatics.com)', '2022-06-27T00:00:00Z', null, false],
  ['tp2rwd3tfqh5', 'Portal (portal.speechmatics.com)', '2022-06-27T00:00:00Z', null, false],
  ['czxs20tbdw2h', 'Docker and Helm Registry (speechmaticspublic.azurecr.io)', '2022-10-27T00:00:00Z', null, false],
  ['bn0xvr6wk6ry', 'Appliance Licensing Service', '2022-10-27T00:00:00Z', null, false],
  ['60dg26p5lbgx', 'Realtime SaaS - US', '2022-12-31T00:00:00Z', null, false],
  ['nw5l21ppzds8', 'Realtime SaaS - EU', '2023-01-24T00:00:00Z', null, false],
  ['gwpxr8wqn4ks', 'Management Platform (mp.speechmatics.com)', '2025-09-26T00:00:00Z', null, false],
  ['pcqv82k77r5v', 'Usage Reporting (usage.speechmatics.com)', '2025-10-29T00:00:00Z', null, false],
]
const COUNTED = ['0xl0llrch7gp', '522jbljg5r9x', '0htcxsthlztx', 'w9x6rlqxp72k', 'xm7gcqj0ydlp', '60dg26p5lbgx', 'nw5l21ppzds8', 'gwpxr8wqn4ks']
const REFERENCE = ['tp2rwd3tfqh5']

const nameOf = (id: string) => PAGE.find(([pid]) => pid === id)![1]
const summary = (down: string[]) => ({
  status: { indicator: down.length ? 'minor' : 'none' },
  components: PAGE.map(([id, name, , groupId, group], position) => ({ id, name, group, position, group_id: groupId, status: down.includes(id) ? 'degraded_performance' : 'operational' })),
})
const incident = (componentIds: string[]): Incident => ({
  id: 'i1', title: 'Degraded performance', status: 'investigating', impact: 'minor', startedAt: '2026-11-12T00:00:00Z', duration: null,
  componentIds, componentNames: componentIds.map(nameOf),
} as unknown as Incident)

describe('speechmatics config (#1973)', () => {
  it('every page component is counted, reference, or roster-excluded, and exactly one of them', () => {
    const counted = new Set(speechmatics.statusComponentIds)
    const reference = new Set(speechmatics.referenceComponentIds)
    const excluded = new Set(speechmatics.rosterAuditExclude)
    expect([...counted].sort()).toEqual([...COUNTED].sort())
    expect([...reference].sort()).toEqual([...REFERENCE].sort())
    for (const [id, , , , group] of PAGE) {
      expect(counted.has(id) || excluded.has(id), id).toBe(true)
      expect(counted.has(id) && excluded.has(id), id).toBe(false)
      if (group) expect(excluded.has(id), id).toBe(true)
    }
  })

  it('the live page yields no aged-in roster finding under the real config', () => {
    const config = atlassianRosterAuditServices().find((s) => s.id === 'speechmatics')!
    const comps = PAGE.map(([id, , created_at, group_id]) => ({ id, created_at, group_id }))
    expect(rosterAgedInFindings(atlassianRosterEntries(comps), uptimeScopeOf(config), config.rosterAuditExclude ?? [], false, Date.parse('2026-12-12T00:00:00Z'))).toEqual([])
  })

  it('one degraded batch or realtime region, or the temporary-key API, degrades the badge', () => {
    for (const id of ['w9x6rlqxp72k', 'xm7gcqj0ydlp', 'nw5l21ppzds8', 'gwpxr8wqn4ks']) {
      expect(resolveSvcStatus(speechmatics, summary([id]), filterIncidents([incident([id])], speechmatics)), nameOf(id)).toBe('degraded')
    }
  })

  it('a docs, portal or on-prem component leaves the badge operational', () => {
    for (const id of ['hdcysbmzk9ys', 'tp2rwd3tfqh5', 'czxs20tbdw2h', 'bn0xvr6wk6ry', 'pcqv82k77r5v']) {
      expect(resolveSvcStatus(speechmatics, summary([id]), []), nameOf(id)).toBe('operational')
    }
  })

  it('the breakdown lists the 8 counted components and nothing else', () => {
    expect(resolveSvcComponents(speechmatics, summary([])).map((c) => c.id).sort()).toEqual([...COUNTED].sort())
  })
})
