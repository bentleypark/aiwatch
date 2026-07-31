// #778 — operator phone-push gating for Tier-1-family NEW down/degraded incidents.
import { describe, it, expect } from 'vitest'
import { pushTargetFor, buildTweetSearchUrl, PUSH_SCOPE, buildTweetDrafts, buildTweetSearches,
         buildReplyDraft, buildRedditEngageTargets, buildIncidentAlerts } from '../alerts'
import { downclassifyAdvisoryIncidents } from '../services'
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

  // #1184 — an advisory keeps an ordinary `alerted:new:` key, so nothing in the key stops the push.
  // In production it is already impact-null via `downclassifyAdvisoryIncidents` (pinned by the
  // pipeline test below); these cases pin the DIRECT gate, on an alert reaching the function with a
  // non-null impact — the state that arises if that cross-module coupling is ever narrowed. Both
  // directions: an identical alert without the flag must still push, or the guard could pass by
  // suppressing everything.
  it('skips a #1021 ADVISORY — and the same alert without the flag still pushes', () => {
    const svcs = [svc('claude', 'Claude API', 'minor')]
    const base = newAlert(['claude'])
    expect(pushTargetFor({ ...base, advisory: true }, svcs)).toBeNull()
    expect(pushTargetFor(base, svcs)).toEqual({ svcId: 'claude', serviceName: 'Claude API' })
  })

  it('agrees with the other outage-promotion builders on the same advisory alert', () => {
    // The push was the one builder gating on something else, so pin the AGREEMENT rather than the
    // push alone — a future gate change on either side surfaces here. The control half matters as
    // much: without it, a fixture that stops satisfying a builder's requirements (a new
    // TWEET_DRAFT_SERVICES field, a slug lookup) turns those assertions vacuously true.
    const svcs = [svc('claude', 'Claude API', 'minor')]
    const base = newAlert(['claude'])
    const a = { ...base, advisory: true }
    expect(buildTweetDrafts(a, svcs)).toEqual([])
    expect(buildTweetSearches(a, svcs)).toEqual([])
    expect(buildReplyDraft(a, svcs)).toBeNull()
    expect(buildRedditEngageTargets(a, svcs)).toEqual([])
    expect(pushTargetFor(a, svcs)).toBeNull()
    // control — the same alert without the flag drives all five
    expect(buildTweetDrafts(base, svcs).length).toBeGreaterThan(0)
    expect(buildTweetSearches(base, svcs).length).toBeGreaterThan(0)
    expect(buildReplyDraft(base, svcs)).not.toBeNull()
    expect(buildRedditEngageTargets(base, svcs).length).toBeGreaterThan(0)
    expect(pushTargetFor(base, svcs)).not.toBeNull()
  })

  it('skips an informational (null-impact) incident', () => {
    expect(pushTargetFor(newAlert(['claude']), [svc('claude', 'Claude API', null)])).toBeNull()
  })

  it('skips non-NEW alert kinds (status down/degraded edge, recovered, resolved, withdrawal)', () => {
    const svcs = [svc('claude', 'Claude API', 'major')]
    // `alerted:wd:` (#1106) — a withdrawal must never push. This pins the outcome, not the reason:
    // it also holds if the kind gate stops rejecting it first, since the non-outage gate catches
    // `'withdrawn'` too.
    for (const key of ['alerted:down:claude', 'alerted:degraded:claude', 'alerted:recovered:claude', 'alerted:res:inc1', 'alerted:wd:inc1']) {
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

// #1184 — what actually keeps an advisory off the phone push in production is a coupling between
// two modules: `downclassifyAdvisoryIncidents` (services.ts) nulls the impact off the SAME title
// predicate that `buildIncidentAlerts` (alerts.ts) uses to set `advisory`, and the cron feeds ONE
// down-classified list to both builders. The direct gate above is defense against that coupling
// drifting; this pins the coupling itself, which no test covered. Asserting the down-classification
// step explicitly is what keeps it non-vacuous — on `impact: null` alone the push is suppressed by
// the pre-existing gate, so a version of this test that only checked the push would still pass with
// the #1184 gate deleted, and would equally still pass with the down-classification deleted.
describe('#1021 → #1184 pipeline: a real advisory never reaches the push', () => {
  const ADVISORY_TITLE = 'Usage limits temporarily reduced for Claude API'

  // `status` is a parameter because the two cases genuinely differ, and #1021 does not decide it —
  // `downclassifyAdvisoryIncidents` rewrites `incident.impact` only; the badge comes from the
  // provider's own component/indicator chain. Pinning both cases to one value would make one of them
  // a shape the real chain rarely emits.
  function pipeline(title: string, providerImpact: 'minor' | 'major', status: string) {
    const input = [{
      id: 'claude', name: 'Claude API', provider: 'Anthropic', category: 'api', status,
      statusUrl: '', uptime30d: 99, latency: 100,
      incidents: [{ id: 'inc1', title, status: 'investigating', startedAt: '2026-06-25T05:00:00Z', impact: providerImpact }],
    }] as unknown as ScoredService[]
    // The real order: fetchAllServices down-classifies at its choke point, and the cron scores that
    // same list and passes it to BOTH buildIncidentAlerts and pushTargetFor.
    const post = downclassifyAdvisoryIncidents(input) as unknown as ScoredService[]
    const scored = post.map((s) => ({ ...s, aiwatchScore: 90, scoreGrade: 'excellent' })) as ScoredService[]
    return { scored, alerts: buildIncidentAlerts(scored, new Map(), Date.parse('2026-06-25T05:10:00Z')) }
  }

  it('down-classifies the provider impact AND flags the alert AND withholds the push', () => {
    const { scored, alerts } = pipeline(ADVISORY_TITLE, 'minor', 'operational')
    expect(scored[0].incidents[0].impact, 'the #1021 half — impact must be nulled').toBeNull()
    expect(alerts).toHaveLength(1)
    expect(alerts[0].advisory, 'the #1184 half — the alert must carry the flag').toBe(true)
    expect(pushTargetFor(alerts[0], scored)).toBeNull()
  })

  it('control — a real outage on the same service keeps its impact and does push', () => {
    const { scored, alerts } = pipeline('Elevated error rates on the Messages API', 'major', 'down')
    expect(scored[0].incidents[0].impact).toBe('major')
    expect(alerts[0].advisory).toBeUndefined()
    expect(pushTargetFor(alerts[0], scored)).toEqual({ svcId: 'claude', serviceName: 'Claude API' })
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
