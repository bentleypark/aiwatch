// #1959 — the "Affected now" block's ordering and grouping.
//
// The fixtures run category order against start order, and include a pair that shares an incident id
// outside any family (deepseek + deepseekapp) and a family pair with different ids (openai + chatgpt).
import { describe, it, expect } from 'vitest'
import { buildAffectedEntries, anchorIncidentOf, issueSort } from '../affectedServices'

const H = 3_600_000
const NOW = Date.parse('2026-11-11T12:00:00Z')
const ago = (ms) => new Date(NOW - ms).toISOString()

const inc = (id, startedAt, status = 'investigating', title = `incident ${id}`) =>
  ({ id, title, status, impact: 'major', startedAt, resolvedAt: null, duration: null, timeline: [] })

const svc = (id, name, status, incidents = [], extra = {}) =>
  ({ id, name, provider: name, category: 'api', status, aiwatchScore: 80, incidents, ...extra })

const keysOf = (entries) => entries.map((e) => `${e.key} [${e.members.map((m) => m.id).join(',')}]`)

describe('buildAffectedEntries', () => {
  it('folds services that share one incident id into one entry, in every category', () => {
    const shared = inc('anthropic-1', ago(2 * H))
    const entries = buildAffectedEntries([
      svc('claude', 'Claude API', 'degraded', [shared]),
      svc('claudecode', 'Claude Code', 'down', [shared]),
      svc('claudeai', 'claude.ai', 'degraded', [shared]),
      svc('openai', 'OpenAI API', 'operational'),
    ])
    expect(keysOf(entries)).toEqual(['incident:anthropic-1 [claudecode,claude,claudeai]'])
    expect(entries[0].status).toBe('down')
  })

  it('orders entries by incident start, newest first, not by category or catalog order', () => {
    const entries = buildAffectedEntries([
      svc('claude', 'Claude API', 'degraded', [inc('a', ago(5 * H))]),
      svc('cursor', 'Cursor', 'degraded', [inc('b', ago(3 * H))]),
      svc('claudeai', 'claude.ai', 'degraded', [inc('c', ago(1 * H))]),
    ])
    expect(keysOf(entries)).toEqual(['incident:c [claudeai]', 'incident:b [cursor]', 'incident:a [claude]'])
  })

  it('groups by the shared id, not by family: openai and chatgpt with different ids stay apart', () => {
    const entries = buildAffectedEntries([
      svc('openai', 'OpenAI API', 'degraded', [inc('o-1', ago(4 * H))]),
      svc('chatgpt', 'ChatGPT', 'degraded', [inc('c-1', ago(2 * H))]),
    ])
    expect(keysOf(entries)).toEqual(['incident:c-1 [chatgpt]', 'incident:o-1 [openai]'])
  })

  it('groups two services outside any family when they share an id', () => {
    const shared = inc('ds-1', ago(1 * H), 'investigating', 'DeepSeek Web/API Degraded Performance')
    const entries = buildAffectedEntries([
      svc('deepseek', 'DeepSeek API', 'degraded', [shared]),
      svc('deepseekapp', 'DeepSeek App', 'degraded', [shared]),
    ])
    expect(keysOf(entries)).toEqual(['incident:ds-1 [deepseek,deepseekapp]'])
  })

  it('lists a service under its newest open incident, so a service sits in one entry only', () => {
    const older = inc('shared-old', ago(6 * H))
    const newer = inc('claude-only-new', ago(1 * H))
    const entries = buildAffectedEntries([
      svc('claude', 'Claude API', 'degraded', [older, newer]),
      svc('claudeai', 'claude.ai', 'degraded', [older]),
      svc('claudecode', 'Claude Code', 'degraded', [older]),
    ])
    expect(keysOf(entries)).toEqual([
      'incident:claude-only-new [claude]',
      'incident:shared-old [claudeai,claudecode]',
    ])
    const ids = entries.flatMap((e) => e.members.map((m) => m.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('lists a service under its live incident even when a newer monitoring one is open', () => {
    const live = inc('live-A', ago(3 * H))
    const entries = buildAffectedEntries([
      svc('claude', 'Claude API', 'degraded', [live, inc('mon-B', ago(1 * H), 'monitoring')]),
      svc('claudeai', 'claude.ai', 'degraded', [live]),
    ])
    expect(keysOf(entries)).toEqual(['incident:live-A [claude,claudeai]'])
  })

  it('ignores a resolved incident, and counts a monitoring one as open', () => {
    const entries = buildAffectedEntries([
      svc('groq', 'GroqCloud', 'degraded', [inc('r', ago(1 * H), 'resolved')]),
      svc('fal', 'fal.ai', 'degraded', [inc('m', ago(2 * H), 'monitoring')]),
    ])
    expect(keysOf(entries)).toEqual(['incident:m [fal]', 'service:groq [groq]'])
  })

  it('puts an affected service with no usable incident after the dated entries, worst state first', () => {
    const entries = buildAffectedEntries([
      svc('modal', 'Modal', 'down', [], { aiwatchScore: 70 }),
      svc('replicate', 'Replicate', 'degraded', [inc('rep', ago(9 * H))]),
      svc('jina', 'Jina AI', 'degraded', [], { aiwatchScore: 60 }),
      svc('stability', 'Stability AI', 'degraded', [inc('bad', 'not-a-date')], { aiwatchScore: 50 }),
    ])
    expect(keysOf(entries)).toEqual([
      'incident:rep [replicate]',
      'service:modal [modal]',
      'service:stability [stability]',
      'service:jina [jina]',
    ])
  })

  it('does not order or date a service by its Better Stack today-row', () => {
    const todayRow = {
      id: 'bs-hist:r1:2026-11-11', title: 'Modal — down', status: 'investigating', impact: 'minor',
      startedAt: ago(10 * 60_000), resolvedAt: null, duration: null, timeline: [],
      derived: 'status_history', derivedDay: '2026-11-11', accruing: true,
    }
    const entries = buildAffectedEntries([
      svc('modal', 'Modal', 'down', [todayRow]),
      svc('replicate', 'Replicate', 'degraded', [inc('rep', ago(9 * H))]),
    ])
    expect(keysOf(entries)).toEqual(['incident:rep [replicate]', 'service:modal [modal]'])
    expect(entries[1].incident).toBeNull()
  })

  it('does not trust the incident list of a stale source', () => {
    const [entry] = buildAffectedEntries([
      svc('mistral', 'Mistral', 'degraded', [inc('m-1', ago(1 * H))], { incidentSourceStale: true }),
    ])
    expect(entry.key).toBe('service:mistral')
    expect(entry.incident).toBeNull()
  })

  it('lists only services that are affected for display', () => {
    const entries = buildAffectedEntries([
      svc('openrouter', 'OpenRouter', 'operational', [inc('x', ago(1 * H))]),
      svc('cohere', 'Cohere', 'operational', [], { partialCount: 2 }),
      svc('kimi', 'Kimi API', 'unknown'),
      svc('deepgram', 'Deepgram', 'degraded', [inc('d', ago(1 * H))], { sourceDead: true }),
      svc('assemblyai', 'AssemblyAI', 'degraded', [inc('a', ago(1 * H))]),
    ])
    expect(keysOf(entries)).toEqual(['incident:a [assemblyai]'])
  })

  it('breaks a tie on start by the worse state, then by name', () => {
    const t = ago(1 * H)
    const entries = buildAffectedEntries([
      svc('together', 'Together AI', 'degraded', [inc('t', t)]),
      svc('cerebras', 'Cerebras', 'degraded', [inc('c', t)]),
      svc('fireworks', 'Fireworks AI', 'down', [inc('f', t)]),
    ])
    expect(keysOf(entries)).toEqual(['incident:f [fireworks]', 'incident:c [cerebras]', 'incident:t [together]'])
  })

  it('returns nothing when no service is affected', () => {
    expect(buildAffectedEntries([])).toEqual([])
    expect(buildAffectedEntries([svc('claude', 'Claude API', 'operational', [inc('x', ago(1 * H))])])).toEqual([])
  })

  it('survives a malformed payload', () => {
    expect(buildAffectedEntries(undefined)).toEqual([])
    expect(buildAffectedEntries([svc('groq', 'GroqCloud', 'degraded', 'oops')]).map((e) => e.key)).toEqual(['service:groq'])
  })
})

describe('anchorIncidentOf', () => {
  it('picks the open incident that started last, and the larger id on a tie', () => {
    const t = ago(1 * H)
    expect(anchorIncidentOf(svc('x', 'X', 'degraded', [inc('a', ago(3 * H)), inc('b', t), inc('c', t)])).id).toBe('c')
  })
})

describe('issueSort', () => {
  it('is the Overview Issues-tab order: worse state first, then the lower Score', () => {
    const list = [
      svc('a', 'A', 'degraded', [], { aiwatchScore: 90 }),
      svc('b', 'B', 'down', [], { aiwatchScore: 95 }),
      svc('c', 'C', 'degraded', [], { aiwatchScore: 40 }),
    ]
    expect([...list].sort(issueSort).map((s) => s.id)).toEqual(['b', 'c', 'a'])
  })
})
