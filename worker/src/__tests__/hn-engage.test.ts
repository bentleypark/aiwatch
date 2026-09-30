// #1548 — operator-only Hacker News reply assist + per-platform copyable reply drafts.
import { describe, it, expect } from 'vitest'
import {
  TWEET_SEARCH_TERMS,
  HN_SEARCH_TERMS,
  FAMILY_OF_SERVICE,
  buildHnSearchUrl,
  buildHnEngageTargets,
  appendHnSection,
  buildEngageReplyDrafts,
  DISCORD_EMBED_DESC_MAX,
} from '../alerts'
import type { AlertCandidate, ScoredService } from '../alerts'
import { classifyReferrer } from '../outage-audience'

const INCIDENT = {
  id: 'inc1',
  title: 'Elevated errors on claude.ai, Claude Code and the Claude API',
  status: 'investigating',
  startedAt: '2026-09-29T14:21:37.188Z',
  impact: 'major',
} as any

function mockService(overrides: Partial<ScoredService> = {}): ScoredService {
  return {
    id: 'claude',
    name: 'Claude API',
    provider: 'Anthropic',
    category: 'api',
    status: 'down',
    statusUrl: 'https://status.claude.com',
    incidents: [INCIDENT],
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
    svcIds: ['claude'],
    ...overrides,
  }
}

const DIV = '━━━'
const CLAUDE_HN_LINK = 'https://ai-watch.dev/is-claude-api-down?e=hn&utm_source=hn&utm_medium=social&utm_campaign=outage'
const FAMILY = [mockService(), mockService({ id: 'claudeai', name: 'claude.ai', category: 'app' }), mockService({ id: 'claudecode', name: 'Claude Code', category: 'agent' })]

describe('buildHnSearchUrl', () => {
  it('opens stories from the last 24h, newest first', () => {
    expect(buildHnSearchUrl('claude')).toBe(
      'https://hn.algolia.com/?dateRange=last24h&page=0&prefix=false&query=claude&sort=byDate&type=story',
    )
  })
})

describe('buildHnEngageTargets', () => {
  it('builds the search URL and the utm_source=hn reply link for the alert service', () => {
    const [t] = buildHnEngageTargets(alert(), [mockService()])
    expect(t.searchUrl).toBe(buildHnSearchUrl('claude'))
    expect(t.replyLink).toBe(CLAUDE_HN_LINK)
  })

  it('tags the reply link so a visit through it classifies into the hn bucket', () => {
    const [t] = buildHnEngageTargets(alert(), [mockService()])
    expect(classifyReferrer(new URL(t.replyLink).searchParams.get('utm_source') ?? undefined, undefined)).toBe('hn')
  })

  it('has a term for every TWEET_SEARCH_TERMS service and every in-scope family', () => {
    for (const id of Object.keys(TWEET_SEARCH_TERMS)) {
      expect(HN_SEARCH_TERMS[id], `HN term for '${id}'`).toBeTruthy()
      const family = FAMILY_OF_SERVICE[id]
      if (family) expect(HN_SEARCH_TERMS[family.slug], `HN term for family '${family.slug}'`).toBeTruthy()
    }
  })

  it('collapses a family onto the group page and searches the family term', () => {
    const out = buildHnEngageTargets(alert({ svcIds: ['claude', 'claudeai'] }), FAMILY)
    expect(out.map((t) => t.serviceId)).toEqual(['family:claude'])
    expect(out[0].replyLink).toBe('https://ai-watch.dev/is-claude-down?e=hn&utm_source=hn&utm_medium=social&utm_campaign=outage')
    const openai = buildHnEngageTargets(alert({ svcIds: ['chatgpt', 'codex'] }), [
      mockService({ id: 'chatgpt', name: 'ChatGPT', provider: 'OpenAI' }),
      mockService({ id: 'codex', name: 'Codex', provider: 'OpenAI' }),
    ])
    expect(openai[0].searchUrl).toBe(buildHnSearchUrl(HN_SEARCH_TERMS.openai))
  })

  it('a single surface searches its own term', () => {
    const [t] = buildHnEngageTargets(alert({ svcIds: ['codex'] }), [mockService({ id: 'codex', name: 'Codex', provider: 'OpenAI' })])
    expect(t.searchUrl).toBe(buildHnSearchUrl('codex'))
  })

  it('returns nothing for an out-of-scope service, an advisory or a withdrawn incident', () => {
    expect(buildHnEngageTargets(alert({ svcIds: ['mistral'] }), [mockService({ id: 'mistral' })])).toEqual([])
    expect(buildHnEngageTargets(alert({ advisory: true }), [mockService()])).toEqual([])
    expect(buildHnEngageTargets(alert({ key: 'alerted:wd:inc1' }), [mockService()])).toEqual([])
  })
})

describe('appendHnSection', () => {
  const targets = buildHnEngageTargets(alert(), [mockService()])

  it('renders the header, the search link, the reply link as inline code, and the norms line', () => {
    const out = appendHnSection('desc', targets, DIV)
    expect(out).toContain('📰 **FIND HACKER NEWS THREADS TO REPLY TO**')
    expect(out).toContain(`[search Hacker News](${buildHnSearchUrl('claude')})`)
    expect(out).toContain(`\`${CLAUDE_HN_LINK}\``)
    expect(out).toContain('⚖️ data-first comment · one link · no promo wording')
  })

  it('is a no-op with no targets', () => {
    expect(appendHnSection('desc', [], DIV)).toBe('desc')
  })

  it('drops the whole section rather than overflow the embed cap', () => {
    const full = 'x'.repeat(DISCORD_EMBED_DESC_MAX - 20)
    expect(appendHnSection(full, targets, DIV)).toBe(full)
  })
})

describe('buildEngageReplyDrafts', () => {
  const EMOJI = /\p{Extended_Pictographic}/u

  it('builds one draft per platform, each with its own tagged link', () => {
    const drafts = buildEngageReplyDrafts(alert(), [mockService()])
    expect(drafts.map((d) => d.platform)).toEqual(['reddit', 'bsky', 'hn'])
    expect(drafts[0].text).toContain('utm_source=reddit')
    expect(drafts[1].text).toContain('utm_source=bsky')
    expect(drafts[2].text).toContain('utm_source=hn')
  })

  it('uses only the alert data', () => {
    const [reddit, bsky, hn] = buildEngageReplyDrafts(alert(), [mockService()])
    expect(reddit.text).toBe(
      'Not just you — Claude API is down right now, and the official status page lists an open incident. Live status and affected components: https://ai-watch.dev/is-claude-api-down?e=reddit&utm_source=reddit&utm_medium=social&utm_campaign=outage',
    )
    expect(bsky.text).toBe(
      'Not just you — Claude API is down right now. Live status: https://ai-watch.dev/is-claude-api-down?e=bsky&utm_source=bsky&utm_medium=social&utm_campaign=outage',
    )
    expect(hn.text).toBe(
      `The Anthropic status page lists an open incident: "${INCIDENT.title}". Affected: Claude API. Live per-surface status: ${CLAUDE_HN_LINK}`,
    )
  })

  it('never states a start time, so a backdated provider startedAt cannot make a draft false (#1330)', () => {
    const backdated = mockService({ incidents: [{ ...INCIDENT, startedAt: '2026-09-28T14:21:00Z' }] })
    for (const d of buildEngageReplyDrafts(alert(), [backdated])) {
      expect(d.text).not.toMatch(/UTC|since/)
    }
  })

  it('neutralises a mass mention in the incident title', () => {
    const svc = mockService({ incidents: [{ ...INCIDENT, title: 'Errors @everyone' }] })
    const hn = buildEngageReplyDrafts(alert(), [svc]).find((d) => d.platform === 'hn')!
    expect(hn.text).not.toContain('@everyone')
  })

  it('says "down" when any family member is down', () => {
    const mixed = [mockService({ status: 'degraded' }), mockService({ id: 'claudeai', name: 'claude.ai', status: 'down' })]
    const [reddit] = buildEngageReplyDrafts(alert({ svcIds: ['claude', 'claudeai'] }), mixed)
    expect(reddit.text).toContain('Anthropic (Claude) is down right now')
  })

  it('names every family member on HN and links the group page', () => {
    const drafts = buildEngageReplyDrafts(alert({ svcIds: ['claude'], priorSvcIds: ['claudeai', 'claudecode'] }), FAMILY)
    const hn = drafts.find((d) => d.platform === 'hn')!
    expect(hn.text).toContain('Affected: Claude API, claude.ai, Claude Code.')
    expect(hn.text).toContain('https://ai-watch.dev/is-claude-down?e=hn')
  })

  it('says "having issues" when no member is down', () => {
    const [reddit] = buildEngageReplyDrafts(alert(), [mockService({ status: 'degraded' })])
    expect(reddit.text).toContain('Claude API is having issues right now,')
  })

  it('keeps Bluesky within 300 characters and HN free of emoji', () => {
    const long = mockService({ name: 'A'.repeat(250) })
    const drafts = buildEngageReplyDrafts(alert(), [long])
    const bsky = drafts.find((d) => d.platform === 'bsky')
    if (bsky) expect([...bsky.text].length).toBeLessThanOrEqual(300)
    for (const d of buildEngageReplyDrafts(alert(), FAMILY)) {
      if (d.platform === 'hn') expect(d.text).not.toMatch(EMOJI)
      if (d.platform === 'bsky') expect([...d.text].length).toBeLessThanOrEqual(300)
    }
  })

  it('defuses a domain-shaped name on Reddit and Bluesky (#535)', () => {
    const drafts = buildEngageReplyDrafts(alert({ svcIds: ['claudeai'] }), [mockService({ id: 'claudeai', name: 'claude.ai' })])
    expect(drafts.find((d) => d.platform === 'reddit')!.text).toContain('claude ai is down')
    expect(drafts.find((d) => d.platform === 'bsky')!.text).toContain('claude ai is down')
  })

  it('omits the title when the incident is not on any service', () => {
    const hn = buildEngageReplyDrafts(alert({ key: 'alerted:new:missing' }), [mockService()]).find((d) => d.platform === 'hn')!
    expect(hn.text).toContain('The Anthropic status page lists an open incident. Affected: Claude API.')
  })

  it('returns nothing for a resolved alert, an advisory, a withdrawal or an out-of-scope service', () => {
    expect(buildEngageReplyDrafts(alert({ key: 'alerted:res:inc1' }), [mockService()])).toEqual([])
    expect(buildEngageReplyDrafts(alert({ key: 'alerted:recovered:claude' }), [mockService({ status: 'operational' })])).toEqual([])
    expect(buildEngageReplyDrafts(alert({ key: 'alerted:down:claude' }), [mockService()])).toEqual([])
    expect(buildEngageReplyDrafts(alert({ key: 'alerted:degraded:claude' }), [mockService({ status: 'degraded' })])).toEqual([])
    expect(buildEngageReplyDrafts(alert({ advisory: true }), [mockService()])).toEqual([])
    expect(buildEngageReplyDrafts(alert({ key: 'alerted:wd:inc1' }), [mockService()])).toEqual([])
    expect(buildEngageReplyDrafts(alert({ svcIds: ['mistral'] }), [mockService({ id: 'mistral' })])).toEqual([])
  })
})
