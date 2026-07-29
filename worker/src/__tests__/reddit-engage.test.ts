// #1182 — operator-only Reddit engagement links on incident alerts. The Reddit twin of the #777
// X-search block: same svcIds resolution, same non-outage gate, same operator-only boundary.
import { describe, it, expect } from 'vitest'
import {
  REDDIT_ENGAGE_SUBS,
  TWEET_SEARCH_TERMS,
  buildRedditSearchUrl,
  buildRedditAllSearchUrl,
  buildRedditEngageTargets,
  appendRedditSection,
  DISCORD_EMBED_DESC_MAX,
} from '../alerts'
import type { AlertCandidate, ScoredService } from '../alerts'
import { SERVICES } from '../services'
import { SERVICE_ID_TO_SLUG } from '../../../api/_is-down/slug-map'

function mockService(overrides: Partial<ScoredService> = {}): ScoredService {
  return {
    id: 'claude',
    name: 'Claude API',
    provider: 'Anthropic',
    category: 'api',
    status: 'down',
    statusUrl: 'https://status.claude.com',
    incidents: [{ id: 'inc1', title: 'API errors', status: 'investigating', startedAt: '2026-07-29T00:00:00Z', impact: 'major' } as any],
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

const DIV = '━━━'

describe('REDDIT_ENGAGE_SUBS scope', () => {
  it('keys exactly match TWEET_SEARCH_TERMS — the two channels must not drift apart', () => {
    // buildRedditEngageTargets requires BOTH a sub list and a term, so a key present in one map and
    // absent from the other silently produces no Reddit block for that service.
    expect(Object.keys(REDDIT_ENGAGE_SUBS).sort()).toEqual(Object.keys(TWEET_SEARCH_TERMS).sort())
  })

  it('every scoped id is a real worker service with an is-down slug', () => {
    // Without a slug the target is SKIPPED (not rendered link-less), so a slug-map change would
    // silently shrink the block — this is what keeps that skip unreachable in practice.
    const workerIds = new Set(SERVICES.map((s) => s.id))
    for (const id of Object.keys(REDDIT_ENGAGE_SUBS)) {
      expect(workerIds.has(id), `reddit-engage id '${id}'`).toBe(true)
      expect(SERVICE_ID_TO_SLUG[id], `no is-down slug for '${id}'`).toBeTruthy()
    }
  })

  it('lists 1-3 non-empty subreddits per service (the block stays short)', () => {
    for (const [id, subs] of Object.entries(REDDIT_ENGAGE_SUBS)) {
      expect(subs.length, `${id} sub count`).toBeGreaterThan(0)
      expect(subs.length, `${id} sub count`).toBeLessThanOrEqual(3)
      for (const s of subs) expect(s, `${id} sub name`).toMatch(/^\w+$/)
      expect(new Set(subs).size, `${id} has duplicate subs`).toBe(subs.length)
    }
  })

  it('excludes the two measured bot mirrors (no human audience to reply to)', () => {
    // r/Claude_reports ranked FIRST by raw hit count (25/25 posts by ClaudeAI-mod-bot, mean 0.0
    // comments); r/outagealerts is a competitor's feed (23/25 by isdownapp). Ranking on volume alone
    // would have put a zero-human mirror at the top — pin the exclusion so a later "add the top sub"
    // edit can't reintroduce it. LIMITATION: this pins two NAMES. Author concentration and
    // comments-per-post are not derivable in a unit test, so a NEW bot mirror is not catchable here.
    const all = Object.values(REDDIT_ENGAGE_SUBS).flat()
    expect(all).not.toContain('Claude_reports')
    expect(all).not.toContain('outagealerts')
  })
})

describe('buildRedditSearchUrl / buildRedditAllSearchUrl', () => {
  it('scopes to the sub, sorts newest, and windows to a day', () => {
    expect(buildRedditSearchUrl('ClaudeAI', 'is claude down')).toBe(
      `https://www.reddit.com/r/ClaudeAI/search/?q=${encodeURIComponent('is claude down')}&restrict_sr=1&sort=new&t=day`,
    )
  })

  it('encodes the phrase (no raw space reaches the URL)', () => {
    expect(buildRedditSearchUrl('OpenAI', 'is chatgpt down')).not.toMatch(/q=[^&]* /)
    expect(buildRedditAllSearchUrl('is chatgpt down')).not.toMatch(/q=[^&]* /)
  })

  it('the all-Reddit search is NOT sub-restricted (it is what reaches the 82-sub long tail)', () => {
    const url = buildRedditAllSearchUrl('is claude down')
    expect(url).not.toContain('restrict_sr')
    expect(url).not.toContain('/r/')
  })
})

describe('buildRedditEngageTargets', () => {
  it('builds a target for the alert service with its subs, all-Reddit search and reply link', () => {
    const [t, ...rest] = buildRedditEngageTargets(alert(), [mockService()])
    expect(rest).toHaveLength(0)
    expect(t.serviceId).toBe('claude')
    expect(t.serviceName).toBe('Claude API')
    expect(t.subs.map((s) => s.subreddit)).toEqual(['ClaudeAI', 'Anthropic', 'claude'])
    expect(t.allRedditUrl).toContain('reddit.com/search/')
  })

  it('builds the reply link exactly as formatRedditAlert does — #539 ?e= AND #548 utm together', () => {
    // Asserted as one whole string, not two substrings: dropping appendStatusHint while keeping
    // appendUtm (or vice versa) must fail, since the code comment claims both surfaces tag identically.
    const [t] = buildRedditEngageTargets(alert(), [mockService()])
    expect(t.replyLink).toBe(
      'https://ai-watch.dev/is-claude-api-down?e=reddit&utm_source=reddit&utm_medium=social&utm_campaign=outage',
    )
  })

  it('every scoped service produces a UTM-tagged reply link', () => {
    for (const id of Object.keys(REDDIT_ENGAGE_SUBS)) {
      const [t] = buildRedditEngageTargets(alert({ svcIds: [id] }), [mockService({ id, name: id })])
      expect(t?.replyLink, `replyLink for '${id}'`).toContain('utm_source=reddit')
      expect(t?.replyLink, `?e= hint for '${id}'`).toContain('?e=reddit')
    }
  })

  it('skips out-of-scope services', () => {
    expect(buildRedditEngageTargets(alert({ svcIds: ['mistral'] }), [mockService({ id: 'mistral' })])).toEqual([])
  })

  it('dedupes when the same service appears twice in svcIds', () => {
    expect(buildRedditEngageTargets(alert({ svcIds: ['claude', 'claude'] }), [mockService()])).toHaveLength(1)
  })

  it('covers each in-scope service of a merged multi-service alert', () => {
    const out = buildRedditEngageTargets(
      alert({ svcIds: ['claude', 'claudeai'] }),
      [mockService(), mockService({ id: 'claudeai', name: 'claude.ai' })],
    )
    expect(out.map((t) => t.serviceId)).toEqual(['claude', 'claudeai'])
  })

  it('returns nothing for an ADVISORY — a quota notice is not an outage to go reply about', () => {
    expect(buildRedditEngageTargets(alert({ advisory: true }), [mockService()])).toEqual([])
  })

  it('returns nothing for a WITHDRAWN incident — the provider took the claim back', () => {
    // svcIds set explicitly because buildWithdrawalAlerts always sets it — a withdrawn incident no
    // longer exists on any service. This decouples the assertion from the fixture's incident list.
    expect(buildRedditEngageTargets(alert({ key: 'alerted:wd:inc1', svcIds: ['claude'] }), [mockService()])).toEqual([])
  })

  it('resolves the service from a STATUS-edge key, which carries no svcIds', () => {
    // buildServiceAlerts sets no svcIds on alerted:down:/degraded: — those fall through to
    // svcIdsForAlert's key-TAIL branch, a structurally different path from the incident scan every
    // other test here exercises. Swapping the kind argument would silently render nothing on every
    // status-edge outage, which for chatgpt/claudeai/codex/claudecode is a large share of alerts.
    const out = buildRedditEngageTargets(alert({ key: 'alerted:down:claude' }), [mockService()])
    expect(out.map((t) => t.serviceId)).toEqual(['claude'])
  })

  it('renders on a RECOVERY too — matching the #777 X block, recorded here as intended', () => {
    const out = buildRedditEngageTargets(alert({ key: 'alerted:recovered:claudeai' }), [
      mockService({ id: 'claudeai', name: 'claude.ai' }),
    ])
    expect(out.map((t) => t.serviceId)).toEqual(['claudeai'])
  })

  it('returns nothing when the key is not an alert key', () => {
    expect(buildRedditEngageTargets(alert({ key: 'nonsense' }), [mockService()])).toEqual([])
  })
})

describe('appendRedditSection', () => {
  it('renders the header, the sub links, the all-Reddit search, the reply link and the posting caps', () => {
    const out = appendRedditSection('base', buildRedditEngageTargets(alert(), [mockService()]), DIV)
    expect(out).toContain('FIND REDDIT THREADS TO REPLY TO')
    // Whole markdown links, not labels: 'r/ClaudeAI' is a substring of its own href, so a label-only
    // assertion passes even if every sub link pointed at the unscoped all-Reddit search.
    expect(out).toContain(`[r/ClaudeAI](${buildRedditSearchUrl('ClaudeAI', 'is claude down')})`)
    expect(out).toContain(`[all of Reddit](${buildRedditAllSearchUrl('is claude down')})`)
    expect(out).toContain('1 link-comment per thread')
    // The reply link is the entire point of the block — assert it on the string that reaches Discord,
    // not just on the target object. Dropping it from the renderer must fail here.
    expect(out).toContain('https://ai-watch.dev/is-claude-api-down?e=reddit&utm_source=reddit')
  })

  it('defuses a domain-shaped service name so Discord does not unfurl it (#535)', () => {
    const out = appendRedditSection(
      'base',
      buildRedditEngageTargets(alert({ svcIds: ['claudeai'] }), [mockService({ id: 'claudeai', name: 'claude.ai' })]),
      DIV,
    )
    expect(out).toContain('claude ai:')
    expect(out).not.toMatch(/→ claude\.ai:/)
  })

  it('renders every service of a merged multi-service alert, each with its own reply link', () => {
    const out = appendRedditSection(
      'base',
      buildRedditEngageTargets(alert({ svcIds: ['claude', 'claudeai'] }), [
        mockService(),
        mockService({ id: 'claudeai', name: 'claude.ai' }),
      ]),
      DIV,
    )
    expect(out).toContain('/is-claude-api-down')
    expect(out).toContain('/is-claude-ai-down')
    expect(out.match(/all of Reddit/g)).toHaveLength(2)
  })

  it('is a no-op with no targets (so an advisory alert renders no Reddit block at all)', () => {
    expect(appendRedditSection('base', [], DIV)).toBe('base')
  })

  it('drops the per-sub links — but never the caps line — when the full block does not fit', () => {
    const targets = buildRedditEngageTargets(alert(), [mockService()])
    const fullLen = appendRedditSection('', targets, DIV).length
    const leanLen = fullLen - targets[0].subs.map((s) => `[r/${s.subreddit}](${s.url})`).join(' · ').length - 3
    // Sized so the lean variant fits and the full one does not.
    const base = 'x'.repeat(DISCORD_EMBED_DESC_MAX - 16 - leanLen)
    const out = appendRedditSection(base, targets, DIV)
    expect(out).not.toBe(base) // something was appended — the ladder did not collapse to "drop"
    expect(out).toContain('all of Reddit') // the tail stays reachable
    expect(out).toContain('1 link-comment per thread') // the caps line is never traded away
    expect(out).not.toContain('r/ClaudeAI')
    expect(out.length).toBeLessThanOrEqual(DISCORD_EMBED_DESC_MAX)
  })

  it('drops the whole section rather than overflow the embed cap', () => {
    const targets = buildRedditEngageTargets(alert(), [mockService()])
    const tooLong = 'x'.repeat(DISCORD_EMBED_DESC_MAX - 1)
    expect(appendRedditSection(tooLong, targets, DIV)).toBe(tooLong)
  })
})

// The #475 operator-only boundary is NOT pinned here. buildFeedEntry copies its `description`
// argument verbatim, so a test that hands it a clean literal and asserts the literal lacks the
// Reddit markers is asserting a property of its own input — no change to this feature could fail
// it. The real seam is index.ts's call ORDER, pinned at source level in reddit-engage-wiring.test.ts.
