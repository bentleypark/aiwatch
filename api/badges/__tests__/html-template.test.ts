import { describe, it, expect } from 'vitest'
import { renderBadgesPage, badgeMarkdownFor } from '../html-template'
import { SLUG_TO_SERVICE } from '../../is-down/slug-map'

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
