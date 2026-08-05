// #1182 — operator-only Reddit engagement links on incident alerts. The Reddit twin of the #777
// X-search block: same svcIds resolution, same non-outage gate, same operator-only boundary.
import { describe, it, expect, vi } from 'vitest'
import {
  REDDIT_ENGAGE_SUBS,
  TWEET_SEARCH_TERMS,
  FAMILY_OF_SERVICE,
  buildRedditSearchUrl,
  buildRedditAllSearchUrl,
  buildRedditEngageTargets,
  mergeFamilySubs,
  appendRedditSection,
  DISCORD_EMBED_DESC_MAX,
} from '../alerts'
import type { AlertCandidate, ScoredService } from '../alerts'
import { SERVICES } from '../services'
import { SERVICE_ID_TO_SLUG, FAMILY_GROUPS } from '../../../api/_is-down/slug-map'

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

  it('collapses 2+ surfaces of ONE provider family into a single target (#1193)', () => {
    const out = buildRedditEngageTargets(
      alert({ svcIds: ['claude', 'claudeai'] }),
      [mockService(), mockService({ id: 'claudeai', name: 'claude.ai' })],
    )
    expect(out.map((t) => t.serviceId)).toEqual(['family:claude'])
    expect(out[0].serviceName).toBe('Anthropic (Claude)')
    // The GROUP page, not either surface's own — problem 2 of #1193. Asserted as the whole URL so
    // that keeping the collapse while still linking a single surface fails here.
    expect(out[0].replyLink).toBe(
      'https://ai-watch.dev/is-claude-down?e=reddit&utm_source=reddit&utm_medium=social&utm_campaign=outage',
    )
    expect(out[0].term).toBe('is claude down')
  })

  it('keeps a lone surface of a family on its OWN page — the collapse needs 2+ members', () => {
    // Guards the other direction of the #1193 rule: over-eager collapsing would send a claude.ai-only
    // incident to the group page, which claims two surfaces are affected when one is.
    const out = buildRedditEngageTargets(alert({ svcIds: ['claudeai'] }), [
      mockService({ id: 'claudeai', name: 'claude.ai' }),
    ])
    expect(out.map((t) => t.serviceId)).toEqual(['claudeai'])
    expect(out[0].replyLink).toContain('/is-claude-ai-down')
  })

  it('does NOT collapse across providers — one line per family, plus family-less services', () => {
    const out = buildRedditEngageTargets(
      alert({ svcIds: ['claude', 'claudeai', 'openai', 'chatgpt', 'gemini'] }),
      [
        mockService(),
        mockService({ id: 'claudeai', name: 'claude.ai' }),
        mockService({ id: 'openai', name: 'OpenAI API' }),
        mockService({ id: 'chatgpt', name: 'ChatGPT' }),
        mockService({ id: 'gemini', name: 'Gemini API' }),
      ],
    )
    // gemini is in no FAMILY_GROUPS family, so it must survive as its own line — a collapse keyed on
    // "is this a multi-service alert" instead of on family membership would swallow it.
    expect(out.map((t) => t.serviceId)).toEqual(['family:claude', 'family:openai', 'gemini'])
    expect(out[2].replyLink).toContain('/is-gemini-down')
  })

  it('leaves no collapsed surface without a community — every family, not just the Claude one', () => {
    // A property over the real config rather than two hardcoded names: for EVERY family, each
    // covered member must still be represented by at least one of its own subs on the merged line.
    // Written this way because the hardcoded version passed for reasons that were true of the data
    // rather than of the algorithm, and because a family growing past the sub cap is the exact
    // regression #1193 fixed, arriving by a different route.
    for (const family of Object.values(FAMILY_GROUPS)) {
      const members = family.members.filter((id) => REDDIT_ENGAGE_SUBS[id] && TWEET_SEARCH_TERMS[id])
      if (members.length < 2) continue
      const [t, ...rest] = buildRedditEngageTargets(
        alert({ svcIds: members }),
        members.map((id) => mockService({ id, name: id })),
      )
      expect(rest, `${family.slug} did not collapse to one line`).toHaveLength(0)
      const rendered = new Set(t.subs.map((s) => s.subreddit))
      expect(new Set(t.subs.map((s) => s.subreddit)).size).toBe(t.subs.length) // no duplicates
      for (const m of members) {
        expect(
          REDDIT_ENGAGE_SUBS[m].some((s) => rendered.has(s)),
          `'${m}' has no community on the ${family.slug} line`,
        ).toBe(true)
      }
      // Internally consistent: every link on the line searches the SAME phrase.
      for (const s of t.subs) expect(s.url).toBe(buildRedditSearchUrl(s.subreddit, t.term))
      expect(t.allRedditUrl).toBe(buildRedditAllSearchUrl(t.term))
    }
  })

  it("uses the FAMILY's phrase even when the family-slug surface is not among the covered ones", () => {
    // The #545 joiner shape: Claude API already alerted, so a later alert's svcIds carries only the
    // surfaces that JOINED. memberIds[0] is then 'claudeai', whose own phrase is "is claude.ai down"
    // — reading the first member's term instead of the family's would search a single surface's
    // phrase on behalf of the whole provider, and every family test that lists the slug-matching
    // member first is blind to it.
    const [t] = buildRedditEngageTargets(alert({ svcIds: ['claudeai', 'claudecode'] }), [
      mockService({ id: 'claudeai', name: 'claude.ai' }),
      mockService({ id: 'claudecode', name: 'Claude Code' }),
    ])
    expect(t.term).toBe('is claude down')
    expect(t.allRedditUrl).toBe(buildRedditAllSearchUrl('is claude down'))
    for (const s of t.subs) expect(s.url).toBe(buildRedditSearchUrl(s.subreddit, 'is claude down'))
  })

  it('searches the OpenAI family with the provider phrase, not ChatGPT\'s', () => {
    // Recorded deliberately because it is a real trade, not an accident: collapsing chatgpt+codex
    // discards "is chatgpt down", the higher-volume phrase, in favour of the provider-wide one.
    // Asserted so the trade is reviewable rather than implicit.
    const [t] = buildRedditEngageTargets(alert({ svcIds: ['chatgpt', 'codex'] }), [
      mockService({ id: 'chatgpt', name: 'ChatGPT' }),
      mockService({ id: 'codex', name: 'Codex' }),
    ])
    expect(t.term).toBe('is openai down')
  })

  it('falls back to per-surface lines — loudly — if a family slug has no search phrase', () => {
    // Exercised through the shape that would actually produce it. No member of the xai family
    // (`xai`/`grok`/`cursor`) is in Reddit scope today and `TWEET_SEARCH_TERMS` has no `xai` entry,
    // so bringing any two members into scope — which is what adding a new surface does — yields a
    // family with no phrase of its own. The branch must then degrade to the per-surface lines it
    // replaced (correct, already tested) and say so, rather than silently searching one surface's
    // phrase on behalf of the whole provider.
    const subs = REDDIT_ENGAGE_SUBS as Record<string, readonly string[]>
    const terms = TWEET_SEARCH_TERMS as Record<string, string>
    // Asserted, not assumed: if grok/cursor ever genuinely enter scope, this test must fail loudly
    // rather than overwrite the real config and then delete it out from under every later test in
    // this file — the sibling below derives its expectations from these very maps.
    for (const id of ['grok', 'cursor']) {
      expect(subs[id], `'${id}' is now in scope — rewrite this test instead of shadowing it`).toBeUndefined()
      expect(terms[id], `'${id}' is now in scope — rewrite this test instead of shadowing it`).toBeUndefined()
    }
    expect(terms.xai, 'xai gained a search phrase — this branch is no longer reachable this way').toBeUndefined()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    subs.grok = ['grok']
    subs.cursor = ['cursor']
    terms.grok = 'is grok down'
    terms.cursor = 'is cursor down'
    try {
      const out = buildRedditEngageTargets(alert({ svcIds: ['grok', 'cursor'] }), [
        mockService({ id: 'grok', name: 'Grok' }),
        mockService({ id: 'cursor', name: 'Cursor' }),
      ])
      expect(out.map((t) => t.serviceId)).toEqual(['grok', 'cursor'])
      // Once per FAMILY, carrying the alert key — a per-member warn would repeat every cron tick,
      // and a warn with no key cannot be tied back to an incident.
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('#1193'), 'xai', 'alerted:new:inc1')
    } finally {
      delete subs.grok
      delete subs.cursor
      delete terms.grok
      delete terms.cursor
      warn.mockRestore()
    }
  })

  it('every family slug that can reach the collapse is itself a keyed service', () => {
    // TWEET_SEARCH_TERMS is keyed by SERVICE ID; family.slug is a URL slug. Indexing one with the
    // other is valid only while a reachable family's slug is also one of its own members' ids. Those
    // namespaces have already diverged elsewhere in this file (SERVICE_ID_TO_SLUG.claude is
    // 'claude-api'), so this is pinned rather than left to the strings continuing to coincide — and
    // a family that breaks it degrades via the warn above rather than silently.
    const familySlugs = new Set(
      Object.keys(REDDIT_ENGAGE_SUBS)
        .map((id) => FAMILY_OF_SERVICE[id]?.slug)
        .filter((s): s is string => !!s),
    )
    expect(familySlugs.size).toBeGreaterThan(0)
    for (const slug of familySlugs) {
      expect(FAMILY_GROUPS[slug]?.members, `family '${slug}' members`).toContain(slug)
      expect(TWEET_SEARCH_TERMS[slug], `term for family '${slug}'`).toBeTruthy()
    }
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

describe('mergeFamilySubs', () => {
  // Exercised directly: through the public builder only the shapes today's FAMILY_GROUPS happens to
  // produce are reachable, and these are meant to hold for the shapes it will produce.
  it("round-robins by index: every member's first sub before any member's second", () => {
    expect(mergeFamilySubs([['a1', 'a2', 'a3'], ['b1'], ['c1']])).toEqual(['a1', 'b1', 'c1'])
  })

  it('raises the cap to the member count so a 4th member still gets a slot', () => {
    // Under a fixed cap of 3 the 4th member never got one — the same "a surface's community is
    // unsearched and the line still looks right" failure #1193 fixed, re-entering by another route.
    // Both in-scope families already sit at exactly 3 members, so this is one surface away.
    expect(mergeFamilySubs([['a1', 'a2'], ['b1'], ['c1'], ['d1']])).toEqual(['a1', 'b1', 'c1', 'd1'])
  })

  it('keeps its floor when there are fewer members than the floor', () => {
    expect(mergeFamilySubs([['a1', 'a2', 'a3', 'a4'], ['b1']])).toEqual(['a1', 'b1', 'a2'])
  })

  it('dedupes across members and tolerates a short list', () => {
    expect(mergeFamilySubs([['x', 'y'], ['x'], ['x', 'z']])).toEqual(['x', 'y', 'z'])
  })

  it('is lossy when members share a sub — a distinct one can lose its slot to the shared one', () => {
    // Recorded because it is the limit of the round-robin, not a bug to fix silently: a member whose
    // first sub is already taken does not advance within the round, so the cap can be reached before
    // its distinct sub is considered. `b` is dropped here. The render still names every member's
    // community in the sense that matters (each is represented by a sub of its own list), which is
    // what the family property test asserts — but "every member contributes a DISTINCT sub" is false
    // and must not be claimed.
    expect(mergeFamilySubs([['x', 'a'], ['x', 'b'], ['c'], ['d']])).toEqual(['x', 'c', 'd', 'a'])
  })

  it('returns empty for no members', () => {
    expect(mergeFamilySubs([])).toEqual([])
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

  it('renders ONE line with the group link for a same-family multi-surface alert (#1193)', () => {
    const out = appendRedditSection(
      'base',
      buildRedditEngageTargets(alert({ svcIds: ['claude', 'claudeai', 'claudecode'] }), [
        mockService(),
        mockService({ id: 'claudeai', name: 'claude.ai' }),
        mockService({ id: 'claudecode', name: 'Claude Code' }),
      ]),
      DIV,
    )
    expect(out.match(/all of Reddit/g)).toHaveLength(1)
    expect(out).toContain('Anthropic (Claude):')
    // Whole hrefs, not labels: `all of Reddit` is a label that survives any href regression, and the
    // reply link must carry the backticks on the family path too — the two #1193 changes intersect
    // exactly here.
    expect(out).toContain(`[all of Reddit](${buildRedditAllSearchUrl('is claude down')})`)
    expect(out).toContain(
      '`https://ai-watch.dev/is-claude-down?e=reddit&utm_source=reddit&utm_medium=social&utm_campaign=outage`',
    )
    // The three per-surface pages the operator was previously handed must be GONE, not merely
    // joined by a group line — the redundancy is the whole complaint in #1193.
    expect(out).not.toContain('/is-claude-api-down')
    expect(out).not.toContain('/is-claude-ai-down')
    expect(out).not.toContain('/is-claude-code-down')
  })

  it('renders one line per provider when an alert spans two families', () => {
    const out = appendRedditSection(
      'base',
      buildRedditEngageTargets(alert({ svcIds: ['claude', 'claudeai', 'openai', 'chatgpt'] }), [
        mockService(),
        mockService({ id: 'claudeai', name: 'claude.ai' }),
        mockService({ id: 'openai', name: 'OpenAI API' }),
        mockService({ id: 'chatgpt', name: 'ChatGPT' }),
      ]),
      DIV,
    )
    expect(out.match(/all of Reddit/g)).toHaveLength(2)
    expect(out).toContain('/is-claude-down?e=reddit')
    expect(out).toContain('/is-openai-down?e=reddit')
  })

  it('renders the reply link as INLINE CODE so an operator click cannot enter the reddit bucket', () => {
    // Not cosmetic. The link carries utm_source=reddit — the one signal classifyReferrer uses to
    // attribute a visit to the #270 channel — so a clickable link in the OPERATOR's own alert books
    // operator clicks as Reddit inbound, in the same bucket as real visitors and inseparable from
    // them afterwards. Both directions asserted: the backticked form present, AND the bare
    // auto-linking form absent (Discord auto-links any bare URL, so its mere presence re-opens the
    // click path even if a backticked copy sits beside it).
    const out = appendRedditSection('base', buildRedditEngageTargets(alert(), [mockService()]), DIV)
    const link = 'https://ai-watch.dev/is-claude-api-down?e=reddit&utm_source=reddit&utm_medium=social&utm_campaign=outage'
    expect(out).toContain(`\`${link}\``)
    expect(out).not.toContain(`🔗 ${link}\n`)
    expect(out).not.toMatch(/🔗 https:\/\/ai-watch\.dev\/[^`\n]*$/m)
    // The subreddit links stay clickable — they navigate to Reddit, not to us, so they touch no bucket.
    expect(out).toContain(`[r/ClaudeAI](${buildRedditSearchUrl('ClaudeAI', 'is claude down')})`)
  })

  it('renders no separator for a target carrying no subs', () => {
    // Built by hand rather than through buildRedditEngageTargets, which cannot produce an empty sub
    // list today — so the guard's default state is "passes" and only a literal target reaches it.
    const t = {
      serviceId: 'x',
      serviceName: 'X',
      term: 't',
      subs: [],
      allRedditUrl: 'https://www.reddit.com/search/?q=t',
      replyLink: 'https://ai-watch.dev/is-x-down',
    }
    const out = appendRedditSection('base', [t], DIV)
    expect(out).toContain('→ X: [all of Reddit]')
    expect(out).not.toContain(': · ')
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
    // The reply link is what the block exists for, and the lean rung is where a length-pressed edit
    // would shave next — so it is pinned as surviving, backticks and all.
    expect(out).toContain('`https://ai-watch.dev/is-claude-api-down?e=reddit')
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
