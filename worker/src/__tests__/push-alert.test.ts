// #778 — operator phone-push gating for Tier-1-family NEW down/degraded incidents.
import { describe, it, expect } from 'vitest'
import { pushTargetFor, buildTweetSearchUrl, PUSH_SCOPE } from '../alerts'
import type { AlertCandidate, ScoredService } from '../alerts'

function svc(id: string, name: string, impact: 'minor' | 'major' | 'critical' | null = 'major', incId = 'inc1'): ScoredService {
  return {
    id, name, provider: 'x', category: 'api', status: impact === 'minor' ? 'degraded' : 'down',
    statusUrl: '', incidents: [{ id: incId, title: 'Elevated errors', status: 'investigating', startedAt: '2026-06-25T05:00:00Z', impact } as any],
    uptime30d: 99, latency: 100, aiwatchScore: 90, scoreGrade: 'excellent',
  } as unknown as ScoredService
}

function newAlert(svcIds: string[], incId = 'inc1'): AlertCandidate {
  return { key: `alerted:new:${incId}`, title: '🔴 incident', description: '', color: 0xed4245, url: 'https://ai-watch.dev/#x', svcIds }
}

describe('pushTargetFor — fires for in-scope NEW down/degraded incidents', () => {
  it('returns the primary service for a Tier-1 (claude) NEW major incident', () => {
    const t = pushTargetFor(newAlert(['claude']), [svc('claude', 'Claude API', 'major')])
    expect(t).toEqual({ svcId: 'claude', serviceName: 'Claude API' })
  })

  it.each(['openai', 'gemini', 'chatgpt', 'claudeai'])('fires for in-scope service %s', (id) => {
    const t = pushTargetFor(newAlert([id]), [svc(id, id, 'major')])
    expect(t?.svcId).toBe(id)
  })

  it('fires for a degraded (minor-impact) incident', () => {
    const t = pushTargetFor(newAlert(['openai']), [svc('openai', 'OpenAI API', 'minor')])
    expect(t?.svcId).toBe('openai')
  })

  it('picks the FIRST in-push-scope service for a grouped incident', () => {
    const t = pushTargetFor(newAlert(['claude', 'claudeai']), [
      svc('claude', 'Claude API', 'major'),
      svc('claudeai', 'claude.ai', 'major'),
    ])
    expect(t?.svcId).toBe('claude')
  })
})

describe('pushTargetFor — skips out-of-gate cases', () => {
  it('skips a non-push-scope service (claudecode/codex are NOT push scope, narrower than search scope)', () => {
    expect(pushTargetFor(newAlert(['claudecode']), [svc('claudecode', 'Claude Code', 'major')])).toBeNull()
    expect(pushTargetFor(newAlert(['codex']), [svc('codex', 'Codex', 'major')])).toBeNull()
  })

  it('skips a wholly out-of-scope service (mistral)', () => {
    expect(pushTargetFor(newAlert(['mistral']), [svc('mistral', 'Mistral API', 'major')])).toBeNull()
  })

  it('skips an informational (null-impact) incident', () => {
    expect(pushTargetFor(newAlert(['claude']), [svc('claude', 'Claude API', null)])).toBeNull()
  })

  it('skips non-NEW alert kinds (status down/degraded edge, recovered, resolved)', () => {
    const svcs = [svc('claude', 'Claude API', 'major')]
    for (const key of ['alerted:down:claude', 'alerted:degraded:claude', 'alerted:recovered:claude', 'alerted:res:inc1']) {
      const a: AlertCandidate = { key, title: '🔴', description: '', color: 0xed4245, url: '', svcIds: ['claude'] }
      expect(pushTargetFor(a, svcs), key).toBeNull()
    }
  })

  it('skips when the incident is not found in services (no impact signal)', () => {
    const a = newAlert(['claude'], 'missing-inc')
    expect(pushTargetFor(a, [svc('claude', 'Claude API', 'major', 'other-inc')])).toBeNull()
  })

  it('resolves svcIds the legacy way when alert.svcIds is absent', () => {
    const a: AlertCandidate = { key: 'alerted:new:inc1', title: '🔴', description: '', color: 0xed4245, url: '' }
    // svcIdsForAlert maps the new-incident key to whichever service carries inc1
    const t = pushTargetFor(a, [svc('claude', 'Claude API', 'major', 'inc1')])
    expect(t?.svcId).toBe('claude')
  })
})

// Sync invariant: PUSH_SCOPE ⊆ TWEET_SEARCH_TERMS. The cron's push Click target is
// buildTweetSearchUrl(target.svcId); if a service is added to PUSH_SCOPE but not to
// TWEET_SEARCH_TERMS, the push still fires but the tap falls back to a generic URL (silent
// regression). Pin it here, mirroring tweet-search-scope.test.ts / api-tier-sync.test.ts.
describe('PUSH_SCOPE ⊆ TWEET_SEARCH_TERMS (push Click-target resolves)', () => {
  it.each([...PUSH_SCOPE])('buildTweetSearchUrl resolves a Top-search URL for push-scope %s', (id) => {
    expect(buildTweetSearchUrl(id)).not.toBeNull()
  })
})
