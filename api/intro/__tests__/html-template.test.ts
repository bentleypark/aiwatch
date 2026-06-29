import { describe, it, expect } from 'vitest'
import { renderLandingPage } from '../html-template'

// #482 — CSP Phase 2: the /intro landing page must carry NO inline event handlers (all wired via
// delegated listeners) and nonce every executable inline <script>, so an enforcing CSP (no
// 'unsafe-inline') admits them. The behavioral side (lang toggle + RSS copy actually firing from
// the delegated listeners) is covered by tests/intro.spec.js (Playwright).
describe('renderLandingPage — CSP-clean (#482)', () => {
  const INLINE_HANDLER = /\son(click|change|input|submit|load|error|mouseover|mouseout|mousedown|mouseup|keydown|keyup|focus|blur)\s*=/i

  it('has ZERO inline event-handler attributes (handlers + hover refactored away)', () => {
    expect(INLINE_HANDLER.test(renderLandingPage({ nonce: 'n0' }))).toBe(false)
    expect(INLINE_HANDLER.test(renderLandingPage())).toBe(false)
    // the hover that was onmouseover/onmouseout is now a CSS :hover rule
    expect(renderLandingPage()).toContain('.stack-gh-link:hover')
  })

  it('rewires the removed handlers as delegated listeners + data-attributes', () => {
    const html = renderLandingPage({ nonce: 'n0' })
    // lang toggle: data-lang + delegated .lang-btn listener
    expect(html).toContain('data-lang="ko"')
    expect(html).toMatch(/querySelectorAll\('\.lang-btn'\)[\s\S]*addEventListener\('click'/)
    // RSS copy: data-action + delegated listener
    expect(html).toContain('data-action="copy-rss"')
    expect(html).toMatch(/querySelectorAll\('\[data-action="copy-rss"\]'\)[\s\S]*addEventListener\('click'/)
    // GA4: data-ga links + a single delegated [data-ga] click handler
    expect(html).toContain('data-ga="click_dashboard"')
    expect(html).toMatch(/closest\('\[data-ga\]'\)[\s\S]*gtag\('event'/)
  })

  it('stamps the nonce on the consent init + interactivity scripts + cookie banner', () => {
    const html = renderLandingPage({ nonce: 'NONCE123' })
    // executable inline scripts (no src, not JSON-LD) all carry the nonce
    const tags = html.match(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>/g) ?? []
    expect(tags.length).toBeGreaterThanOrEqual(3) // consent init + interactivity + cookie banner
    for (const tag of tags) expect(tag).toContain('nonce="NONCE123"')
    // gtag.js loader (src) nonce-stamped for GA4 propagation; JSON-LD stays clean
    expect(html).toMatch(/<script async nonce="NONCE123" src="https:\/\/www\.googletagmanager\.com/)
    expect(html).toMatch(/<script type="application\/ld\+json">/)
  })

  it('omits the nonce attribute entirely when no nonce is passed', () => {
    expect(renderLandingPage()).not.toContain('nonce="')
  })

  it('still preserves the GA4 event identity (location carried on data-ga-loc)', () => {
    const html = renderLandingPage()
    // a representative set of the migrated events keeps its location label
    expect(html).toContain('data-ga="click_dashboard" data-ga-loc="landing_nav"')
    expect(html).toContain('data-ga="click_github_header" data-ga-loc="landing_stack"')
    expect(html).toContain('data-ga="click_cta_alerts" data-ga-loc="landing_cta"')
  })
})
