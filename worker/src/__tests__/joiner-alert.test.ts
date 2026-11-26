import { describe, it, expect } from 'vitest'
import { buildIncidentAlerts } from '../alerts'
import type { ScoredService } from '../alerts'
import { analysisKey, copyPriorServiceAnalysis, type AIAnalysisResult } from '../ai-analysis'
import type { KVLike } from '../utils'
import type { Incident } from '../types'

// #2072 — 2026-11-25, incident 01M898HVZGXFV2XC4775CG9GF8: ChatGPT alerted at 11:50, Codex joined at
// 12:15 and its alert read as a new Codex outage with an analysis re-written around Codex.
const NOW = 1764072000000
const INC = '01M898HVZGXFV2XC4775CG9GF8'
const shared = {
  id: INC,
  title: 'ChatGPT is experiencing elevated conversation errors affecting Education, Team, Business, Pro, and Plus plans',
  status: 'identified',
  startedAt: new Date(NOW - 27 * 60_000).toISOString(),
  impact: 'minor',
  duration: null,
  timeline: [],
} as unknown as Incident

function svc(id: string, name: string, category: ScoredService['category']): ScoredService {
  return {
    id, name, provider: 'OpenAI', category, status: 'degraded',
    incidents: [shared], uptime30d: 99.5, latency: null, aiwatchScore: 80, scoreGrade: 'good',
  } as unknown as ScoredService
}

const chatgpt = svc('chatgpt', 'ChatGPT', 'app')
const codex = svc('codex', 'Codex', 'agent')

function roster(entries: Record<string, string[]>): Map<string, Set<string>> {
  return new Map(Object.entries(entries).map(([k, v]) => [k, new Set(v)]))
}

describe('#2072 — a joiner alert names the incident it joined', () => {
  it('joiner: "Now Affected" title and a line naming the prior service', () => {
    const [join] = buildIncidentAlerts([chatgpt, codex], roster({ [INC]: ['chatgpt'] }), NOW)
    expect(join.svcIds).toEqual(['codex'])
    expect(join.title).toBe('🟡 Codex — Now Affected')
    expect(join.joinText).toBe('🔗 Already affecting ChatGPT — Codex was added to this incident later.')
  })

  it('first sighting: "New Incident" and no join line', () => {
    const [first] = buildIncidentAlerts([chatgpt, codex], roster({}), NOW)
    expect(first.title).toBe('🟡 OpenAI (ChatGPT, Codex) — New Incident')
    expect(first.joinText).toBeUndefined()
  })

  it('a prior service no longer in the services list is named by its id', () => {
    const [join] = buildIncidentAlerts([codex], roster({ [INC]: ['chatgpt'] }), NOW)
    expect(join.joinText).toBe('🔗 Already affecting chatgpt — Codex was added to this incident later.')
  })

  it('an advisory joiner keeps the Advisory title', () => {
    const quota = { ...shared, title: 'Usage limits temporarily reduced for Plus plans' } as Incident
    const s = [{ ...chatgpt, incidents: [quota] }, { ...codex, incidents: [quota] }] as ScoredService[]
    const [join] = buildIncidentAlerts(s, roster({ [INC]: ['chatgpt'] }), NOW)
    expect(join.title).toBe('ℹ️ Codex — Advisory')
    expect(join.joinText).toBeDefined()
  })
})

function memKV(store: Record<string, string>, failPut = false): KVLike {
  return {
    get: async (k) => store[k] ?? null,
    put: async (k, v) => { if (failPut) throw new Error('kv down'); store[k] = v },
    delete: async (k) => { delete store[k] },
  }
}

const prior: AIAnalysisResult = {
  summary: 'Users across various subscription plans are experiencing elevated error rates.',
  estimatedRecovery: '45m–2h',
  estimatedRecoveryHours: 2,
  affectedScope: ['ChatGPT Paid Plans'],
  analyzedAt: new Date(NOW - 25 * 60_000).toISOString(),
  incidentId: INC,
} as AIAnalysisResult

describe('#2072 — copyPriorServiceAnalysis', () => {
  it('copies the prior service analysis to the joiner key and returns it', async () => {
    const store = { [analysisKey('chatgpt', INC)]: JSON.stringify(prior) }
    const got = await copyPriorServiceAnalysis(memKV(store), 'codex', INC, ['chatgpt'])
    expect(got?.summary).toBe(prior.summary)
    expect(got?.estimatedRecovery).toBe('45m–2h')
    expect(JSON.parse(store[analysisKey('codex', INC)]).summary).toBe(prior.summary)
  })

  it('skips a prior service with no usable analysis and takes the next', async () => {
    const store = {
      [analysisKey('openai', INC)]: JSON.stringify({ summary: '' }),
      [analysisKey('chatgpt', INC)]: JSON.stringify(prior),
    }
    const got = await copyPriorServiceAnalysis(memKV(store), 'codex', INC, ['missing', 'openai', 'chatgpt'])
    expect(got?.summary).toBe(prior.summary)
  })

  it('null when no prior service has an analysis — the caller analyzes as before', async () => {
    const store: Record<string, string> = {}
    expect(await copyPriorServiceAnalysis(memKV(store), 'codex', INC, ['chatgpt'])).toBeNull()
    expect(store[analysisKey('codex', INC)]).toBeUndefined()
  })

  it('null when the copy cannot be written', async () => {
    const store = { [analysisKey('chatgpt', INC)]: JSON.stringify(prior) }
    expect(await copyPriorServiceAnalysis(memKV(store, true), 'codex', INC, ['chatgpt'])).toBeNull()
  })

  it("the joiner's first-estimate pin is the prior's first estimate, not its re-analyzed one", async () => {
    const store = { [analysisKey('chatgpt', INC)]: JSON.stringify({ ...prior, estimatedRecoveryHours: 5, firstEstimatedRecoveryHours: 2 }) }
    const got = await copyPriorServiceAnalysis(memKV(store), 'codex', INC, ['chatgpt'])
    expect(got?.firstEstimatedRecoveryHours).toBe(2)
    expect(store[`ai:first-est:codex:${INC}`]).toBe('2')
  })

  it('null when the prior read throws', async () => {
    const kv = { ...memKV({}), get: async () => { throw new Error('kv down') } }
    expect(await copyPriorServiceAnalysis(kv, 'codex', INC, ['chatgpt'])).toBeNull()
  })

  it('never copies a service onto itself', async () => {
    const store = { [analysisKey('codex', INC)]: JSON.stringify(prior) }
    expect(await copyPriorServiceAnalysis(memKV(store), 'codex', INC, ['codex'])).toBeNull()
  })
})
