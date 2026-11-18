import { describe, it, expect } from 'vitest'
import { renderLandingPage } from '../html-template'
import en from '../../../src/locales/en.js'
import { expectEveryStoreLink } from '../../_shared/__tests__/expect-store-links'

// #482 — CSP Phase 2: the /intro landing page must carry NO inline event handlers (all wired via
// delegated listeners) and nonce every executable inline <script>, so an enforcing CSP (no
// 'unsafe-inline') admits them. The behavioral side (lang toggle + RSS/Slack copy actually firing
// from the delegated listeners) is covered by tests/intro.spec.js (Playwright).
describe('renderLandingPage — CSP-clean (#482)', () => {
  const INLINE_HANDLER = /\son(click|change|input|submit|load|error|mouseover|mouseout|mousedown|mouseup|keydown|keyup|focus|blur)\s*=/i

  it('has ZERO inline event-handler attributes (handlers + hover refactored away)', () => {
    expect(INLINE_HANDLER.test(renderLandingPage({ nonce: 'n0' }))).toBe(false)
    expect(INLINE_HANDLER.test(renderLandingPage())).toBe(false)
    // the hover that was onmouseover/onmouseout is now a CSS :hover rule
    expect(renderLandingPage()).toContain('.stack-gh-link:hover')
  })

  it('the alert section offers Slack once, as a channel badge, with /feed as the fallback (#1581)', () => {
    const html = renderLandingPage({ nonce: 'n0' })
    expect(html.match(/data-ga="click_add_to_slack" data-ga-loc="landing_alert"/g)).toHaveLength(1)
    expect(html).toContain('<button type="button" class="alert-feed-alt" data-action="copy-slack">')
    expect(html).toContain("'alert.slack.feedAlt'")
  })

  it('every Slack button on the landing page installs the app; only the fallback copies /feed (#1581)', () => {
    const html = renderLandingPage({ nonce: 'n0' })
    expect(html).toContain('<a class="ch-badge ch-slack" href="https://aiwatch-worker.p2c2kbf.workers.dev/api/slack/install" title="Add AIWatch to a Slack channel" data-ga="click_add_to_slack" data-ga-loc="landing_alert" data-ga-source="slack_badge">')
    expect(html).toContain('<a class="btn-slack" href="https://aiwatch-worker.p2c2kbf.workers.dev/api/slack/install" style="padding:12px 24px;" data-ga="click_add_to_slack" data-ga-loc="landing_cta">')
    expect(html.match(/<button[^>]*data-action="copy-slack"/g)).toHaveLength(1)
    expect(html).not.toMatch(/class="btn-primary[^"]*"[^>]*api\/slack\/install/)
  })

  it('rewires the removed handlers as delegated listeners + data-attributes', () => {
    const html = renderLandingPage({ nonce: 'n0' })
    // lang toggle
    expect(html).toContain('data-lang="ko"')
    expect(html).toMatch(/querySelectorAll\('\.lang-btn'\)[\s\S]*addEventListener\('click'/)
    // RSS + Slack copy
    expect(html).toContain('data-action="copy-rss"')
    expect(html).toContain('data-action="copy-slack"')
    expect(html).toMatch(/querySelectorAll\('\[data-action="copy-rss"\]'\)[\s\S]*addEventListener\('click'/)
    expect(html).toMatch(/querySelectorAll\('\[data-action="copy-slack"\]'\)[\s\S]*addEventListener\('click'/)
    // GA4 delegated handler
    expect(html).toContain('data-ga="click_dashboard"')
    expect(html).toMatch(/closest\('\[data-ga\]'\)[\s\S]*gtag\('event'/)
  })

  it('preserves each GA4 event identity (location + the Discord badge custom source)', () => {
    const html = renderLandingPage()
    expect(html).toContain('data-ga="click_dashboard" data-ga-loc="landing_nav"')
    expect(html).toContain('data-ga="click_github_header" data-ga-loc="landing_stack"')
    expect(html).toContain('data-ga="click_cta_alerts" data-ga-loc="landing_footer"')
    // #826's Discord badge used source:'discord_badge' (not 'intro') — carried on data-ga-source,
    // read by the delegated handler (defaults to 'intro' otherwise).
    expect(html).toContain('data-ga="click_cta_alerts" data-ga-loc="landing_alert" data-ga-source="discord_badge"')
    expect(html).toContain("source: el.getAttribute('data-ga-source') || 'intro'")
  })

  it('stamps the nonce on the consent init + interactivity scripts + cookie banner', () => {
    const html = renderLandingPage({ nonce: 'NONCE123' })
    const tags = html.match(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>/g) ?? []
    expect(tags.length).toBeGreaterThanOrEqual(3) // consent init + interactivity + cookie banner
    for (const tag of tags) expect(tag).toContain('nonce="NONCE123"')
    expect(html).toMatch(/<script async nonce="NONCE123" src="https:\/\/www\.googletagmanager\.com/)
    expect(html).toMatch(/<script type="application\/ld\+json">/)
  })

  it('omits the nonce attribute entirely when no nonce is passed', () => {
    expect(renderLandingPage()).not.toContain('nonce="')
  })
})

describe('renderLandingPage — extension install CTA', () => {
  it('carries one install link per extension store (#1773)', () => {
    expectEveryStoreLink(renderLandingPage(), 'landing_cta')
  })
})

// #2031 — dashboard wording the preview mock imitates, built from en.js.
type Strings = Record<string, string>
// The Overview's category tabs, in its order: 'all' then SECTION_KEYS (src/pages/Overview.jsx).
const CATEGORY_TABS = ['filter.all', 'filter.llm', 'filter.agents', 'filter.voice', 'filter.inference', 'filter.observability', 'filter.video', 'filter.image', 'filter.apps']
const MOCK_WORDING: Array<[label: string, text: (t: Strings) => string]> = [
  ['Affected now heading', (t) => t['overview.affected.title']],
  ['Affected now scope', (t) => `· ${t['overview.affected.scope']}`],
  ['affected count', (t) => t['overview.affected.degraded'].replace('{n}', '1')],
  ['view incident details', (t) => t['overview.banner.viewIncidents']],
  ['suggested fallback', (t) => t['overview.banner.fallback']],
  ['entry start line', (t) => `${t['incidents.time.started']} 14:23 UTC · ${t['incidents.status.ongoing']}`],
  ['recent incidents title', (t) => `${t['overview.incidents.title']} <span`],
  ['recent incident status', (t) => `>${t['incidents.status.ongoing']}<`],
  ['running stat', (t) => t['overview.stats.operational.sub']],
  ['affected stat', (t) => t['overview.stats.degraded.sub']],
  ['average stat', (t) => t['overview.stats.uptime.sub']],
  ['all filter', (t) => `>${t['overview.filter.all']} 50<`],
  ['operational filter', (t) => `${t['overview.filter.operational']} 49`],
  ['issues filter', (t) => `${t['overview.filter.issues']} 1`],
  ['operational stat label', (t) => `mock-stat-label">${t['overview.stats.operational']}<`],
  ['degraded stat label', (t) => `mock-stat-label">${t['overview.stats.degraded']}<`],
  ['down stat label', (t) => `mock-stat-label">${t['overview.stats.down']}<`],
  ['average stat label', (t) => `mock-stat-label">${t['overview.stats.uptime']}<`],
  ['down stat sub', (t) => `>${t['overview.stats.down.sub']}<`],
  ...CATEGORY_TABS.map((key): [string, (t: Strings) => string] => [
    `category tab ${key}`,
    (t) => `mock-cat-tab${key === 'filter.all' ? ' active' : ''}">${t[key].replace(/&/g, '&amp;')}<`,
  ]),
  ['LLM section header', (t) => `green-slash">//</span> ${t['filter.llm']}<`],
]

const CARD_LABELS: Array<(t: Strings) => string> = [
  (t) => `mock-card-metric-label">${t['overview.card.latency.api']}<`,
  (t) => `mock-card-metric-label">${t['overview.card.uptime']}<`,
  (t) => `mock-card-metric-label">${t['overview.card.incidents']}<`,
  (t) => `mock-card-score-label">${t['score.bar.label']}<`,
]

describe('renderLandingPage — dashboard preview wording (#2031)', () => {
  const html = renderLandingPage().toLowerCase()
  const t = en as Strings

  it('the banner sits above the stat cards, as in the Overview', () => {
    expect(html.indexOf(t['overview.affected.title'].toLowerCase())).toBeGreaterThan(-1)
    expect(html.indexOf(t['overview.affected.title'].toLowerCase())).toBeLessThan(html.indexOf(t['overview.stats.operational.sub'].toLowerCase()))
  })

  it('both degraded pills (banner entry and Claude API card) say what the dashboard says', () => {
    expect(html.split(`badge-warn">${t['status.degraded']}<`.toLowerCase()).length - 1).toBeGreaterThanOrEqual(2)
  })

  it('every sample card carries the dashboard\'s metric and score labels', () => {
    const cards = html.split('class="mock-card-header"').length - 1
    expect(cards).toBeGreaterThan(0)
    for (const label of CARD_LABELS) {
      const wanted = label(t).toLowerCase()
      expect(wanted, 'a locale key behind a card label is gone from src/locales/en.js').not.toContain('undefined')
      expect(html.split(wanted).length - 1, wanted).toBe(cards)
    }
  })

  it('on each card the compact line comes before the 30-day bars, and a card with no open incident omits the count', () => {
    const cards = html.split('class="mock-card-header"').slice(1)
    expect(cards).toHaveLength(3)
    for (const card of cards) {
      const compact = card.indexOf('class="mock-card-compact"')
      expect(compact).toBeGreaterThan(-1)
      expect(compact).toBeLessThan(card.indexOf('class="mock-history"'))
    }
    expect(html).toContain(`>1${t['overview.card.incidents.compact']}<`.toLowerCase())
    expect(html).not.toContain(`0${t['overview.card.incidents.compact']}`.toLowerCase())
  })

  it.each(MOCK_WORDING)('the mock says what the dashboard says: %s', (_label, text) => {
    let wanted = ''
    try { wanted = text(t) } catch { /* a key behind this row is gone */ }
    expect(typeof wanted === 'string' && wanted !== '' && !wanted.includes('undefined'), 'a locale key behind this row is gone from src/locales/en.js').toBe(true)
    expect(html).toContain(wanted.toLowerCase())
  })
})
