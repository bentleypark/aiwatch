import { describe, it, expect } from 'vitest'
import { renderLandingPage } from '../html-template'

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
