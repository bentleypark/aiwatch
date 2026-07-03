import { describe, it, expect } from 'vitest'
import { buildRssFeed, buildFeedWithMeta, weakFeedEtag, isFeedNotModified, feedHttpResponse, feedSlug, resolveFeedService, isValidFeedSegment, buildFeedResponse, dedupeSharedIncidents, resolveFeedFirstSeen, isActiveItemHeld, type RssAiAnalysisMap } from '../rss'
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
    // #860 — an empty feed OMITS <lastBuildDate> so its body is byte-stable across
    // polls (stable ETag → the no-incident steady state actually 304s).
    expect(xml).not.toContain('<lastBuildDate>')
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

describe('buildRssFeed — active item pubDate = first-seen, not backdated startedAt (#750)', () => {
  const STARTED = '2026-05-10T12:00:00.000Z'      // provider-reported (backdated)
  const FIRST_SEEN = '2026-05-19T08:55:00.000Z'   // AIWatch first detection (fresh, ~now)
  const inc = incident({ id: 'p1', title: 'Ray2 queue times', status: 'investigating', startedAt: STARTED })
  // AI present so the #759 publish-before-analysis hold doesn't suppress this fresh active item —
  // isolates the pubDate-freshness assertion from the hold (an AI-less fresh item would be held).
  const aiReady: RssAiAnalysisMap = { claude: [{ incidentId: 'p1', summary: 'queue backlog', estimatedRecovery: '1h', affectedScope: [] }] }

  it('uses firstSeen as the active item pubDate when provided (overrides backdated startedAt)', () => {
    const xml = buildRssFeed([service({ incidents: [inc] })], { scope: 'all' }, NOW, aiReady, { p1: FIRST_SEEN })
    expect(xml).toContain(`<pubDate>${new Date(FIRST_SEEN).toUTCString()}</pubDate>`)
    expect(xml).not.toContain(`<pubDate>${new Date(STARTED).toUTCString()}</pubDate>`)
    // guid is unchanged (still the active guid) — only the pubDate freshness changed.
    expect(xml).toContain('aiwatch:claude:p1</guid>')
  })

  it('falls back to startedAt when no firstSeen entry exists (legacy behavior preserved)', () => {
    const xml = buildRssFeed([service({ incidents: [inc] })], { scope: 'all' }, NOW)
    expect(xml).toContain(`<pubDate>${new Date(STARTED).toUTCString()}</pubDate>`)
  })

  it('falls back to startedAt for incidents missing from the firstSeen map', () => {
    const xml = buildRssFeed([service({ incidents: [inc] })], { scope: 'all' }, NOW, undefined, { other: FIRST_SEEN })
    expect(xml).toContain(`<pubDate>${new Date(STARTED).toUTCString()}</pubDate>`)
  })

  it('does NOT touch a resolved item pubDate (still resolvedAt, #467 invariant intact)', () => {
    const resolved = incident({ id: 'p1', status: 'resolved', startedAt: STARTED, resolvedAt: '2026-05-19T09:00:00.000Z', duration: '1m' })
    const xml = buildRssFeed([service({ incidents: [resolved] })], { scope: 'all' }, NOW, undefined, { p1: FIRST_SEEN })
    // resolved item keeps resolvedAt; firstSeen only affects the ACTIVE branch.
    expect(xml).toContain(`<pubDate>${new Date('2026-05-19T09:00:00.000Z').toUTCString()}</pubDate>`)
    expect(xml).not.toContain(`<pubDate>${new Date(FIRST_SEEN).toUTCString()}</pubDate>`)
  })

  it('buildFeedResponse threads firstSeen through to the service-scope feed', () => {
    const target = service({ id: 'claude', name: 'Claude', incidents: [inc] })
    const res = buildFeedResponse({ services: [target] }, { scope: 'service', segment: 'claude' }, NOW, aiReady, { p1: FIRST_SEEN })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.xml).toContain(`<pubDate>${new Date(FIRST_SEEN).toUTCString()}</pubDate>`)
  })
})

describe('buildRssFeed — resolved item "predicted vs actual" (#827 F4)', () => {
  const resolvedInc = incident({
    id: 'r1', title: 'Login Issues', status: 'resolved',
    startedAt: '2026-05-10T12:00:00.000Z', resolvedAt: '2026-05-10T14:44:00.000Z', duration: '2h 44m',
    timeline: [{ stage: 'resolved', text: 'Restored.', at: '2026-05-10T14:44:00.000Z' }],
  })
  it('renders the predicted-vs-actual line when the analysis carries a numeric estimate', () => {
    const ai: RssAiAnalysisMap = { claude: [{ incidentId: 'r1', summary: 's', estimatedRecovery: '30m–1h', estimatedRecoveryHours: 1, affectedScope: [] }] }
    const xml = buildRssFeed([service({ incidents: [resolvedInc] })], { scope: 'all' }, NOW, ai)
    expect(xml).toContain('🎯 AI prediction: 2h 44m (over ~1h est.)') // actual 2h44m exceeded the ~1h estimate
  })
  it('omits the line when no analysis / no numeric estimate', () => {
    const xml = buildRssFeed([service({ incidents: [resolvedInc] })], { scope: 'all' }, NOW)
    expect(xml).not.toContain('AI prediction:')
    const aiNoHours: RssAiAnalysisMap = { claude: [{ incidentId: 'r1', summary: 's', estimatedRecovery: 'N/A', affectedScope: [] }] }
    expect(buildRssFeed([service({ incidents: [resolvedInc] })], { scope: 'all' }, NOW, aiNoHours)).not.toContain('AI prediction:')
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

  it('renders the active description as CDATA HTML with a bold impact label (status-invariant, #768)', () => {
    const xml = buildRssFeed([service({ name: 'ElevenLabs', status: 'degraded', incidents: [incident({ id: 'm', impact: 'minor', status: 'identified', timeline: [{ stage: 'identified', text: 'Scaling resources', at: '2026-05-10T12:30:00.000Z' }] })] })], { scope: 'all' }, NOW)
    // #768 — active item is status-invariant: impact label only, NO status word, NO per-update text.
    expect(xml).toContain('<description><![CDATA[<p>🟡 <strong>Minor</strong></p>')
    expect(xml).not.toContain('· identified')      // status word dropped
    expect(xml).not.toContain('Scaling resources')  // per-update timeline text dropped on active
    expect(xml).toContain(']]></description>')
  })

  it('separates description paragraphs with a newline so flatteners (Slack /feed) don\'t glue them (#479)', () => {
    const inc = incident({ id: 'sep', title: 'Outage', status: 'resolved', resolvedAt: '2026-05-10T14:00:00.000Z', duration: '14m', timeline: [{ stage: 'resolved', text: 'Qwen3 recovered', at: '2026-05-10T14:00:00.000Z' }] })
    const xml = buildRssFeed([service({ incidents: [inc] })], { scope: 'all' }, NOW)
    expect(xml).toContain('lasted 14m</p>\n<p>Qwen3 recovered</p>')
    expect(xml).not.toContain('14m</p><p>') // not glued
  })

  it('escapes HTML-significant characters inside the CDATA description (no injection)', () => {
    // #768 — the per-update timeline text now renders only on RESOLVED items, so test escaping there.
    const xml = buildRssFeed([service({ status: 'operational', incidents: [incident({ id: 'x', status: 'resolved', impact: 'major', resolvedAt: '2026-05-10T13:00:00.000Z', duration: '1h', timeline: [{ stage: 'resolved', text: '<img src=x onerror=alert(1)>', at: '2026-05-10T13:00:00.000Z' }] })] })], { scope: 'all' }, NOW)
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
    // #539 status hint (?e=) + #548 utm (&amp; XML-escaped). The link <link>s through escapeXml.
    expect(xml).toContain('<link>https://ai-watch.dev/is-openai-down?e=active&amp;utm_source=rss&amp;utm_medium=feed&amp;utm_campaign=outage</link>')
  })

  it('applies the slug override for dash-dropped service IDs', () => {
    const xml = buildRssFeed([service({ id: 'claudecode', name: 'Claude Code', incidents: [incident()] })], { scope: 'all' }, NOW)
    expect(xml).toContain('<link>https://ai-watch.dev/is-claude-code-down?e=active&amp;utm_source=rss&amp;utm_medium=feed&amp;utm_campaign=outage</link>') // #539 hint + #548 utm
  })

  it('falls back to the dashboard hash route for services with no is-down page', () => {
    const xml = buildRssFeed([service({ id: 'bedrock', name: 'Bedrock', incidents: [incident()] })], { scope: 'all' }, NOW)
    expect(xml).toContain('<link>https://ai-watch.dev/#bedrock</link>')
  })

  // #874 — the NO_IS_DOWN_PAGE early-return sits ABOVE the new severity-hint logic, so a hash-route
  // service gets a bare `#id` with NO `?e=` hint even when it's down (there's no is-down OG page to pin).
  it('never appends a status hint to the hash-route fallback, even when down', () => {
    const xml = buildRssFeed([service({ id: 'bedrock', name: 'Bedrock', status: 'down', incidents: [incident()] })], { scope: 'all' }, NOW)
    expect(xml).toContain('<link>https://ai-watch.dev/#bedrock</link>')
    expect(xml).not.toContain('#bedrock?e=')
  })

  // #874 — an ACTIVE item pins the OG hint to the REAL severity, not the coarse `active` kind, so the
  // Slack unfurl of a genuine outage no longer mis-renders a green Operational card (HINT_TO_OG_STATUS
  // maps `active → operational`). operational (monitoring / green badge) still ships `active`.
  it('pins the ?e= hint to the live severity for an active outage item', () => {
    const degraded = buildRssFeed([service({ id: 'openai', status: 'degraded', incidents: [incident()] })], { scope: 'all' }, NOW)
    expect(degraded).toContain('<link>https://ai-watch.dev/is-openai-down?e=degraded&amp;utm_source=rss&amp;utm_medium=feed&amp;utm_campaign=outage</link>')

    const down = buildRssFeed([service({ id: 'openai', status: 'down', incidents: [incident()] })], { scope: 'all' }, NOW)
    expect(down).toContain('<link>https://ai-watch.dev/is-openai-down?e=down&amp;utm_source=rss&amp;utm_medium=feed&amp;utm_campaign=outage</link>')

    // operational service (e.g. an incident in `monitoring`, badge already green) keeps `?e=active`.
    const operational = buildRssFeed([service({ id: 'openai', status: 'operational', incidents: [incident({ status: 'monitoring' })] })], { scope: 'all' }, NOW)
    expect(operational).toContain('is-openai-down?e=active&amp;')
  })

  it('keeps ?e=resolved on a resolved item regardless of live status (#539 cache-bust)', () => {
    const xml = buildRssFeed(
      [service({ id: 'openai', status: 'down', incidents: [incident({ status: 'resolved', resolvedAt: '2026-05-10T13:00:00.000Z', duration: '1h' })] })],
      { scope: 'all' },
      NOW,
    )
    expect(xml).toContain('<link>https://ai-watch.dev/is-openai-down?e=resolved&amp;utm_source=rss&amp;utm_medium=feed&amp;utm_campaign=outage</link>')
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

  it('includes the latest timeline update in the description (resolved item, #768)', () => {
    // #768 — per-update timeline text + duration render on the RESOLVED item (one-time, stable); the
    // active item is status-invariant (covered separately). Only the latest entry is shown.
    const xml = buildRssFeed(
      [
        service({
          incidents: [
            incident({
              status: 'resolved',
              resolvedAt: '2026-05-10T13:20:00.000Z',
              duration: '1h 20m',
              timeline: [
                { stage: 'investigating', text: 'looking into it', at: '2026-05-10T12:00:00.000Z' },
                { stage: 'resolved', text: 'root cause found', at: '2026-05-10T13:20:00.000Z' },
              ],
            }),
          ],
        }),
      ],
      { scope: 'all' },
      NOW,
    )
    expect(xml).toContain('<p>root cause found</p>')
    expect(xml).toContain('1h 20m')
    expect(xml).not.toContain('looking into it')
  })

  it('falls back to the epoch for an unparseable startedAt', () => {
    const xml = buildRssFeed([service({ incidents: [incident({ startedAt: 'not-a-date' })] })], { scope: 'all' }, NOW)
    expect(xml).toContain(`<pubDate>${new Date(0).toUTCString()}</pubDate>`)
  })

  it('strips XML-forbidden C0 control characters but keeps tab/newline/CR', () => {
    // #768 — timeline text renders on the resolved item now; title sanitization applies to both.
    const xml = buildRssFeed(
      [service({ incidents: [incident({ title: 'errors\x00\x08\x1Fhere', status: 'resolved', resolvedAt: '2026-05-10T13:00:00.000Z', duration: '1h', timeline: [{ stage: 'resolved', text: 'line1\nline2\ttab', at: '2026-05-10T13:00:00.000Z' }] })] })],
      { scope: 'all' },
      NOW,
    )
    expect(xml).toContain('errorshere')
    expect(xml).not.toMatch(/[\x00\x08\x1F]/)
    expect(xml).toContain('line1\nline2\ttab')
  })
})

describe('buildRssFeed — active item content is status-invariant (#768)', () => {
  // The active item's description must be byte-identical across investigating→identified→monitoring
  // so Slack /feed (re-notifies on content change) posts it ONCE. AI is present from first emit via
  // the #759 hold; here we pass it so the item emits and assert stability across statuses.
  const ai: RssAiAnalysisMap = { claude: [{ incidentId: 'k', summary: 'analysis text', estimatedRecovery: '1h', affectedScope: ['Claude API'] }] }
  const descOf = (xml: string) => (xml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || [])[1]
  const buildAt = (status: 'investigating' | 'identified' | 'monitoring', text: string) =>
    buildRssFeed(
      [service({ status: 'down', incidents: [incident({ id: 'k', title: 'Outage', impact: 'major', status, timeline: [{ stage: status, text, at: '2026-05-10T12:00:00.000Z' }] })] })],
      { scope: 'all' }, NOW, ai, { k: '2026-05-19T08:55:00.000Z' },
    )

  it('description is identical across investigating → identified (the common churn the user saw)', () => {
    const d1 = descOf(buildAt('investigating', 'We are investigating'))
    const d2 = descOf(buildAt('identified', 'Root cause identified, fixing'))
    expect(d1).toBeTruthy()
    expect(d1).toBe(d2) // no Slack re-post on the investigating→identified transition
    // Stable payload (impact label + AI), NOT the volatile status word / per-update text.
    expect(d1).toContain('<strong>Major</strong>')
    expect(d1).toContain('🤖 AI analysis: analysis text')
    expect(d1).not.toContain('investigating')
    expect(d1).not.toContain('Root cause identified')
  })

  it('monitoring is the documented exception — AI block dropped (#724), so it differs by design', () => {
    // The #724 monitoring gate intentionally drops the AI block (recovery confirmed), so the
    // identified→monitoring transition is a distinct (rare, near-recovery) update — acceptable.
    expect(descOf(buildAt('identified', 'x'))).toContain('🤖 AI analysis')
    expect(descOf(buildAt('monitoring', 'x'))).not.toContain('🤖 AI analysis')
  })

  it('escapes markup in active-only fields (AI summary) — the active path stays injection-safe', () => {
    // The img-onerror/C0 tests moved to resolved items (timeline text is resolved-only now); cover
    // the fields that DO render on an active item (the AI summary) so the escaping path isn't lost.
    const evil: RssAiAnalysisMap = { claude: [{ incidentId: 'k', summary: '<img src=x onerror=alert(1)>', estimatedRecovery: '1h', affectedScope: [] }] }
    const xml = buildRssFeed(
      [service({ status: 'down', incidents: [incident({ id: 'k', title: 'Outage', impact: 'major', status: 'identified' })] })],
      { scope: 'all' }, NOW, evil, { k: '2026-05-19T08:55:00.000Z' },
    )
    expect(xml).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(xml).not.toContain('<img src=x')
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
    // Primary = first in SERVICES order (Claude API); the title carries the full co-affected set.
    expect(xml).toContain('🔴 Anthropic (Claude API, claude ai, Claude Code): Elevated errors') // 'major' → 🔴, #539 brand defused
    // #760 — the redundant "Also affecting" line is dropped; the grouped title already lists the set.
    expect(xml).not.toContain('Also affecting')
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

  it('keeps a single consolidated item in a service-scoped feed; the grouped title carries the co-affected set (#760)', () => {
    const xml = buildRssFeed(anthropic, { scope: 'service', service: anthropic[0] }, NOW)
    expect(xml).toContain('🔴 Anthropic (Claude API, claude ai, Claude Code): Elevated errors') // #539 brand defused
    expect(xml).not.toContain('Also affecting') // #760 — dropped (redundant with the grouped title)
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

describe('buildRssFeed — publish-before-analysis hold (#759)', () => {
  // AI_HOLD_MS = 6 min. NOW = 09:00:00Z.
  const FRESH = '2026-05-19T08:57:00.000Z'   // 3 min ago — inside the hold window
  const OLD = '2026-05-19T08:53:00.000Z'     // 7 min ago — past the hold window
  const aiMap: RssAiAnalysisMap = { claude: [{ incidentId: 'inc-1', summary: 'root cause found', estimatedRecovery: '1h', affectedScope: ['Claude API'] }] }
  const activeInc = incident({ id: 'inc-1', status: 'identified' })

  it('HOLDS an AI-less identified active item inside the hold window (item not emitted)', () => {
    const xml = buildRssFeed([service({ incidents: [activeInc] })], { scope: 'all' }, NOW, undefined, { 'inc-1': FRESH })
    expect(xml).not.toContain('aiwatch:claude:inc-1</guid>') // held — no item
    expect(xml).not.toContain('API errors')
  })

  it('EMITS the item once AI analysis exists, even inside the window', () => {
    const xml = buildRssFeed([service({ incidents: [activeInc] })], { scope: 'all' }, NOW, aiMap, { 'inc-1': FRESH })
    expect(xml).toContain('aiwatch:claude:inc-1</guid>')
    expect(xml).toContain('🤖 AI analysis: root cause found')
  })

  it('RELEASES (emits without AI) once first-seen age ≥ AI_HOLD_MS', () => {
    const xml = buildRssFeed([service({ incidents: [activeInc] })], { scope: 'all' }, NOW, undefined, { 'inc-1': OLD })
    expect(xml).toContain('aiwatch:claude:inc-1</guid>') // released
    expect(xml).not.toContain('🤖 AI analysis')           // still no AI block (genuinely skipped/timed-out)
  })

  it('fail-open: an AI-less active item with NO first-seen entry is emitted (not held indefinitely)', () => {
    const xml = buildRssFeed([service({ incidents: [activeInc] })], { scope: 'all' }, NOW)
    expect(xml).toContain('aiwatch:claude:inc-1</guid>')
  })

  it('#776 visibility-leak guard: a freshly-stamped firstseen (age 0, no AI) is HELD — not leaked to Slack', () => {
    // The #776 fix: /feed stamps firstseen at visibility (resolveFeedFirstSeen) so a pre-cron poll
    // anchors the hold instead of failing open. Simulate that: firstseen = NOW (age 0), no AI → held.
    const xml = buildRssFeed([service({ incidents: [activeInc] })], { scope: 'all' }, NOW, undefined, { 'inc-1': NOW.toISOString() })
    expect(xml).not.toContain('aiwatch:claude:inc-1</guid>') // held — no AI-less leak
  })

  it('never holds a `monitoring` item (AI excluded by design — posts immediately)', () => {
    const monitoringInc = incident({ id: 'inc-1', status: 'monitoring' })
    const xml = buildRssFeed([service({ incidents: [monitoringInc] })], { scope: 'all' }, NOW, undefined, { 'inc-1': FRESH })
    expect(xml).toContain('aiwatch:claude:inc-1</guid>') // emitted despite no AI + fresh first-seen
    expect(xml).not.toContain('🤖 AI analysis')
  })

  it('does NOT hold resolved items (the hold is active-only)', () => {
    const resolvedInc = incident({ id: 'inc-1', status: 'resolved', resolvedAt: '2026-05-19T08:58:00.000Z', duration: '1m' })
    const xml = buildRssFeed([service({ incidents: [resolvedInc] })], { scope: 'all' }, NOW, undefined, { 'inc-1': FRESH })
    expect(xml).toContain('aiwatch:claude:inc-1:resolved</guid>')
  })

  it('holds ALL surfaces of an AI-less shared incident — no item leaks under a sibling guid', () => {
    // A shared incidentId across 3 surfaces, all AI-less + fresh. The hold is per-surface, so verify
    // the dedup can't surface the incident under a sibling guid while the primary is held.
    const shared = incident({ id: 'sh-1', status: 'identified' })
    const svcs = [
      service({ id: 'claude', name: 'Claude API', incidents: [shared] }),
      service({ id: 'claudeai', name: 'claude.ai', incidents: [shared] }),
      service({ id: 'claudecode', name: 'Claude Code', incidents: [shared] }),
    ]
    const xml = buildRssFeed(svcs, { scope: 'all' }, NOW, undefined, { 'sh-1': FRESH })
    expect(xml).not.toContain('sh-1') // every surface held → zero items, no leak
  })

  it('releases exactly at the AI_HOLD_MS boundary (< is exclusive → 6 min posts)', () => {
    const SIX_MIN_AGO = '2026-05-19T08:54:00.000Z' // exactly 6 min before NOW
    const xml = buildRssFeed([service({ incidents: [activeInc] })], { scope: 'all' }, NOW, undefined, { 'inc-1': SIX_MIN_AGO })
    expect(xml).toContain('aiwatch:claude:inc-1</guid>') // age === AI_HOLD_MS → released
  })
})

describe('isActiveItemHeld (#759/#793 — shared hold predicate)', () => {
  // NOW = 09:00:00Z, AI_HOLD_MS = 6 min.
  const FRESH = '2026-05-19T08:57:00.000Z' // 3 min ago — inside window
  const OLD = '2026-05-19T08:53:00.000Z'   // 7 min ago — past window
  const ai = { incidentId: 'inc-1', summary: 's', estimatedRecovery: '1h', affectedScope: [] }

  it('HELD: AI-less investigating/identified item inside the window', () => {
    expect(isActiveItemHeld(incident({ status: 'identified' }), undefined, FRESH, NOW)).toBe(true)
  })
  it('NOT held once analysis exists (released for AI)', () => {
    expect(isActiveItemHeld(incident({ status: 'identified' }), ai, FRESH, NOW)).toBe(false)
  })
  it('NOT held past the window (age ≥ AI_HOLD_MS)', () => {
    expect(isActiveItemHeld(incident({ status: 'identified' }), undefined, OLD, NOW)).toBe(false)
  })
  it('NOT held when first-seen is unknown (fail-open)', () => {
    expect(isActiveItemHeld(incident({ status: 'identified' }), undefined, undefined, NOW)).toBe(false)
  })
  it('NEVER holds a monitoring item (AI excluded by design)', () => {
    expect(isActiveItemHeld(incident({ status: 'monitoring' }), undefined, FRESH, NOW)).toBe(false)
  })
  it('boundary: exactly AI_HOLD_MS is released (< is exclusive)', () => {
    expect(isActiveItemHeld(incident({ status: 'identified' }), undefined, '2026-05-19T08:54:00.000Z', NOW)).toBe(false)
  })
})

describe('buildRssFeed — orphan-resolution suppression (#793)', () => {
  // A short blip whose active item was NEVER served (no feed:active-emitted marker) must not post a
  // lone "Resolved" item. servedActive carries the incIds whose active item WAS served.
  const resolvedInc = incident({ id: 'inc-1', status: 'resolved', resolvedAt: '2026-05-19T08:58:00.000Z', duration: '19m' })

  it('SUPPRESSES the resolved item when its active item was never served (incId absent from servedActive)', () => {
    const xml = buildRssFeed([service({ incidents: [resolvedInc] })], { scope: 'all' }, NOW, undefined, undefined, new Set())
    expect(xml).not.toContain('aiwatch:claude:inc-1:resolved</guid>')
    expect(xml).not.toContain('<item>')
  })

  it('EMITS the resolved item when its active item WAS served (incId present in servedActive)', () => {
    const xml = buildRssFeed([service({ incidents: [resolvedInc] })], { scope: 'all' }, NOW, undefined, undefined, new Set(['inc-1']))
    expect(xml).toContain('aiwatch:claude:inc-1:resolved</guid>')
  })

  it('fail-open: with servedActive ABSENT, every resolved item is emitted (pre-#793 behavior preserved)', () => {
    const xml = buildRssFeed([service({ incidents: [resolvedInc] })], { scope: 'all' }, NOW)
    expect(xml).toContain('aiwatch:claude:inc-1:resolved</guid>')
  })

  it('does NOT affect active items — servedActive only gates the resolved branch', () => {
    // Active item with AI present (so the #759 hold doesn't suppress it) and an EMPTY servedActive:
    // the active item must still emit (servedActive must never suppress an active item).
    const ai: RssAiAnalysisMap = { claude: [{ incidentId: 'inc-1', summary: 's', estimatedRecovery: '1h', affectedScope: [] }] }
    const xml = buildRssFeed([service({ incidents: [incident({ id: 'inc-1', status: 'identified' })] })], { scope: 'all' }, NOW, ai, { 'inc-1': NOW.toISOString() }, new Set())
    expect(xml).toContain('aiwatch:claude:inc-1</guid>')
  })

  it('suppresses ALL surfaces of a shared resolved incident when unserved (keyed by incId)', () => {
    const shared = incident({ id: 'sh-1', status: 'resolved', resolvedAt: '2026-05-19T08:58:00.000Z', duration: '5m' })
    const svcs = [
      service({ id: 'claude', name: 'Claude API', incidents: [shared] }),
      service({ id: 'claudeai', name: 'claude.ai', incidents: [shared] }),
    ]
    const xml = buildRssFeed(svcs, { scope: 'all' }, NOW, undefined, undefined, new Set())
    expect(xml).not.toContain('sh-1')
  })

  it('buildFeedResponse threads servedActive through to the feed', () => {
    const cached = { services: [service({ incidents: [resolvedInc] })] }
    const suppressed = buildFeedResponse(cached, { scope: 'all' }, NOW, undefined, undefined, new Set())
    expect(suppressed.ok && !suppressed.xml.includes('inc-1:resolved')).toBe(true)
    const emitted = buildFeedResponse(cached, { scope: 'all' }, NOW, undefined, undefined, new Set(['inc-1']))
    expect(emitted.ok && emitted.xml.includes('inc-1:resolved')).toBe(true)
  })
})

describe('buildRssFeed — #760 feed format polish (dividers + no redundant "Also affecting")', () => {
  const DIV = '<p>┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈</p>'
  const ai: RssAiAnalysisMap = { claude: [{ incidentId: 'inc-1', summary: 'root cause', estimatedRecovery: '1h', affectedScope: ['Claude API'] }] }

  it('inserts a divider before the 🤖 AI block and before the ↪ Try-instead line (mirrors Discord)', () => {
    // Down service so the fallback ("Try instead") line is present; AI present so the AI block is too.
    const svcs = [
      service({ id: 'claude', name: 'Claude API', status: 'down', incidents: [incident({ id: 'inc-1', impact: 'major' })] }),
      service({ id: 'openai', name: 'OpenAI API', status: 'operational', uptime30d: 99.9 }),
    ]
    const xml = buildRssFeed(svcs, { scope: 'all' }, NOW, ai, { 'inc-1': NOW.toISOString() })
    const desc = (xml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || [])[1] ?? ''
    // two dividers: one before AI, one before Try-instead (count full DIV strings, not a substring)
    expect(desc.split(DIV).length - 1).toBe(2)
    // ordering: impact label … DIV … AI … DIV … Try instead
    expect(desc.indexOf(DIV)).toBeLessThan(desc.indexOf('🤖 AI analysis'))
    expect(desc.indexOf('🤖 AI analysis')).toBeLessThan(desc.lastIndexOf(DIV))
    expect(desc.lastIndexOf(DIV)).toBeLessThan(desc.indexOf('↪'))
  })

  it('no divider on a plain active item with neither AI nor fallback', () => {
    // operational-status service can still carry an incident; no fallback (not down/degraded), no AI.
    const xml = buildRssFeed([service({ status: 'operational', incidents: [incident({ id: 'inc-1' })] })], { scope: 'all' }, NOW, undefined, { 'inc-1': NOW.toISOString() })
    const desc = (xml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || [])[1] ?? ''
    expect(desc).not.toContain('┈┈┈┈┈┈')
  })

  it('drops "Also affecting" for a multi-surface incident (title already lists the set)', () => {
    const svcs = [
      service({ id: 'claude', name: 'Claude API', incidents: [incident({ id: 'shared', title: 'Errors' })] }),
      service({ id: 'claudeai', name: 'claude.ai', incidents: [incident({ id: 'shared', title: 'Errors' })] }),
    ]
    const xml = buildRssFeed(svcs, { scope: 'all' }, NOW)
    expect(xml).toContain('Anthropic') // provider-grouped title present
    expect(xml).not.toContain('Also affecting')
  })
})

describe('resolveFeedFirstSeen (#776) — stamp firstseen at feed-visibility so the #759 hold engages', () => {
  const NOW = '2026-06-24T13:24:00.000Z'

  it('clean miss (null) → use now AND stamp it (anchors the hold in the pre-cron window)', () => {
    expect(resolveFeedFirstSeen(null, NOW)).toEqual({ use: NOW, stamp: true })
  })

  it('existing value → use it, never re-stamp (preserves #750 first-write-wins / stable pubDate)', () => {
    const earlier = '2026-06-24T13:20:00.000Z'
    expect(resolveFeedFirstSeen(earlier, NOW)).toEqual({ use: earlier, stamp: false })
  })
})

describe('buildRssFeed — #781 grouped per-category "Try instead" (feed parity with dashboard)', () => {
  const tryLine = (xml: string) => (xml.match(/Try instead:[^<]*/g) || [])[0] ?? ''
  // operational fallback candidates across categories
  const ops = [
    service({ id: 'openai', name: 'OpenAI API', category: 'api', status: 'operational', uptime30d: 99.9 }),
    service({ id: 'gemini', name: 'Gemini API', category: 'api', status: 'operational', uptime30d: 99.8 }),
    service({ id: 'chatgpt', name: 'ChatGPT', category: 'app', status: 'operational', uptime30d: 99.7 }),
    service({ id: 'codex', name: 'Codex', category: 'agent', status: 'operational', uptime30d: 99.6 }),
  ]

  it('single-category incident → flat "Try instead: A · B" (unchanged top-2)', () => {
    const claude = service({ id: 'claude', name: 'Claude API', category: 'api', status: 'down', incidents: [incident({ id: 'solo', title: 'Errors' })] })
    const xml = buildRssFeed([claude, ...ops], { scope: 'all' }, NOW, undefined, { solo: '2026-05-19T08:45:00.000Z' })
    const line = tryLine(xml)
    expect(line).toContain('OpenAI API')
    expect(line).toContain('Gemini API')
    expect(line).not.toContain('→') // no category labels for a single-category incident
  })

  it('multi-category incident → labeled per-category groups (LLM/App/CLI Agent)', () => {
    const shared = incident({ id: 'multi', title: 'Opus errors' })
    const svcs = [
      service({ id: 'claude', name: 'Claude API', category: 'api', status: 'down', incidents: [shared] }),
      service({ id: 'claudeai', name: 'claude.ai', category: 'app', status: 'down', incidents: [shared] }),
      service({ id: 'claudecode', name: 'Claude Code', category: 'agent', status: 'down', incidents: [shared] }),
      ...ops,
    ]
    const xml = buildRssFeed(svcs, { scope: 'all' }, NOW, undefined, { multi: '2026-05-19T08:45:00.000Z' })
    const line = tryLine(xml)
    expect(line).toContain('LLM → OpenAI API')
    expect(line).toContain('AI Apps → ChatGPT')
    expect(line).toContain('CLI Agent → Codex')
  })
})

// #860 — conditional GET (ETag / Last-Modified + 304) + content-derived lastBuildDate.
describe('buildFeedWithMeta — content-derived lastModified (#860)', () => {
  const NEWER = '2026-05-18T00:00:00.000Z'
  const OLDER = '2026-05-01T00:00:00.000Z'

  it('lastModified = the newest emitted item pubDate', () => {
    const { xml, lastModified } = buildFeedWithMeta(
      [service({ incidents: [
        incident({ id: 'old', title: 'Older', startedAt: OLDER }),
        incident({ id: 'new', title: 'Newer', startedAt: NEWER }),
      ] })],
      { scope: 'all' }, NOW,
    )
    expect(lastModified?.toISOString()).toBe(NEWER)
    // and it is stamped into <lastBuildDate> (NOT `now`) so the body is deterministic
    expect(xml).toContain(`<lastBuildDate>${new Date(NEWER).toUTCString()}</lastBuildDate>`)
    expect(xml).not.toContain(`<lastBuildDate>${NOW.toUTCString()}</lastBuildDate>`)
  })

  it('lastModified is null for an empty feed, which OMITS lastBuildDate (stable body)', () => {
    const { xml, lastModified } = buildFeedWithMeta([service()], { scope: 'all' }, NOW)
    expect(lastModified).toBeNull()
    expect(xml).not.toContain('<lastBuildDate>')
  })

  it('an empty feed is byte-deterministic across polls (no now-stamped date → stable ETag)', () => {
    const a = buildFeedWithMeta([service()], { scope: 'all' }, NOW).xml
    const b = buildFeedWithMeta([service()], { scope: 'all' }, new Date('2027-01-01T00:00:00.000Z')).xml
    expect(a).toBe(b)
    expect(weakFeedEtag(a)).toBe(weakFeedEtag(b))
  })

  it('guards a malformed pubDate: lastModified is null (no "Invalid Date")', () => {
    const { xml, lastModified } = buildFeedWithMeta(
      [service({ incidents: [incident({ id: 'bad', status: 'resolved', resolvedAt: 'not-a-date' })] })],
      { scope: 'all' }, NOW,
    )
    expect(lastModified).toBeNull()
    expect(xml).not.toContain('Invalid Date')
  })

  it('emits a <ttl> hint aligned with the 60s cache window', () => {
    const { xml } = buildFeedWithMeta([service()], { scope: 'all' }, NOW)
    expect(xml).toContain('<ttl>1</ttl>')
  })

  it('is byte-deterministic across identical polls (the conditional-GET premise)', () => {
    const svcs = [service({ incidents: [incident({ id: 'a', startedAt: NEWER })] })]
    const a = buildFeedWithMeta(svcs, { scope: 'all' }, NOW).xml
    const b = buildFeedWithMeta(svcs, { scope: 'all' }, new Date('2026-05-19T23:59:59.000Z')).xml
    // different `now`, same incident set → identical body (lastBuildDate is content-derived)
    expect(a).toBe(b)
  })

  it('buildFeedResponse surfaces lastModified for all AND service scope (null when empty)', () => {
    const withInc = buildFeedResponse({ services: [service({ incidents: [incident({ id: 'a', startedAt: NEWER })] })] }, { scope: 'all' }, NOW)
    expect(withInc.ok && withInc.lastModified?.toISOString()).toBe(NEWER)
    const target = service({ id: 'claude', incidents: [incident({ id: 'a', startedAt: NEWER })] })
    const svc = buildFeedResponse({ services: [target] }, { scope: 'service', segment: 'claude' }, NOW)
    expect(svc.ok && svc.lastModified?.toISOString()).toBe(NEWER)
    const empty = buildFeedResponse({ services: [service()] }, { scope: 'all' }, NOW)
    expect(empty.ok && empty.lastModified).toBeNull()
  })
})

describe('weakFeedEtag (#860)', () => {
  it('is a weak validator, deterministic for the same body', () => {
    const tag = weakFeedEtag('<rss>hello</rss>')
    expect(tag.startsWith('W/"')).toBe(true)
    expect(weakFeedEtag('<rss>hello</rss>')).toBe(tag)
  })
  it('differs when the body differs (same length → exercises the hash, not just length)', () => {
    expect(weakFeedEtag('<rss>a</rss>')).not.toBe(weakFeedEtag('<rss>b</rss>'))
  })
})

// #860 — 304 is gated ONLY on the byte-exact If-None-Match ETag. If-Modified-Since
// is intentionally not honored (Last-Modified = newest pubDate is coarser than
// actual body change → would risk a false 304 dropping an in-place update).
describe('isFeedNotModified (#860 — ETag-only)', () => {
  const etag = weakFeedEtag('<rss>body</rss>')

  it('If-None-Match exact (weak) match → 304', () => {
    expect(isFeedNotModified(etag, etag)).toBe(true)
  })
  it('If-None-Match strong form matches weak etag value → 304', () => {
    expect(isFeedNotModified(etag.replace(/^W\//, ''), etag)).toBe(true)
  })
  it('If-None-Match list containing the etag → 304', () => {
    expect(isFeedNotModified(`"other", ${etag}`, etag)).toBe(true)
  })
  it('If-None-Match "*" → 304', () => {
    expect(isFeedNotModified('*', etag)).toBe(true)
  })
  it('If-None-Match mismatch → 200', () => {
    expect(isFeedNotModified('W/"nope"', etag)).toBe(false)
  })
  it('empty If-None-Match → 200', () => {
    expect(isFeedNotModified('', etag)).toBe(false)
  })
  it('no If-None-Match → 200', () => {
    expect(isFeedNotModified(null, etag)).toBe(false)
  })
})

// #860 — the handler's header contract, extracted so it is testable without a
// full request/KV mock: ETag on BOTH 200 and 304, 60s cache, Last-Modified only
// when present, 304 has an empty body.
describe('feedHttpResponse (#860)', () => {
  const LM = new Date('2026-05-18T00:00:00.000Z')

  it('200 with ETag + Last-Modified + 60s cache when no validators sent', async () => {
    const res = feedHttpResponse({ xml: '<rss>x</rss>', lastModified: LM }, null)
    expect(res.status).toBe(200)
    expect(res.headers.get('ETag')).toBe(weakFeedEtag('<rss>x</rss>'))
    expect(res.headers.get('Last-Modified')).toBe(LM.toUTCString())
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=60')
    expect(res.headers.get('Content-Type')).toContain('text/xml')
    expect(await res.text()).toBe('<rss>x</rss>')
  })

  it('304 (empty body) when If-None-Match matches, with the ETag re-sent', async () => {
    const etag = weakFeedEtag('<rss>x</rss>')
    const res = feedHttpResponse({ xml: '<rss>x</rss>', lastModified: LM }, etag)
    expect(res.status).toBe(304)
    expect(res.headers.get('ETag')).toBe(etag) // validator on the 304 too → next-poll revalidation
    expect(res.headers.get('Last-Modified')).toBe(LM.toUTCString())
    expect(await res.text()).toBe('')
  })

  it('200 when If-None-Match does not match', () => {
    expect(feedHttpResponse({ xml: '<rss>x</rss>', lastModified: LM }, 'W/"stale"').status).toBe(200)
  })

  it('omits Last-Modified for an empty feed (null lastModified) but still sets ETag', () => {
    const res = feedHttpResponse({ xml: '<rss></rss>', lastModified: null }, null)
    expect(res.headers.get('Last-Modified')).toBeNull()
    expect(res.headers.get('ETag')).toBe(weakFeedEtag('<rss></rss>'))
  })
})
