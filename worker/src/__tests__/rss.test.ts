import { describe, it, expect } from 'vitest'
import { buildRssFeed, feedSlug, resolveFeedService, isValidFeedSegment, buildFeedResponse, dedupeSharedIncidents, type RssAiAnalysisMap } from '../rss'
import { getFallbacks } from '../fallback'
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
    // XSL stylesheet PI so browsers render the feed instead of downloading it (#467).
    // Versioned (?v=) so a changed stylesheet busts the browser cache instead of going stale.
    expect(xml).toContain('<?xml-stylesheet type="text/xsl" href="/feed.xsl?v=')
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

describe('buildRssFeed — resolution notifications (#467)', () => {
  it('emits ONLY the resolved item (distinct guid, no contradictory active row) for a resolved incident', () => {
    const inc = incident({
      id: 'r1',
      title: 'Elevated errors',
      status: 'resolved',
      startedAt: '2026-05-10T12:00:00.000Z',
      resolvedAt: '2026-05-10T14:30:00.000Z',
      duration: '2h 30m',
    })
    const xml = buildRssFeed([service({ incidents: [inc] })], { scope: 'all' }, NOW)
    // One item: the resolution event only. The plain `:r1` base row is dropped so the feed never
    // shows a "🔴 … resolved" contradiction; the `:resolved` guid still re-notifies subscribers.
    expect((xml.match(/<item>/g) ?? []).length).toBe(1)
    expect(xml).toContain('aiwatch:claude:r1:resolved</guid>')
    expect(xml).not.toContain('aiwatch:claude:r1</guid>')
    expect(xml).toContain('🟢 Claude: Resolved — Elevated errors')
    // The resolved item uses resolvedAt as its pubDate so it re-notifies as a fresh item.
    expect(xml).toContain(`<pubDate>${new Date('2026-05-10T14:30:00.000Z').toUTCString()}</pubDate>`)
  })

  it('does not emit a resolved item for an active incident', () => {
    const xml = buildRssFeed([service({ incidents: [incident({ id: 'a1', status: 'investigating' })] })], { scope: 'all' }, NOW)
    expect((xml.match(/<item>/g) ?? []).length).toBe(1)
    expect(xml).not.toContain(':resolved</guid>')
  })

  it('falls back to the resolved timeline entry timestamp when resolvedAt is null', () => {
    const inc = incident({
      id: 'r2',
      status: 'resolved',
      resolvedAt: null,
      timeline: [
        { stage: 'investigating', text: 'Looking into it', at: '2026-05-10T12:10:00.000Z' },
        { stage: 'resolved', text: 'Fixed', at: '2026-05-10T13:00:00.000Z' },
      ],
    })
    const xml = buildRssFeed([service({ incidents: [inc] })], { scope: 'all' }, NOW)
    expect(xml).toContain('aiwatch:claude:r2:resolved</guid>')
    expect(xml).toContain(`<pubDate>${new Date('2026-05-10T13:00:00.000Z').toUTCString()}</pubDate>`)
  })

  it('prefers the resolved-stage entry over a later non-resolved entry when resolvedAt is null', () => {
    // A post-recovery update (e.g. monitoring/post-mortem) can be appended AFTER the resolved
    // entry. resolvedAtOf must pick the resolved stage (12:30), not the chronologically-last entry.
    const inc = incident({
      id: 'r5',
      status: 'resolved',
      resolvedAt: null,
      startedAt: '2026-05-10T12:00:00.000Z',
      timeline: [
        { stage: 'investigating', text: 'Looking into it', at: '2026-05-10T12:10:00.000Z' },
        { stage: 'resolved', text: 'Fixed', at: '2026-05-10T12:30:00.000Z' },
        { stage: 'monitoring', text: 'Post-incident monitoring', at: '2026-05-10T13:00:00.000Z' },
      ],
    })
    const xml = buildRssFeed([service({ incidents: [inc] })], { scope: 'all' }, NOW)
    expect(xml).toContain(`<pubDate>${new Date('2026-05-10T12:30:00.000Z').toUTCString()}</pubDate>`)
    expect(xml).not.toContain(`<pubDate>${new Date('2026-05-10T13:00:00.000Z').toUTCString()}</pubDate>`)
  })

  it('uses the last timeline entry when resolvedAt is null and no entry is stage=resolved', () => {
    const inc = incident({
      id: 'r3',
      status: 'resolved',
      resolvedAt: null,
      startedAt: '2026-05-10T12:00:00.000Z',
      timeline: [
        { stage: 'investigating', text: 'Looking into it', at: '2026-05-10T12:10:00.000Z' },
        { stage: 'monitoring', text: 'Monitoring', at: '2026-05-10T12:45:00.000Z' },
      ],
    })
    const xml = buildRssFeed([service({ incidents: [inc] })], { scope: 'all' }, NOW)
    expect(xml).toContain(`<pubDate>${new Date('2026-05-10T12:45:00.000Z').toUTCString()}</pubDate>`)
  })

  it('falls back to startedAt when resolvedAt is null and the timeline is empty', () => {
    const inc = incident({ id: 'r4', status: 'resolved', resolvedAt: null, startedAt: '2026-05-10T12:00:00.000Z', timeline: [] })
    const xml = buildRssFeed([service({ incidents: [inc] })], { scope: 'all' }, NOW)
    expect(xml).toContain(`<pubDate>${new Date('2026-05-10T12:00:00.000Z').toUTCString()}</pubDate>`)
  })
})

describe('buildRssFeed — fallback suggestions (#467)', () => {
  const candidates = [
    service({ id: 'openai', name: 'OpenAI', category: 'api', status: 'operational' }),
    service({ id: 'gemini', name: 'Gemini', category: 'api', status: 'operational' }),
  ]

  it('adds a "Try instead" line to an active item when the service is impaired', () => {
    const down = service({ id: 'claude', name: 'Claude', category: 'api', status: 'down', incidents: [incident({ id: 'd1' })] })
    const xml = buildRssFeed([down, ...candidates], { scope: 'all' }, NOW)
    expect(xml).toContain('Try instead:')
    expect(xml).toMatch(/Try instead: (OpenAI|Gemini)/)
  })

  it('omits the fallback line for an operational service', () => {
    const ok = service({ id: 'claude', name: 'Claude', category: 'api', status: 'operational', incidents: [incident({ id: 'o1' })] })
    const xml = buildRssFeed([ok, ...candidates], { scope: 'all' }, NOW)
    expect(xml).not.toContain('Try instead:')
  })

  it('omits the fallback line on the resolved item', () => {
    const resolved = service({ id: 'claude', name: 'Claude', category: 'api', status: 'down', incidents: [incident({ id: 'rr', status: 'resolved', resolvedAt: '2026-05-10T14:00:00.000Z' })] })
    const xml = buildRssFeed([resolved, ...candidates], { scope: 'all' }, NOW)
    // The resolved item (distinct guid) must not carry a stale "Try instead" line.
    const resolvedItem = xml.slice(xml.indexOf('aiwatch:claude:rr:resolved'))
    expect(resolvedItem.split('</item>')[0]).not.toContain('Try instead:')
  })
})

describe('buildRssFeed — item formatting (#467)', () => {
  it('prefixes the title with a severity emoji (red for down/major, amber for minor)', () => {
    const down = buildRssFeed([service({ name: 'OpenAI', status: 'down', incidents: [incident({ id: 'd', title: 'API errors', impact: 'major' })] })], { scope: 'all' }, NOW)
    expect(down).toContain('<title>🔴 OpenAI: API errors</title>')
    const minor = buildRssFeed([service({ name: 'ElevenLabs', status: 'degraded', incidents: [incident({ id: 'm', title: 'Export failures', impact: 'minor', status: 'identified' })] })], { scope: 'all' }, NOW)
    expect(minor).toContain('<title>🟡 ElevenLabs: Export failures</title>')
  })

  it('marks a resolved item title with the green emoji + "Resolved"', () => {
    const xml = buildRssFeed([service({ incidents: [incident({ id: 'r', title: 'Outage', status: 'resolved', resolvedAt: '2026-05-10T14:00:00.000Z', duration: '2h' })] })], { scope: 'all' }, NOW)
    expect(xml).toContain('<title>🟢 Claude: Resolved — Outage</title>')
  })

  it('renders the description as CDATA HTML paragraphs with a bold impact label', () => {
    const xml = buildRssFeed([service({ name: 'ElevenLabs', status: 'degraded', incidents: [incident({ id: 'm', impact: 'minor', status: 'identified', timeline: [{ stage: 'identified', text: 'Scaling resources', at: '2026-05-10T12:30:00.000Z' }] })] })], { scope: 'all' }, NOW)
    expect(xml).toContain('<description><![CDATA[<p>🟡 <strong>Minor</strong> · identified</p>')
    expect(xml).toContain('<p>Scaling resources</p>')
    expect(xml).toContain(']]></description>')
  })

  it('separates description paragraphs with a newline so flatteners (Slack /feed) don\'t glue them (#479)', () => {
    const inc = incident({ id: 'sep', title: 'Outage', status: 'resolved', resolvedAt: '2026-05-10T14:00:00.000Z', duration: '14m', timeline: [{ stage: 'resolved', text: 'Qwen3 recovered', at: '2026-05-10T14:00:00.000Z' }] })
    const xml = buildRssFeed([service({ incidents: [inc] })], { scope: 'all' }, NOW)
    expect(xml).toContain('lasted 14m</p>\n<p>Qwen3 recovered</p>')
    expect(xml).not.toContain('14m</p><p>') // not glued
  })

  it('escapes HTML-significant characters inside the CDATA description (no injection)', () => {
    const xml = buildRssFeed([service({ status: 'down', incidents: [incident({ id: 'x', impact: 'major', timeline: [{ stage: 'investigating', text: '<img src=x onerror=alert(1)>', at: '2026-05-10T12:00:00.000Z' }] })] })], { scope: 'all' }, NOW)
    expect(xml).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(xml).not.toContain('<img src=x')
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
    expect(xml).toContain('<link>https://ai-watch.dev/is-openai-down?e=active</link>') // #539 status hint
  })

  it('applies the slug override for dash-dropped service IDs', () => {
    const xml = buildRssFeed([service({ id: 'claudecode', name: 'Claude Code', incidents: [incident()] })], { scope: 'all' }, NOW)
    expect(xml).toContain('<link>https://ai-watch.dev/is-claude-code-down?e=active</link>') // #539 status hint
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
    // Description is now structured HTML (#467): the latest timeline text is its own <p>,
    // duration folds into the meta line. Only the latest entry is shown, never earlier ones.
    expect(xml).toContain('<p>root cause found</p>')
    expect(xml).toContain('1h 20m')
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

  it('collapses a multi-surface incident into ONE all-feed item, keeping the SERVICES-order primary (#520)', () => {
    const xml = buildRssFeed(anthropic, { scope: 'all' }, NOW)
    // One item, not three — the Slack /feed subscriber gets a single consolidated message
    expect((xml.match(/<item>/g) ?? []).length).toBe(1)
    // #724 — provider-grouped title (mirrors Discord "Anthropic (Claude API, claude.ai, Claude Code)").
    // Primary = first in SERVICES order (Claude API); its "Also affecting" still names the rest.
    expect(xml).toContain('🔴 Anthropic (Claude API, claude ai, Claude Code): Elevated errors') // 'major' → 🔴, #539 brand defused
    expect(xml).toContain('Also affecting: claude ai, Claude Code') // #539 brand defused
    // The other surfaces' items (and their inverse "Also affecting" lines) are gone
    expect(xml).not.toContain('Also affecting: Claude API, Claude Code')
    expect(xml).not.toContain('Also affecting: Claude API, claude.ai')
  })

  it('uses a per-incident guid for the collapsed item (no Slack re-post churn)', () => {
    const xml = buildRssFeed(anthropic, { scope: 'all' }, NOW)
    expect((xml.match(/aiwatch:claude:shared/g) ?? []).length).toBe(1)
    // no per-surface guids leak through for the deduped incident
    expect(xml).not.toContain('aiwatch:claudeai:shared')
    expect(xml).not.toContain('aiwatch:claudecode:shared')
  })

  it('omits the note for an incident unique to one service', () => {
    const xml = buildRssFeed([service({ incidents: [incident({ id: 'solo' })] })], { scope: 'all' }, NOW)
    expect(xml).not.toContain('Also affecting:')
  })

  it('keeps the note + single item in a service-scoped feed using the full service list', () => {
    const xml = buildRssFeed(anthropic, { scope: 'service', service: anthropic[0] }, NOW)
    expect(xml).toContain('Also affecting: claude ai, Claude Code') // #539 brand defused
    expect((xml.match(/<item>/g) ?? []).length).toBe(1)
  })

  it('keeps an active and a resolved item separate (dedup is per incidentId+kind)', () => {
    // If one surface is resolved while another is still active under the same incidentId, both kinds survive.
    const mixed = [
      service({ id: 'claude', name: 'Claude API', status: 'operational', incidents: [incident({ id: 'shared', title: 'Elevated errors', status: 'resolved', resolvedAt: '2026-05-10T14:00:00.000Z', duration: '34m' })] }),
      service({ id: 'claudeai', name: 'claude.ai', status: 'degraded', incidents: [incident({ id: 'shared', title: 'Elevated errors', status: 'investigating' })] }),
    ]
    const xml = buildRssFeed(mixed, { scope: 'all' }, NOW)
    expect((xml.match(/<item>/g) ?? []).length).toBe(2)
  })
})

describe('dedupeSharedIncidents (#520)', () => {
  const e = (id: string, kind: 'active' | 'resolved', tag: string) => ({ incident: { id }, kind, tag })

  it('keeps the first occurrence per incidentId+kind', () => {
    const out = dedupeSharedIncidents([
      e('shared', 'active', 'claude'),
      e('shared', 'active', 'claudeai'),
      e('shared', 'active', 'claudecode'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].tag).toBe('claude') // first = primary
  })

  it('treats active and resolved of the same incident as distinct entries', () => {
    const out = dedupeSharedIncidents([
      e('shared', 'resolved', 'claude'),
      e('shared', 'active', 'claudeai'),
      e('shared', 'resolved', 'claudecode'),
    ])
    expect(out).toHaveLength(2)
    expect(out.map(o => o.tag)).toEqual(['claude', 'claudeai'])
  })

  it('leaves distinct incidents untouched and preserves order', () => {
    const out = dedupeSharedIncidents([
      e('a', 'active', 'x'),
      e('b', 'active', 'y'),
      e('a', 'active', 'dup'),
    ])
    expect(out.map(o => o.tag)).toEqual(['x', 'y'])
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

// #724 — align the Slack /feed item with the Discord operator embed: carry the 🤖 AI analysis
// summary, match the fallback ranking, and use a provider-grouped title — while staying PUBLIC-safe
// (the operator-only tweet draft must never appear).
describe('buildRssFeed — AI analysis block (#724)', () => {
  const analysisMap: RssAiAnalysisMap = {
    claude: [{ incidentId: 'inc-1', summary: 'Opus 4.8 elevated errors', estimatedRecovery: '1-3h', affectedScope: ['Claude API', 'Opus 4.8'] }],
  }

  it('renders the AI analysis summary + recovery + scope for an active incident', () => {
    const xml = buildRssFeed([service({ status: 'degraded', incidents: [incident({ id: 'inc-1' })] })], { scope: 'all' }, NOW, analysisMap)
    expect(xml).toContain('🤖 AI analysis: Opus 4.8 elevated errors')
    expect(xml).toContain('Est. recovery: 1-3h')
    expect(xml).toContain('Scope: Claude API, Opus 4.8')
  })

  it('maps an N/A recovery via formatRecoveryDisplay (parity with Discord)', () => {
    const map: RssAiAnalysisMap = { claude: [{ incidentId: 'inc-1', summary: 'x', estimatedRecovery: 'N/A', affectedScope: [] }] }
    const xml = buildRssFeed([service({ status: 'degraded', incidents: [incident({ id: 'inc-1' })] })], { scope: 'all' }, NOW, map)
    expect(xml).toContain('Est. recovery: Exceeded typical pattern')
  })

  it('omits the AI block when no analysis is present', () => {
    const xml = buildRssFeed([service({ status: 'degraded', incidents: [incident({ id: 'inc-1' })] })], { scope: 'all' }, NOW)
    expect(xml).not.toContain('🤖 AI analysis')
  })

  it('does not render the AI block on a resolved item (it already reads "Resolved")', () => {
    const xml = buildRssFeed(
      [service({ incidents: [incident({ id: 'inc-1', status: 'resolved', resolvedAt: '2026-05-10T14:00:00.000Z', duration: '34m' })] })],
      { scope: 'all' }, NOW, analysisMap,
    )
    expect(xml).not.toContain('🤖 AI analysis')
  })

  it('does not render the AI block for a `monitoring` incident even if the map has an entry (rss.ts self-consistent)', () => {
    // The /feed handler excludes monitoring from the analysis map, but buildRssFeed must enforce it too
    // (monitoring = recovery confirmed). Guard lives in the tested layer, not only the handler.
    const xml = buildRssFeed([service({ status: 'degraded', incidents: [incident({ id: 'inc-1', status: 'monitoring' })] })], { scope: 'all' }, NOW, analysisMap)
    expect(xml).not.toContain('🤖 AI analysis')
  })

  it('picks the right summary when one service has TWO simultaneous active incidents (analysisFor by incidentId)', () => {
    const map: RssAiAnalysisMap = { claude: [
      { incidentId: 'a', summary: 'analysis A', estimatedRecovery: '1h', affectedScope: [] },
      { incidentId: 'b', summary: 'analysis B', estimatedRecovery: '2h', affectedScope: [] },
    ] }
    const xml = buildRssFeed([service({ status: 'degraded', incidents: [
      incident({ id: 'a', title: 'Incident A' }), incident({ id: 'b', title: 'Incident B' }),
    ] })], { scope: 'all' }, NOW, map)
    // each item carries ITS OWN summary
    const itemA = xml.split('<item>').find((s) => s.includes('Incident A')) ?? ''
    const itemB = xml.split('<item>').find((s) => s.includes('Incident B')) ?? ''
    expect(itemA).toContain('analysis A')
    expect(itemA).not.toContain('analysis B')
    expect(itemB).toContain('analysis B')
    expect(itemB).not.toContain('analysis A')
  })

  it('never leaks the operator-only tweet draft into the public feed', () => {
    const xml = buildRssFeed([service({ status: 'degraded', incidents: [incident({ id: 'inc-1' })] })], { scope: 'all' }, NOW, analysisMap)
    expect(xml).not.toContain('TWEET DRAFT')
    expect(xml).not.toContain('✍️')
  })

  it('keeps the AI block on the surviving consolidated item of a deduped shared incident', () => {
    // dedupeSharedIncidents (#520) keeps the SERVICES-order primary; its analysis (keyed by that
    // primary's svcId) must survive the collapse → the single Slack item still carries the 🤖 block.
    const shared = incident({ id: 'opus48', title: 'Elevated errors' })
    const xml = buildRssFeed([
      service({ id: 'claude', name: 'Claude API', provider: 'Anthropic', status: 'degraded', incidents: [shared] }),
      service({ id: 'claudeai', name: 'claude.ai', provider: 'Anthropic', status: 'degraded', incidents: [shared] }),
    ], { scope: 'all' }, NOW, { claude: [{ incidentId: 'opus48', summary: 'Opus 4.8 elevated errors', estimatedRecovery: '1-3h', affectedScope: [] }] })
    expect((xml.match(/<item>/g) ?? []).length).toBe(1)         // collapsed to one
    expect(xml).toContain('🤖 AI analysis: Opus 4.8 elevated errors') // analysis survives the collapse
  })
})

describe('buildRssFeed — provider-grouped title (#724)', () => {
  it('keeps the plain "<service>: …" title for a single-surface incident', () => {
    const xml = buildRssFeed([service({ name: 'Mistral API', status: 'degraded', incidents: [incident({ id: 'solo', title: 'Errors' })] })], { scope: 'all' }, NOW)
    expect(xml).toContain('Mistral API: Errors')
    expect(xml).not.toContain('(Mistral API)') // no group parens for a solo incident
  })

  it('groups a RESOLVED shared incident title too (the recovery message)', () => {
    const resolved = { id: 'shared', title: 'Elevated errors', status: 'resolved' as const, impact: 'minor' as const, startedAt: '2026-05-10T12:00:00.000Z', resolvedAt: '2026-05-10T14:00:00.000Z', duration: '2h', timeline: [] }
    const xml = buildRssFeed([
      service({ id: 'claude', name: 'Claude API', provider: 'Anthropic', incidents: [resolved] }),
      service({ id: 'claudeai', name: 'claude.ai', provider: 'Anthropic', incidents: [resolved] }),
    ], { scope: 'all' }, NOW)
    expect(xml).toContain('🟢 Anthropic (Claude API, claude ai): Resolved — Elevated errors')
  })

  it('falls back to the service name when provider is empty (defensive guard)', () => {
    const shared = incident({ id: 'shared', title: 'Errors' })
    const xml = buildRssFeed([
      service({ id: 'a', name: 'Svc A', provider: '', status: 'degraded', incidents: [shared] }),
      service({ id: 'b', name: 'Svc B', provider: '', status: 'degraded', incidents: [shared] }),
    ], { scope: 'all' }, NOW)
    expect(xml).toContain('Svc A (Svc A, Svc B): Errors') // no leading " (" / "undefined ("
    expect(xml).not.toContain('undefined (')
  })
})

describe('buildRssFeed — fallback ranking parity with Discord (#724)', () => {
  it('orders "Try instead" by the same getFallbacks ranking when services carry aiwatchScore', () => {
    // services:latest has no aiwatchScore, so the feed handler attaches it before calling buildRssFeed.
    // With scores present, the "Try instead" line must match getFallbacks() (the Discord/dashboard oracle).
    const down = { ...service({ id: 'cohere', name: 'Cohere', category: 'api', status: 'down', incidents: [incident({ id: 'd' })] }), aiwatchScore: 40 }
    const candidates = [
      { ...service({ id: 'groq', name: 'Groq Cloud', category: 'api', status: 'operational' }), aiwatchScore: 50 },
      { ...service({ id: 'mistral', name: 'Mistral API', category: 'api', status: 'operational' }), aiwatchScore: 92 },
    ]
    const all = [down, ...candidates] as ServiceStatus[]
    const expected = getFallbacks('cohere', 'api', all).map((f) => f.name)
    expect(expected.length).toBeGreaterThan(0)
    const xml = buildRssFeed(all, { scope: 'all' }, NOW)
    const tryLine = xml.split('\n').find((l) => l.includes('Try instead')) ?? ''
    // the feed's candidate order matches getFallbacks exactly (proves scored services are used)
    expect(tryLine).toContain(`Try instead: ${expected.join(' · ')}`)
  })
})

describe('buildFeedResponse — threads AI analysis (#724)', () => {
  it('passes the analysis map through to the rendered feed', () => {
    const cached = { services: [service({ status: 'degraded', incidents: [incident({ id: 'inc-1' })] })], cachedAt: NOW.toISOString() }
    const map: RssAiAnalysisMap = { claude: [{ incidentId: 'inc-1', summary: 'piped through', estimatedRecovery: '1h', affectedScope: [] }] }
    const res = buildFeedResponse(cached, { scope: 'all' }, NOW, map)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.xml).toContain('🤖 AI analysis: piped through')
  })
})
