// #777 — operator-only "find tweets to reply to" X Top-tab search links on incident alerts.
import { describe, it, expect } from 'vitest'
import {
  buildTweetSearchUrl,
  buildTweetSearches,
  buildReplyDraft,
  appendTweetSearchSection,
  DISCORD_EMBED_DESC_MAX,
} from '../alerts'
import type { AlertCandidate, ScoredService } from '../alerts'

function mockService(overrides: Partial<ScoredService> = {}): ScoredService {
  return {
    id: 'claude',
    name: 'Claude API',
    provider: 'Anthropic',
    category: 'api',
    status: 'down',
    statusUrl: 'https://status.claude.com',
    incidents: [{ id: 'inc1', title: 'API errors', status: 'investigating', startedAt: '2026-06-23T00:00:00Z', impact: 'major' } as any],
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

describe('buildTweetSearchUrl', () => {
  it('builds the URL-encoded Top-sorted search link from the plain natural-phrase query', () => {
    const url = buildTweetSearchUrl('claude')
    expect(url).toBe(`https://x.com/search?q=${encodeURIComponent('is claude down')}&f=top`)
    expect(url).toContain('&f=top') // engagement-sorted Top tab (the reply target)
  })

  it('uses the natural "is X down" phrasing the operator actually searches (no advanced operators)', () => {
    expect(decodeURIComponent(buildTweetSearchUrl('chatgpt')!)).toContain('is chatgpt down')
    // the over-filtering operators that returned 0 results must be gone
    expect(buildTweetSearchUrl('claude')!).not.toContain('min_faves')
    expect(buildTweetSearchUrl('claude')!).not.toContain('filter')
  })

  it('encodes special chars (no raw space in the URL query)', () => {
    const url = buildTweetSearchUrl('claudeai')!
    expect(decodeURIComponent(url.split('&f=')[0])).toContain('is claude.ai down')
    expect(url.split('&f=')[0]).not.toMatch(/ /) // no raw space in the query
  })

  it('returns null for an out-of-scope service', () => {
    expect(buildTweetSearchUrl('mistral')).toBeNull()
    expect(buildTweetSearchUrl('not-a-service')).toBeNull()
  })

  it('covers gemini (broader than the tweet-draft scope)', () => {
    expect(buildTweetSearchUrl('gemini')).not.toBeNull()
  })
})

describe('buildTweetSearches', () => {
  it('returns one entry for a single in-scope service alert', () => {
    const searches = buildTweetSearches(alert(), [mockService()])
    expect(searches).toHaveLength(1)
    expect(searches[0]).toMatchObject({ serviceId: 'claude', serviceName: 'Claude API' })
    expect(searches[0].url).toContain('&f=top')
  })

  it('skips out-of-scope services', () => {
    const a = alert({ key: 'alerted:down:mistral', title: '🔴 Mistral — Down', svcIds: ['mistral'] })
    expect(buildTweetSearches(a, [mockService({ id: 'mistral', name: 'Mistral API' })])).toEqual([])
  })

  it('emits one entry per in-scope service for a grouped multi-surface incident', () => {
    const a = alert({ svcIds: ['claude', 'claudeai', 'claudecode'] })
    const services = [
      mockService({ id: 'claude', name: 'Claude API' }),
      mockService({ id: 'claudeai', name: 'claude.ai' }),
      mockService({ id: 'claudecode', name: 'Claude Code' }),
    ]
    const searches = buildTweetSearches(a, services)
    expect(searches.map((s) => s.serviceId)).toEqual(['claude', 'claudeai', 'claudecode'])
  })

  it('dedupes by URL — a repeated svcId collapses to one entry (defensive: distinct ids map to distinct queries today)', () => {
    const a = alert({ svcIds: ['claude', 'claude'] })
    const searches = buildTweetSearches(a, [mockService()])
    expect(searches).toHaveLength(1)
  })
})

describe('buildReplyDraft', () => {
  it('builds one casual reply for the primary in-scope service, with the is-down link + reply-tagged UTM', () => {
    const reply = buildReplyDraft(alert(), [mockService()])
    expect(reply).not.toBeNull()
    expect(reply!.serviceId).toBe('claude')
    expect(reply!.text).toBe(
      '🔴 yes — Claude API is down right now. live status, affected components & recovery ETA → https://ai-watch.dev/is-claude-api-down?e=down&utm_source=x&utm_medium=social&utm_campaign=outage&utm_content=reply&i=inc1',
    )
  })

  it('tags the reply link with utm_content=reply so GA4 splits reply-driven inflow from the 🐦 compose draft', () => {
    const reply = buildReplyDraft(alert(), [mockService()])
    // stays in the shared campaign=outage bucket (total X inflow) but is distinguishable by utm_content
    expect(reply!.text).toContain('utm_campaign=outage&utm_content=reply')
  })

  it('uses degraded phrasing for a degraded service', () => {
    const a = alert({ key: 'alerted:degraded:chatgpt', title: '🟠 ChatGPT — Degraded', svcIds: ['chatgpt'] })
    const reply = buildReplyDraft(a, [mockService({ id: 'chatgpt', name: 'ChatGPT', status: 'degraded' })])
    expect(reply!.text).toMatch(/^🟠 yes — ChatGPT is having issues \(degraded\)/) // #936 status circle
    expect(reply!.text).toContain('having issues (degraded)')
    expect(reply!.text).toContain('https://ai-watch.dev/is-chatgpt-down?e=degraded')
  })

  it('#804 — carries the per-incident token last on a NEW incident reply, omits it for a status-edge alert', () => {
    expect(buildReplyDraft(alert({ key: 'alerted:new:abc123', svcIds: ['claude'] }), [mockService()])!.text)
      .toContain('&utm_content=reply&i=abc123') // appended after the reply UTM
    const edge = alert({ key: 'alerted:down:claude', title: '🔴 Claude API — Down', svcIds: ['claude'] })
    expect(buildReplyDraft(edge, [mockService()])!.text).not.toContain('&i=')
  })

  it('uses recovery phrasing for a resolved alert', () => {
    const a = alert({ key: 'alerted:res:inc1', title: '🟢 Claude API — Resolved', svcIds: ['claude'] })
    const reply = buildReplyDraft(a, [mockService({ status: 'operational' })])
    expect(reply!.text).toMatch(/^🟢 update — Claude API is back up\./)
    expect(reply!.text).toContain('?e=resolved')
  })

  it('picks the primary (first in-scope) service for a grouped incident', () => {
    const a = alert({ svcIds: ['claude', 'claudeai', 'claudecode'] })
    const reply = buildReplyDraft(a, [
      mockService({ id: 'claude', name: 'Claude API' }),
      mockService({ id: 'claudeai', name: 'claude.ai' }),
      mockService({ id: 'claudecode', name: 'Claude Code' }),
    ])
    expect(reply!.serviceId).toBe('claude')
  })

  // #1164 — a grouped same-family incident (2+ TWEET_DRAFT_SERVICES-scoped members covered by the
  // alert) replies with the family's GROUP is-down page, not the single primary surface: the reply
  // targets "is claude down" searches — the bare product-name query — so once more than one surface is
  // affected, the group page is the better answer than a single-surface one.
  it('links + names the family group page for a grouped same-family incident (2+ members covered)', () => {
    const a = alert({ svcIds: ['claude', 'claudeai', 'claudecode'] })
    const reply = buildReplyDraft(a, [
      mockService({ id: 'claude', name: 'Claude API' }),
      mockService({ id: 'claudeai', name: 'claude.ai' }),
      mockService({ id: 'claudecode', name: 'Claude Code' }),
    ])
    expect(reply!.text).toContain('https://ai-watch.dev/is-claude-down?')
    expect(reply!.text).not.toContain('is-claude-api-down')
    expect(reply!.text).toContain('Anthropic (Claude) is down right now')
  })

  it('still links the single surface when only ONE family member is covered by the alert', () => {
    const a = alert({ svcIds: ['claude'] })
    const reply = buildReplyDraft(a, [mockService({ id: 'claude', name: 'Claude API' })])
    expect(reply!.text).toContain('https://ai-watch.dev/is-claude-api-down?')
    expect(reply!.text).not.toContain('is-claude-down')
  })

  it('defuses a bare claude.ai brand in the reply text (operator pastes into X)', () => {
    const a = alert({ key: 'alerted:down:claudeai', title: '🔴 claude.ai — Down', svcIds: ['claudeai'] })
    const reply = buildReplyDraft(a, [mockService({ id: 'claudeai', name: 'claude.ai' })])
    expect(reply!.text).toContain('claude ai is down') // defused, no dot
    expect(reply!.text).not.toMatch(/claude\.ai is down/)
  })

  it('returns null when no in-scope service is covered', () => {
    const a = alert({ key: 'alerted:down:mistral', title: '🔴 Mistral — Down', svcIds: ['mistral'] })
    expect(buildReplyDraft(a, [mockService({ id: 'mistral', name: 'Mistral API' })])).toBeNull()
  })
})

describe('appendTweetSearchSection', () => {
  const DIV = '━━━'
  const replyFor = (a: AlertCandidate, svcs: ScoredService[]) => buildReplyDraft(a, svcs)

  it('returns the description unchanged when there are no searches', () => {
    expect(appendTweetSearchSection('base', [], null, DIV)).toBe('base')
  })

  it('appends a single Top-tweets link + a pointer to the separate reply message (#936)', () => {
    const a = alert()
    const svcs = [mockService()]
    const out = appendTweetSearchSection('base', buildTweetSearches(a, svcs), replyFor(a, svcs), DIV)
    expect(out).toContain('🔎 **FIND TWEETS TO REPLY TO**')
    expect(out).toContain('[🔥 Top tweets](')
    expect(out).toContain('💬 **REPLY DRAFT** in the message below ↓') // pointer, not a code block
    expect(out).not.toContain('```') // #936 — reply moved to a separate plain message (mobile-copyable)
    expect(out).not.toContain('yes — Claude API is down right now.') // reply text is no longer in the embed
    expect(out).not.toContain('Latest') // Top-only (#777)
  })

  it('renders a per-service picker + a single reply for multiple searches', () => {
    const a = alert({ svcIds: ['claude', 'openai'] })
    const svcs = [
      mockService({ id: 'claude', name: 'Claude API' }),
      mockService({ id: 'openai', name: 'OpenAI API' }),
    ]
    const out = appendTweetSearchSection('base', buildTweetSearches(a, svcs), replyFor(a, svcs), DIV)
    expect(out).toContain('pick a service')
    expect(out).toContain('[🔥 Claude API](')
    expect(out).toContain('[🔥 OpenAI API](')
    // one reply pointer only (primary = Claude API), not one per service
    expect(out.match(/💬 \*\*REPLY DRAFT\*\*/g)).toHaveLength(1)
  })

  const five = () => {
    const a = alert({ svcIds: ['claude', 'openai', 'chatgpt', 'codex', 'gemini'] })
    const svcs = [
      mockService({ id: 'claude', name: 'Claude API' }),
      mockService({ id: 'openai', name: 'OpenAI API' }),
      mockService({ id: 'chatgpt', name: 'ChatGPT' }),
      mockService({ id: 'codex', name: 'Codex' }),
      mockService({ id: 'gemini', name: 'Gemini API' }),
    ]
    return { searches: buildTweetSearches(a, svcs), reply: replyFor(a, svcs) }
  }

  it('never exceeds the Discord 4096 limit even when nothing fits (returns base unchanged, keeps the alert)', () => {
    const base = 'x'.repeat(4050)
    const { searches, reply } = five()
    const out = appendTweetSearchSection(base, searches, reply, DIV)
    expect(out.length).toBeLessThanOrEqual(DISCORD_EMBED_DESC_MAX)
    expect(out).toBe(base) // nothing fit → critical alert text is untouched
  })

  it('drops the overflow rows with a "+N more" suffix when only some fit', () => {
    const base = 'x'.repeat(3850)
    const { searches, reply } = five()
    const out = appendTweetSearchSection(base, searches, reply, DIV)
    expect(out.length).toBeLessThanOrEqual(DISCORD_EMBED_DESC_MAX)
    expect(out).toMatch(/\+\d+ more/)
  })

  it('drops the reply pointer first when the section is tight but a link still fits', () => {
    const a = alert()
    const svcs = [mockService()]
    const searches = buildTweetSearches(a, svcs)
    // Size base so the lean section (header + link, no pointer) fits exactly and the pointer overflows.
    const CAP = DISCORD_EMBED_DESC_MAX - 16 // matches the SAFETY headroom inside appendTweetSearchSection
    const leanLen = appendTweetSearchSection('', searches, null, DIV).length
    const base = 'x'.repeat(CAP - leanLen)
    const out = appendTweetSearchSection(base, searches, replyFor(a, svcs), DIV)
    expect(out.length).toBeLessThanOrEqual(DISCORD_EMBED_DESC_MAX)
    expect(out).toContain('[🔥 Top tweets](') // the essential link survived
    expect(out).not.toContain('💬 **REPLY DRAFT**') // the reply pointer was dropped first
  })

  it('multi-service: drops the reply pointer but keeps a service link when tight', () => {
    const a = alert({ svcIds: ['claude', 'openai'] })
    const svcs = [
      mockService({ id: 'claude', name: 'Claude API' }),
      mockService({ id: 'openai', name: 'OpenAI API' }),
    ]
    const searches = buildTweetSearches(a, svcs)
    // Size base so exactly ONE picker link fits WITHOUT the reply pointer, but WITH it none fit →
    // build(true) returns null (0 links), build(false) succeeds. Mirrors the impl's prefix strings.
    const CAP = DISCORD_EMBED_DESC_MAX - 16
    const header = `\n${DIV}\n🔎 **FIND TWEETS TO REPLY TO**`
    const pick = `\n→ pick a service:\n`
    const link0 = `[🔥 Claude API](${searches[0].url})`
    const base = 'x'.repeat(CAP - (header + pick).length - link0.length)
    const out = appendTweetSearchSection(base, searches, replyFor(a, svcs), DIV)
    expect(out.length).toBeLessThanOrEqual(DISCORD_EMBED_DESC_MAX)
    expect(out).toContain('pick a service')
    expect(out).toContain('[🔥 Claude API](')
    expect(out).not.toContain('💬 **REPLY DRAFT**') // reply pointer dropped before the links
  })

  it('single over-limit returns the description unchanged (length guard)', () => {
    const base = 'x'.repeat(4080)
    const a = alert()
    const svcs = [mockService()]
    const out = appendTweetSearchSection(base, buildTweetSearches(a, svcs), replyFor(a, svcs), DIV)
    expect(out).toBe(base)
  })
})

// #475/#777 boundary — the search section is OPERATOR-ONLY: the per-user relay entry is built by
// buildFeedEntry from the CLEAN description (before any draft/search append in index.ts), so it must never
// carry the operator markers. This pins the data contract at the relay-entry layer (index.ts ordering is
// not unit-tested, but this proves buildFeedEntry's stored description excludes the operator sections).
describe('operator-only boundary (#475/#777)', () => {
  const DIV = '━━━'
  it('per-user feed entry excludes the search + draft sections that the operator embed carries', async () => {
    const { buildFeedEntry } = await import('../alert-feed')
    const { appendTweetDraftSection, buildTweetDrafts } = await import('../alerts')
    const a = alert({ svcIds: ['claude'] })
    const services = [mockService()]
    const cleanDescription = '🔴 Claude API — New Incident\nElevated errors\n[View on AIWatch](https://ai-watch.dev/#claude)'

    // operator embed = clean + draft + search (exactly index.ts's assembly order)
    const operatorDescription = appendTweetSearchSection(
      appendTweetDraftSection(cleanDescription, buildTweetDrafts(a, services), DIV),
      buildTweetSearches(a, services),
      buildReplyDraft(a, services),
      DIV,
    )
    expect(operatorDescription).toContain('🔎 **FIND TWEETS TO REPLY TO**')
    expect(operatorDescription).toContain('🐦 **TWEET DRAFT**')
    expect(operatorDescription).toContain('💬 **REPLY DRAFT**')

    // per-user relay entry is built from the CLEAN description → must carry none of the operator sections
    const feedEntry = buildFeedEntry(a, cleanDescription, services, 0)
    expect(feedEntry).not.toBeNull()
    expect(feedEntry!.embed.description).not.toContain('🔎 **FIND TWEETS TO REPLY TO**')
    expect(feedEntry!.embed.description).not.toContain('🐦 **TWEET DRAFT**')
    expect(feedEntry!.embed.description).not.toContain('💬 **REPLY DRAFT**')
  })
})
