import { describe, it, expect } from 'vitest'
import { buildIncidentAlerts, buildReplyDraft, buildTweetDrafts, buildRedditEngageTargets, buildBlueskyEngageTargets } from '../alerts'
import type { ScoredService } from '../alerts'
import type { Incident } from '../types'

// #1546 — 2026-09-29, incident 4xvtc2gnq73l: claude.ai + Claude Code alerted first, the Claude API
// joined a later cycle. The join alert's share links pointed at /is-claude-api-down.
const NOW = 1742860800000
const shared: Incident = {
  id: 'anth-multi',
  title: 'Elevated errors on claude.ai, Claude Code, Claude Cowork and the Claude API',
  status: 'investigating',
  startedAt: new Date(NOW - 20 * 60_000).toISOString(),
  impact: 'major',
  duration: null,
  timeline: [],
} as Incident

function svc(id: string, name: string, category: ScoredService['category'], incidents: Incident[] = [shared]): ScoredService {
  const s: Partial<ScoredService> = {
    id, name, provider: 'Anthropic', category, status: 'degraded',
    incidents, uptime30d: 99.5, latency: 200, aiwatchScore: 80, scoreGrade: 'good',
  }
  return s as ScoredService
}

const claude = svc('claude', 'Claude API', 'api')
const claudeai = svc('claudeai', 'claude.ai', 'app')
const claudecode = svc('claudecode', 'Claude Code', 'agent')
const openaiIncident = { ...shared, id: 'oai-1', title: 'Elevated errors on the API' } as Incident
const openai = { ...svc('openai', 'OpenAI API', 'api', [openaiIncident]), provider: 'OpenAI' } as ScoredService
const chatgpt = { ...svc('chatgpt', 'ChatGPT', 'app', [openaiIncident]), provider: 'OpenAI' } as ScoredService

function roster(entries: Record<string, string[]>): Map<string, Set<string>> {
  return new Map(Object.entries(entries).map(([k, v]) => [k, new Set(v)]))
}

describe('#1546 — a join alert for an already-alerted family links the group page', () => {
  const services = [claude, claudeai, claudecode]
  const [join] = buildIncidentAlerts(services, roster({ 'anth-multi': ['claudeai', 'claudecode'] }), NOW)

  it('the join alert still represents only the joiner', () => {
    expect(join.svcIds).toEqual(['claude'])
    expect(join.priorSvcIds).toEqual(['claudeai', 'claudecode'])
  })

  it('X reply draft', () => {
    const reply = buildReplyDraft(join, services)
    expect(reply?.text).toContain('https://ai-watch.dev/is-claude-down?')
    expect(reply?.text).not.toContain('is-claude-api-down')
  })

  it('X tweet drafts include the group draft', () => {
    const drafts = buildTweetDrafts(join, services)
    expect(drafts.map((d) => d.serviceId)).toContain('family:claude')
  })

  it('Reddit and Bluesky reply links', () => {
    const reddit = buildRedditEngageTargets(join, services)
    const bsky = buildBlueskyEngageTargets(join, services)
    expect(reddit.map((t) => t.serviceId)).toEqual(['family:claude'])
    expect(reddit[0].replyLink).toContain('/is-claude-down?')
    expect(bsky.map((t) => t.serviceId)).toEqual(['family:claude'])
    expect(bsky[0].replyLink).toContain('/is-claude-down?')
  })
})

describe('#1546 — single-page links that must not change', () => {
  it('a lone family member with an empty roster keeps its own page', () => {
    const [alert] = buildIncidentAlerts([claude], roster({}), NOW)
    expect(alert.priorSvcIds).toBeUndefined()
    expect(buildReplyDraft(alert, [claude])?.text).toContain('/is-claude-api-down?')
    expect(buildRedditEngageTargets(alert, [claude]).map((t) => t.serviceId)).toEqual(['claude'])
  })

  it('roster members from another family do not make a group', () => {
    const services = [claude, openai, chatgpt]
    const [alert] = buildIncidentAlerts([claude], roster({ 'anth-multi': ['openai', 'chatgpt'] }), NOW)
    expect(buildReplyDraft(alert, services)?.text).toContain('/is-claude-api-down?')
    expect(buildTweetDrafts(alert, services).map((d) => d.serviceId)).toEqual(['claude'])
    expect(buildRedditEngageTargets(alert, services).map((t) => t.serviceId)).toEqual(['claude'])
  })
})
