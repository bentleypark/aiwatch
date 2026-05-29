// #348 — outage-tweet draft attached to operator Discord alerts for the Claude/OpenAI family.
import { describe, it, expect } from 'vitest'
import { buildTweetDraft } from '../alerts'
import type { AlertCandidate, ScoredService } from '../alerts'

const X_INTENT = 'https://twitter.com/intent/tweet?text='

function mockService(overrides: Partial<ScoredService> = {}): ScoredService {
  return {
    id: 'claude',
    name: 'Claude API',
    provider: 'Anthropic',
    category: 'api',
    status: 'operational',
    statusUrl: 'https://status.claude.com',
    incidents: [],
    uptime30d: 99.9,
    latency: 200,
    aiwatchScore: 90,
    scoreGrade: 'excellent',
    ...overrides,
  } as ScoredService
}

function alert(overrides: Partial<AlertCandidate> = {}): AlertCandidate {
  return {
    key: 'alerted:new:inc1',
    title: '🔴 Claude API — New Incident',
    description: 'Elevated errors',
    color: 0xed4245,
    url: 'https://ai-watch.dev/#claude',
    ...overrides,
  }
}

describe('buildTweetDraft', () => {
  it('builds an outage draft for a new Claude incident (impact + title + is-down url)', () => {
    const svc = mockService({
      status: 'down',
      incidents: [{ id: 'inc1', title: 'API returning 500s', status: 'investigating', startedAt: new Date().toISOString(), impact: 'major' } as any],
    })
    const draft = buildTweetDraft(alert(), [svc])
    expect(draft).not.toBeNull()
    expect(draft!.text).toBe('🔴 Claude API is reporting a major outage: API returning 500s. Live status → https://ai-watch.dev/is-claude-down')
    expect(draft!.intentUrl).toBe(X_INTENT + encodeURIComponent(draft!.text))
  })

  it('falls back to status phrasing for a status-only down alert (no incident)', () => {
    const svc = mockService({ id: 'openai', name: 'OpenAI API', provider: 'OpenAI', status: 'down' })
    const draft = buildTweetDraft(alert({ key: 'alerted:down:openai', title: '🔴 OpenAI API — Service Down' }), [svc])
    expect(draft!.text).toBe('🔴 OpenAI API is reporting an outage. Live status → https://ai-watch.dev/is-openai-down')
  })

  it('uses "degraded performance" for a degraded status alert', () => {
    const svc = mockService({ id: 'chatgpt', name: 'ChatGPT', provider: 'OpenAI', category: 'app', status: 'degraded' })
    const draft = buildTweetDraft(alert({ key: 'alerted:degraded:chatgpt', title: '🟠 ChatGPT — Partially Degraded' }), [svc])
    expect(draft!.text).toBe('🔴 ChatGPT is reporting degraded performance. Live status → https://ai-watch.dev/is-chatgpt-down')
  })

  it('maps minor incident impact to "degraded performance"', () => {
    const svc = mockService({
      status: 'degraded',
      incidents: [{ id: 'inc1', title: 'Slow responses', status: 'investigating', startedAt: new Date().toISOString(), impact: 'minor' } as any],
    })
    const draft = buildTweetDraft(alert(), [svc])
    expect(draft!.text).toBe('🔴 Claude API is reporting degraded performance: Slow responses. Live status → https://ai-watch.dev/is-claude-down')
  })

  it('builds a recovery draft with duration parsed from the resolved title (claude.ai slug)', () => {
    const svc = mockService({
      id: 'claudeai', name: 'claude.ai', category: 'app',
      incidents: [{ id: 'incX', title: 'Resolved', status: 'resolved', startedAt: new Date().toISOString(), duration: '1h 20m', impact: 'major' } as any],
    })
    const draft = buildTweetDraft(alert({ key: 'alerted:res:incX', title: '🟢 claude.ai — Incident Resolved (1h 20m)' }), [svc])
    expect(draft!.text).toBe('🟢 claude.ai recovered after 1h 20m. Live status → https://ai-watch.dev/is-claude-ai-down')
  })

  it('builds a recovery draft from a service-recovered status alert', () => {
    const svc = mockService({ status: 'operational' })
    const draft = buildTweetDraft(alert({ key: 'alerted:recovered:claude', title: '🟢 Claude API — Service Recovered (45m)' }), [svc])
    expect(draft!.text).toBe('🟢 Claude API recovered after 45m. Live status → https://ai-watch.dev/is-claude-down')
  })

  it('omits duration when the recovery title has none', () => {
    const svc = mockService({ status: 'operational' })
    const draft = buildTweetDraft(alert({ key: 'alerted:recovered:claude', title: '🟢 Claude API — Service Recovered' }), [svc])
    expect(draft!.text).toBe('🟢 Claude API has recovered. Live status → https://ai-watch.dev/is-claude-down')
  })

  it('resolves the claudecode → claude-code slug and maps critical impact to "a major outage"', () => {
    const svc = mockService({
      id: 'claudecode', name: 'Claude Code', category: 'agent', status: 'down',
      incidents: [{ id: 'inc1', title: 'CLI down', status: 'investigating', startedAt: new Date().toISOString(), impact: 'critical' } as any],
    })
    const draft = buildTweetDraft(alert(), [svc])
    expect(draft!.text).toBe('🔴 Claude Code is reporting a major outage: CLI down. Live status → https://ai-watch.dev/is-claude-code-down')
  })

  it('skips a non-target sibling and resolves the in-scope service in a shared-incident group', () => {
    // svcIdsForAlert returns services in array order; gemini (non-target) is listed first, so the
    // .find(in-scope) must skip past it to reach claude. Guards the documented sibling-skip path.
    const inc = { id: 'inc1', title: 'Shared multi-provider outage', status: 'investigating', startedAt: new Date().toISOString(), impact: 'major' } as any
    const gemini = mockService({ id: 'gemini', name: 'Gemini API', provider: 'Google', status: 'down', incidents: [inc] })
    const claude = mockService({ status: 'down', incidents: [inc] })
    const draft = buildTweetDraft(alert(), [gemini, claude])
    expect(draft!.text).toBe('🔴 Claude API is reporting a major outage: Shared multi-provider outage. Live status → https://ai-watch.dev/is-claude-down')
  })

  it('consults _mergedKeys when resolving the covered service', () => {
    // Merged alerts (mergeTogetherAlerts) set _mergedKeys; buildTweetDraft must scan them, not just alert.key.
    const svc = mockService({
      status: 'down',
      incidents: [{ id: 'incA', title: 'Merged incident', status: 'investigating', startedAt: new Date().toISOString(), impact: 'major' } as any],
    })
    const draft = buildTweetDraft(alert({ key: 'alerted:new:incA', _mergedKeys: ['alerted:new:incA', 'alerted:new:incB'] }), [svc])
    expect(draft!.text).toBe('🔴 Claude API is reporting a major outage: Merged incident. Live status → https://ai-watch.dev/is-claude-down')
  })

  it('returns null for a non-target service', () => {
    const svc = mockService({ id: 'gemini', name: 'Gemini API', provider: 'Google', status: 'down',
      incidents: [{ id: 'inc1', title: 'down', status: 'investigating', startedAt: new Date().toISOString(), impact: 'major' } as any] })
    expect(buildTweetDraft(alert(), [svc])).toBeNull()
  })

  it('returns null for an unrecognized alert key', () => {
    const svc = mockService({ status: 'down' })
    expect(buildTweetDraft(alert({ key: 'something:else:claude' }), [svc])).toBeNull()
  })

  it('truncates a long incident title to keep the tweet ≤ 270 chars', () => {
    const svc = mockService({
      status: 'down',
      incidents: [{ id: 'inc1', title: 'x'.repeat(400), status: 'investigating', startedAt: new Date().toISOString(), impact: 'major' } as any],
    })
    const draft = buildTweetDraft(alert(), [svc])
    expect(draft!.text.length).toBeLessThanOrEqual(270)
    expect(draft!.text).toContain('…')
    expect(draft!.text).toContain('https://ai-watch.dev/is-claude-down')
  })

  it('collapses newlines/backticks in the incident title', () => {
    const svc = mockService({
      status: 'down',
      incidents: [{ id: 'inc1', title: 'line1\nline2 ```code```', status: 'investigating', startedAt: new Date().toISOString(), impact: 'major' } as any],
    })
    const draft = buildTweetDraft(alert(), [svc])
    expect(draft!.text).not.toContain('\n')
    expect(draft!.text).not.toContain('`')
    expect(draft!.text).toContain('line1 line2 code')
  })
})
