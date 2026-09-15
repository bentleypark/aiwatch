// #1417 — operator-only Bluesky reply assist on incident alerts, the Bluesky twin of the #1182 Reddit block.
import { describe, it, expect } from 'vitest'
import {
  TWEET_SEARCH_TERMS,
  buildBlueskySearchUrl,
  buildBlueskyEngageTargets,
  appendBlueskySection,
  DISCORD_EMBED_DESC_MAX,
} from '../alerts'
import type { AlertCandidate, ScoredService } from '../alerts'
import { classifyReferrer } from '../outage-audience'

function mockService(overrides: Partial<ScoredService> = {}): ScoredService {
  return {
    id: 'claude',
    name: 'Claude API',
    provider: 'Anthropic',
    category: 'api',
    status: 'down',
    statusUrl: 'https://status.claude.com',
    incidents: [{ id: 'inc1', title: 'API errors', status: 'investigating', startedAt: '2026-09-15T00:00:00Z', impact: 'major' } as any],
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
const CLAUDE_LINK = 'https://ai-watch.dev/is-claude-api-down?e=bsky&utm_source=bsky&utm_medium=social&utm_campaign=outage'

describe('buildBlueskyEngageTargets', () => {
  it('builds the search URL and the utm_source=bsky reply link for the alert service', () => {
    expect(buildBlueskyEngageTargets(alert(), [mockService()])).toEqual([
      {
        serviceId: 'claude',
        serviceName: 'Claude API',
        searchUrl: `https://bsky.app/search?q=${encodeURIComponent('is claude down')}`,
        replyLink: CLAUDE_LINK,
      },
    ])
  })

  it('tags the reply link so a visit through it classifies into the bsky bucket', () => {
    const [t] = buildBlueskyEngageTargets(alert(), [mockService()])
    const utm = new URL(t.replyLink).searchParams.get('utm_source') ?? undefined
    expect(classifyReferrer(utm, '')).toBe('bsky')
  })

  it('covers every TWEET_SEARCH_TERMS service', () => {
    for (const id of Object.keys(TWEET_SEARCH_TERMS)) {
      const [t] = buildBlueskyEngageTargets(alert({ svcIds: [id] }), [mockService({ id, name: id })])
      expect(t?.replyLink, `replyLink for '${id}'`).toContain('utm_source=bsky')
    }
  })

  it('collapses 2+ surfaces of one provider family onto the group page (#1193)', () => {
    const out = buildBlueskyEngageTargets(alert({ svcIds: ['claude', 'claudeai'] }), [
      mockService(),
      mockService({ id: 'claudeai', name: 'claude.ai' }),
    ])
    expect(out.map((t) => t.serviceId)).toEqual(['family:claude'])
    expect(out[0].replyLink).toBe('https://ai-watch.dev/is-claude-down?e=bsky&utm_source=bsky&utm_medium=social&utm_campaign=outage')
  })

  it('skips out-of-scope services', () => {
    expect(buildBlueskyEngageTargets(alert({ svcIds: ['mistral'] }), [mockService({ id: 'mistral' })])).toEqual([])
  })

  it('returns nothing for an advisory or a withdrawn incident', () => {
    expect(buildBlueskyEngageTargets(alert({ advisory: true }), [mockService()])).toEqual([])
    expect(buildBlueskyEngageTargets(alert({ key: 'alerted:wd:inc1', svcIds: ['claude'] }), [mockService()])).toEqual([])
  })
})

describe('buildBlueskySearchUrl', () => {
  it('encodes the phrase', () => {
    expect(buildBlueskySearchUrl('is claude.ai down')).toBe('https://bsky.app/search?q=is%20claude.ai%20down')
  })
})

describe('appendBlueskySection', () => {
  it('renders the header, a clickable search link and the reply link as inline code (#1202)', () => {
    const out = appendBlueskySection('base', buildBlueskyEngageTargets(alert(), [mockService()]), DIV)
    expect(out).toContain('FIND BLUESKY POSTS TO REPLY TO')
    expect(out).toContain(`[search Bluesky](${buildBlueskySearchUrl('is claude down')})`)
    expect(out).toContain(`\`${CLAUDE_LINK}\``)
    expect(out).not.toMatch(/🔗 https:\/\/ai-watch\.dev\/[^`\n]*$/m)
  })

  it('defuses a domain-shaped service name (#535)', () => {
    const out = appendBlueskySection(
      'base',
      buildBlueskyEngageTargets(alert({ svcIds: ['claudeai'] }), [mockService({ id: 'claudeai', name: 'claude.ai' })]),
      DIV,
    )
    expect(out).toContain('claude ai:')
  })

  it('is a no-op with no targets', () => {
    expect(appendBlueskySection('base', [], DIV)).toBe('base')
  })

  it('drops the whole section rather than overflow the embed cap', () => {
    const targets = buildBlueskyEngageTargets(alert(), [mockService()])
    const tooLong = 'x'.repeat(DISCORD_EMBED_DESC_MAX - 1)
    expect(appendBlueskySection(tooLong, targets, DIV)).toBe(tooLong)
  })
})
