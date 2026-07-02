import { describe, it, expect } from 'vitest'
import { renderBadgesPage, badgeMarkdownFor } from '../html-template'
import { SLUG_TO_SERVICE } from '../../_is-down/slug-map'

describe('badgeMarkdownFor (#805) — links to the crawlable is-down page', () => {
  it('builds markdown with the worker service id image + is-down link (slug == id)', () => {
    expect(badgeMarkdownFor('claude')).toBe(
      '[![Claude API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/claude)](https://ai-watch.dev/is-claude-down)',
    )
  })
  it('uses the worker id (not the slug) for the image when they differ', () => {
    // slug 'claude-ai' → worker id 'claudeai'; 'github-copilot' → 'copilot'
    expect(badgeMarkdownFor('claude-ai')).toContain('/badge/claudeai)')
    expect(badgeMarkdownFor('claude-ai')).toContain('](https://ai-watch.dev/is-claude-ai-down)')
    expect(badgeMarkdownFor('github-copilot')).toContain('/badge/copilot)')
    expect(badgeMarkdownFor('github-copilot')).toContain('](https://ai-watch.dev/is-github-copilot-down)')
  })
  it('NEVER emits a non-crawlable hash route', () => {
    for (const slug of Object.keys(SLUG_TO_SERVICE)) {
      expect(badgeMarkdownFor(slug)).not.toContain('ai-watch.dev/#')
      expect(badgeMarkdownFor(slug)).toContain(`](https://ai-watch.dev/is-${slug}-down)`)
    }
  })
})

describe('renderBadgesPage', () => {
  const html = renderBadgesPage()

  it('renders SEO head (title, canonical /badges, indexable)', () => {
    expect(html).toContain('<title>AI Status Badges')
    expect(html).toContain('<link rel="canonical" href="https://ai-watch.dev/badges">')
    expect(html).toContain('index, follow')
  })

  it('renders a card for EVERY service in SLUG_TO_SERVICE (no service dropped by grouping)', () => {
    for (const slug of Object.keys(SLUG_TO_SERVICE)) {
      const id = SLUG_TO_SERVICE[slug].id
      expect(html).toContain(`/badge/${id}"`) // the live badge <img>
      expect(html).toContain(`/is-${slug}-down`) // its crawlable link
    }
  })

  it('every service group is covered by GROUP_ORDER (none silently omitted)', () => {
    const GROUPS = new Set(['llm', 'agents', 'voice', 'inference', 'observability', 'video', 'image', 'apps'])
    for (const slug of Object.keys(SLUG_TO_SERVICE)) {
      expect(GROUPS.has(SLUG_TO_SERVICE[slug].group)).toBe(true)
    }
  })

  it('contains no non-crawlable hash-route badge links', () => {
    expect(html).not.toContain('ai-watch.dev/#')
  })

  it('wires the copy_badge GA4 event from the badges page', () => {
    expect(html).toContain("location:'badges_page'")
    expect(html).toContain('function copyBadge(')
  })
})

// #482 — CSP Phase 2: no inline event handlers, all interactivity via delegated listeners,
// every inline <script> nonce-stamped so an enforcing CSP (no 'unsafe-inline') admits them.
describe('renderBadgesPage — CSP-clean (#482)', () => {
  const INLINE_HANDLER = /\son(click|change|input|submit|load|error|mouseover|mouseout|mousedown|mouseup|keydown|keyup|focus|blur)\s*=/i

  it('has ZERO inline event-handler attributes', () => {
    expect(INLINE_HANDLER.test(renderBadgesPage('n0'))).toBe(false)
    // the no-arg form (pre-#482 callers/tests) is clean too
    expect(INLINE_HANDLER.test(renderBadgesPage())).toBe(false)
  })

  it('wires the removed handlers as delegated listeners (select + copy)', () => {
    const html = renderBadgesPage('n0')
    expect(html).toMatch(/querySelectorAll\('\.badge-input'\)[\s\S]*addEventListener\('click'/)
    expect(html).toMatch(/querySelectorAll\('\.badge-copy'\)[\s\S]*addEventListener\('click'/)
  })

  it('stamps the nonce on EVERY inline <script> (consent + copyBadge + cookie banner)', () => {
    const html = renderBadgesPage('NONCE123')
    const scripts = html.match(/<script(?![^>]*\bsrc=)[^>]*>/g) ?? [] // inline (no src) script open-tags
    expect(scripts.length).toBeGreaterThanOrEqual(3) // consent init + copyBadge + cookie banner
    for (const tag of scripts) expect(tag).toContain('nonce="NONCE123"')
    // the gtag.js loader (has src) is also nonce-stamped for GA4 nonce propagation
    expect(html).toMatch(/<script async nonce="NONCE123" src="https:\/\/www\.googletagmanager\.com/)
  })

  it('omits the nonce attribute entirely when no nonce is passed (no stray nonce="")', () => {
    expect(renderBadgesPage()).not.toContain('nonce="')
  })
})
