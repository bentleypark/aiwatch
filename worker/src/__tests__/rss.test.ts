import { describe, it, expect } from 'vitest'
import { buildRssFeed, feedSlug, resolveFeedService, isValidFeedSegment, buildFeedResponse } from '../rss'
import type { ServiceStatus, Incident } from '../types'

function incident(over: Partial<Incident> = {}): Incident {
  return {
    id: 'inc-1',
    title: 'API errors',
    status: 'investigating',
    impact: 'major',
    startedAt: '2026-05-10T12:00:00.000Z',
    resolvedAt: null,
    duration: null,
    timeline: [],
    ...over,
  }
}

function service(over: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    id: 'claude',
    name: 'Claude',
    provider: 'Anthropic',
    category: 'api',
    status: 'operational',
    latency: null,
    uptime30d: null,
    lastChecked: '2026-05-19T00:00:00.000Z',
    incidents: [],
    ...over,
  }
}

const NOW = new Date('2026-05-19T09:00:00.000Z')

describe('buildRssFeed — all scope', () => {
  it('emits a well-formed RSS 2.0 envelope', () => {
    const xml = buildRssFeed([], { scope: 'all' }, NOW)
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('<rss version="2.0"')
    expect(xml).toContain('<channel>')
    expect(xml).toContain('<title>AIWatch — AI Service Incidents</title>')
    expect(xml).toContain('<atom:link href="https://ai-watch.dev/feed.xml" rel="self"')
    expect(xml).toContain(`<lastBuildDate>${NOW.toUTCString()}</lastBuildDate>`)
    expect(xml.trimEnd().endsWith('</rss>')).toBe(true)
  })

  it('flattens incidents across every service', () => {
    const xml = buildRssFeed(
      [
        service({ id: 'claude', name: 'Claude', incidents: [incident({ id: 'a', title: 'Claude issue' })] }),
        service({ id: 'openai', name: 'OpenAI', incidents: [incident({ id: 'b', title: 'OpenAI issue' })] }),
      ],
      { scope: 'all' },
      NOW,
    )
    expect(xml).toContain('Claude: Claude issue')
    expect(xml).toContain('OpenAI: OpenAI issue')
    expect((xml.match(/<item>/g) ?? []).length).toBe(2)
  })

  it('sorts items newest incident first', () => {
    const xml = buildRssFeed(
      [
        service({
          incidents: [
            incident({ id: 'old', title: 'Older', startedAt: '2026-05-01T00:00:00.000Z' }),
            incident({ id: 'new', title: 'Newer', startedAt: '2026-05-18T00:00:00.000Z' }),
          ],
        }),
      ],
      { scope: 'all' },
      NOW,
    )
    expect(xml.indexOf('Newer')).toBeLessThan(xml.indexOf('Older'))
  })

  it('caps the feed at 50 items', () => {
    const incidents = Array.from({ length: 60 }, (_, i) =>
      incident({ id: `inc-${i}`, startedAt: `2026-05-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z` }),
    )
    const xml = buildRssFeed([service({ incidents })], { scope: 'all' }, NOW)
    expect((xml.match(/<item>/g) ?? []).length).toBe(50)
  })

  it('produces a valid empty feed when there are no incidents', () => {
    const xml = buildRssFeed([service()], { scope: 'all' }, NOW)
    expect(xml).not.toContain('<item>')
    expect(xml).toContain('</channel>')
  })
})

describe('buildRssFeed — service scope', () => {
  it('scopes the feed to a single service', () => {
    const target = service({ id: 'openai', name: 'OpenAI', incidents: [incident({ id: 'b', title: 'OpenAI issue' })] })
    const xml = buildRssFeed(
      [service({ incidents: [incident({ id: 'a', title: 'Claude issue' })] }), target],
      { scope: 'service', service: target },
      NOW,
    )
    expect(xml).toContain('<title>AIWatch — OpenAI Incidents</title>')
    expect(xml).toContain('OpenAI issue')
    expect(xml).not.toContain('Claude issue')
    expect(xml).toContain('href="https://ai-watch.dev/feed/openai"')
  })

  it('uses the is-down slug in the self link for dash-dropped IDs', () => {
    const target = service({ id: 'claudecode', name: 'Claude Code', incidents: [incident()] })
    const xml = buildRssFeed([target], { scope: 'service', service: target }, NOW)
    expect(xml).toContain('href="https://ai-watch.dev/feed/claude-code"')
    expect(xml).not.toContain('href="https://ai-watch.dev/feed/claudecode"')
  })

  it('produces a valid empty feed for a service with no incidents', () => {
    const target = service({ id: 'openai', name: 'OpenAI', incidents: [] })
    const xml = buildRssFeed([target], { scope: 'service', service: target }, NOW)
    expect(xml).toContain('<title>AIWatch — OpenAI Incidents</title>')
    expect(xml).not.toContain('<item>')
    expect(xml.trimEnd().endsWith('</rss>')).toBe(true)
  })
})

describe('feed slug resolution', () => {
  const services = [
    service({ id: 'claude', name: 'Claude' }),
    service({ id: 'claudecode', name: 'Claude Code' }),
    service({ id: 'bedrock', name: 'Bedrock' }),
  ]

  it('feedSlug matches the is-down page slug', () => {
    expect(feedSlug('claude')).toBe('claude')
    expect(feedSlug('claudecode')).toBe('claude-code')
    expect(feedSlug('characterai')).toBe('character-ai')
    expect(feedSlug('bedrock')).toBe('bedrock')
  })

  it('resolves a canonical is-down slug', () => {
    expect(resolveFeedService(services, 'claude-code')?.id).toBe('claudecode')
    expect(resolveFeedService(services, 'claude')?.id).toBe('claude')
  })

  it('leniently resolves the raw service ID', () => {
    expect(resolveFeedService(services, 'claudecode')?.id).toBe('claudecode')
  })

  it('returns null for an unknown segment', () => {
    expect(resolveFeedService(services, 'notreal')).toBeNull()
  })

  it('returns null when the service list is empty', () => {
    expect(resolveFeedService([], 'claude')).toBeNull()
  })
})

describe('isValidFeedSegment', () => {
  it('accepts slugs and service IDs', () => {
    expect(isValidFeedSegment('claude')).toBe(true)
    expect(isValidFeedSegment('claude-code')).toBe(true)
    expect(isValidFeedSegment('claudecode')).toBe(true)
  })

  it('rejects empty, dotted and slashed segments', () => {
    expect(isValidFeedSegment('')).toBe(false)
    expect(isValidFeedSegment('feed.xml')).toBe(false)
    expect(isValidFeedSegment('a/b')).toBe(false)
    expect(isValidFeedSegment('claude code')).toBe(false)
  })
})

describe('buildRssFeed — item link', () => {
  it('links to the /is-{id}-down SEO page for identity-slug services', () => {
    const xml = buildRssFeed([service({ id: 'openai', incidents: [incident()] })], { scope: 'all' }, NOW)
    expect(xml).toContain('<link>https://ai-watch.dev/is-openai-down</link>')
  })

  it('applies the slug override for dash-dropped service IDs', () => {
    const xml = buildRssFeed([service({ id: 'claudecode', name: 'Claude Code', incidents: [incident()] })], { scope: 'all' }, NOW)
    expect(xml).toContain('<link>https://ai-watch.dev/is-claude-code-down</link>')
  })

  it('falls back to the dashboard hash route for services with no is-down page', () => {
    const xml = buildRssFeed([service({ id: 'bedrock', name: 'Bedrock', incidents: [incident()] })], { scope: 'all' }, NOW)
    expect(xml).toContain('<link>https://ai-watch.dev/#bedrock</link>')
  })
})

describe('buildRssFeed — item fields', () => {
  it('escapes XML-significant characters in title and description', () => {
    const xml = buildRssFeed(
      [service({ name: 'A&B', incidents: [incident({ title: '<script> "x"', timeline: [] })] })],
      { scope: 'all' },
      NOW,
    )
    expect(xml).toContain('A&amp;B: &lt;script&gt; &quot;x&quot;')
    expect(xml).not.toContain('<script>')
  })

  it('prefixes guid with aiwatch:serviceId:incidentId', () => {
    const xml = buildRssFeed(
      [service({ id: 'claude', incidents: [incident({ id: 'inc-xyz' })] })],
      { scope: 'all' },
      NOW,
    )
    expect(xml).toContain('<guid isPermaLink="false">aiwatch:claude:inc-xyz</guid>')
  })

  it('emits <category> only when impact is set', () => {
    const withImpact = buildRssFeed([service({ incidents: [incident({ impact: 'critical' })] })], { scope: 'all' }, NOW)
    const noImpact = buildRssFeed([service({ incidents: [incident({ impact: null })] })], { scope: 'all' }, NOW)
    expect(withImpact).toContain('<category>critical</category>')
    expect(noImpact).not.toContain('<category>')
  })

  it('includes the latest timeline update in the description', () => {
    const xml = buildRssFeed(
      [
        service({
          incidents: [
            incident({
              duration: '1h 20m',
              timeline: [
                { stage: 'investigating', text: 'looking into it', at: '2026-05-10T12:00:00.000Z' },
                { stage: 'identified', text: 'root cause found', at: '2026-05-10T12:30:00.000Z' },
              ],
            }),
          ],
        }),
      ],
      { scope: 'all' },
      NOW,
    )
    expect(xml).toContain('Latest update: root cause found')
    expect(xml).toContain('Duration: 1h 20m')
    expect(xml).not.toContain('looking into it')
  })

  it('falls back to the epoch for an unparseable startedAt', () => {
    const xml = buildRssFeed([service({ incidents: [incident({ startedAt: 'not-a-date' })] })], { scope: 'all' }, NOW)
    expect(xml).toContain(`<pubDate>${new Date(0).toUTCString()}</pubDate>`)
  })

  it('strips XML-forbidden C0 control characters but keeps tab/newline/CR', () => {
    const xml = buildRssFeed(
      [service({ incidents: [incident({ title: 'errors\x00\x08\x1Fhere', timeline: [{ stage: 'investigating', text: 'line1\nline2\ttab', at: '2026-05-10T12:00:00.000Z' }] })] })],
      { scope: 'all' },
      NOW,
    )
    expect(xml).toContain('errorshere')
    expect(xml).not.toMatch(/[\x00\x08\x1F]/)
    expect(xml).toContain('line1\nline2\ttab')
  })
})

describe('buildRssFeed — shared incident (per-surface providers)', () => {
  const anthropic = [
    service({ id: 'claude', name: 'Claude API', incidents: [incident({ id: 'shared', title: 'Elevated errors' })] }),
    service({ id: 'claudeai', name: 'claude.ai', incidents: [incident({ id: 'shared', title: 'Elevated errors' })] }),
    service({ id: 'claudecode', name: 'Claude Code', incidents: [incident({ id: 'shared', title: 'Elevated errors' })] }),
  ]

  it('annotates each item with the other services sharing the incident ID', () => {
    const xml = buildRssFeed(anthropic, { scope: 'all' }, NOW)
    expect(xml).toContain('Also affecting: claude.ai, Claude Code')
    expect(xml).toContain('Also affecting: Claude API, Claude Code')
    expect(xml).toContain('Also affecting: Claude API, claude.ai')
  })

  it('omits the note for an incident unique to one service', () => {
    const xml = buildRssFeed([service({ incidents: [incident({ id: 'solo' })] })], { scope: 'all' }, NOW)
    expect(xml).not.toContain('Also affecting:')
  })

  it('keeps the note in a service-scoped feed using the full service list', () => {
    const xml = buildRssFeed(anthropic, { scope: 'service', service: anthropic[0] }, NOW)
    expect(xml).toContain('Also affecting: claude.ai, Claude Code')
    expect((xml.match(/<item>/g) ?? []).length).toBe(1)
  })
})

describe('buildFeedResponse — HTTP decision', () => {
  const cache = { services: [service({ id: 'claude', name: 'Claude', incidents: [incident()] })] }

  it('returns 503 for a null cache (all scope) — never a 200 empty feed', () => {
    const r = buildFeedResponse(null, { scope: 'all' })
    expect(r).toEqual({ ok: false, status: 503, message: 'Status data is temporarily unavailable' })
  })

  it('returns 503 for a null cache (service scope) — never a misleading 404', () => {
    const r = buildFeedResponse(null, { scope: 'service', segment: 'claude' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(503)
  })

  it('returns a 200 feed for a present-but-empty cache (legitimate empty feed)', () => {
    const r = buildFeedResponse({ services: [] }, { scope: 'all' }, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.xml).toContain('</rss>')
  })

  it('returns 400 for an invalid segment, even before the cache check', () => {
    expect(buildFeedResponse(cache, { scope: 'service', segment: 'bad id' })).toMatchObject({ ok: false, status: 400 })
    expect(buildFeedResponse(null, { scope: 'service', segment: 'bad/id' })).toMatchObject({ ok: false, status: 400 })
  })

  it('returns 404 for an unknown slug against a healthy cache', () => {
    expect(buildFeedResponse(cache, { scope: 'service', segment: 'notreal' })).toMatchObject({ ok: false, status: 404 })
  })

  it('returns a 200 feed for a valid all / service request', () => {
    const all = buildFeedResponse(cache, { scope: 'all' }, NOW)
    const one = buildFeedResponse(cache, { scope: 'service', segment: 'claude' }, NOW)
    expect(all.ok).toBe(true)
    expect(one.ok).toBe(true)
    if (one.ok) expect(one.xml).toContain('<title>AIWatch — Claude Incidents</title>')
  })
})
