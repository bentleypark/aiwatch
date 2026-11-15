import { describe, it, expect } from 'vitest'
import { groupAnalyses, baselineCards } from '../analysisGroups'
import { readsResolved } from '../liveIncident'

const at = (min) => new Date(Date.UTC(2026, 10, 13, 9, 0) + min * 60_000).toISOString()
const inc = (id, status, extra = {}) => ({ id, title: id, status, impact: 'major', startedAt: at(0), resolvedAt: status === 'resolved' ? at(120) : null, duration: null, timeline: [], ...extra })
const analysis = (incidentId, resolved) => ({ incidentId, summary: incidentId, estimatedRecovery: '2h–2.5h', analyzedAt: at(5), ...(resolved ? { resolvedAt: at(120) } : {}) })

// #1997 — production 2026-11-13: a resolved incident on claude.ai and Claude Code, while claude.ai is
// down on a different live incident. The worker sends claude.ai's live analysis only.
const shared = inc('nn11wk485zfn', 'resolved')
const m365 = inc('sqn3fg1l96dl', 'identified', { startedAt: at(-966), resolvedAt: null })
const services = [
  { id: 'claude', name: 'Claude API', status: 'operational', incidents: [] },
  { id: 'claudeai', name: 'claude.ai', status: 'down', incidents: [m365, shared] },
  { id: 'claudecode', name: 'Claude Code', status: 'operational', incidents: [shared] },
]
const aiAnalysis = {
  claudeai: [analysis('sqn3fg1l96dl', false)],
  claudecode: [analysis('nn11wk485zfn', true)],
}

const cardOf = (groups, incId) => groups.find((g) => g.incIds.has(incId))
const svcsOf = (g) => g.svcIds.map((id) => services.find((s) => s.id === id))

describe('#1997 groupAnalyses — a shared incident names every service that carries it', () => {
  it('the resolved shared card names claude.ai, which has no analysis of it on the wire', () => {
    expect(cardOf(groupAnalyses(aiAnalysis, services), 'nn11wk485zfn').svcIds.sort()).toEqual(['claudeai', 'claudecode'])
  })

  it('so the card does not read Resolved over claude.ai, which is still down on its other incident', () => {
    expect(readsResolved(svcsOf(cardOf(groupAnalyses(aiAnalysis, services), 'nn11wk485zfn')))).toBe(false)
  })

  it("claude.ai's own live incident keeps its own card", () => {
    const groups = groupAnalyses(aiAnalysis, services)
    expect(cardOf(groups, 'sqn3fg1l96dl').svcIds).toEqual(['claudeai'])
    expect(groups).toHaveLength(2)
  })

  it("a service's past recovery times go on a card with its own analysis, not on a card it only carries", () => {
    const groups = groupAnalyses(aiAnalysis, services)
    const card = baselineCards(groups)
    expect(groups[card.get('claudeai')].incIds.has('sqn3fg1l96dl')).toBe(true)
    expect(groups[card.get('claudecode')].incIds.has('nn11wk485zfn')).toBe(true)
  })

  it('two shared incidents carried by the same services are one card, not two with the same key', () => {
    const x = inc('X', 'resolved'), y = inc('Y', 'resolved', { startedAt: at(30) })
    const svcs = [
      { id: 'claudeai', name: 'claude.ai', status: 'down', incidents: [m365, x, y] },
      { id: 'claudecode', name: 'Claude Code', status: 'operational', incidents: [x, y] },
    ]
    const groups = groupAnalyses({ claudeai: [analysis('sqn3fg1l96dl', false)], claudecode: [analysis('X', true), analysis('Y', true)] }, svcs)
    expect(groups.map((g) => [[...g.svcIds].sort().join(','), [...g.incIds].sort()])).toEqual([['claudeai,claudecode', ['X', 'Y']], ['claudeai', ['sqn3fg1l96dl']]])
  })

  it('two shared incidents owned by different services are one card, and each keeps its past recovery times', () => {
    const x = inc('X', 'identified'), y = inc('Y', 'identified', { startedAt: at(30) })
    const svcs = [
      { id: 'claudeai', name: 'claude.ai', status: 'degraded', incidents: [x, y] },
      { id: 'claudecode', name: 'Claude Code', status: 'degraded', incidents: [x, y] },
    ]
    const groups = groupAnalyses({ claudeai: [analysis('X', false)], claudecode: [analysis('Y', false)] }, svcs)
    expect(groups).toHaveLength(1)
    expect([...baselineCards(groups)]).toEqual([['claudeai', 0], ['claudecode', 0]])
  })

  it('an incident only one service carries stays a single-service card', () => {
    const solo = [{ id: 'together', name: 'Together AI', status: 'degraded', incidents: [inc('a', 'identified'), inc('b', 'identified')] }]
    const groups = groupAnalyses({ together: [analysis('a', false), analysis('b', false)] }, solo)
    expect(groups.map((g) => [g.svcIds, [...g.incIds]])).toEqual([[['together'], ['a', 'b']]])
  })
})
