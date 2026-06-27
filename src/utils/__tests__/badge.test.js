import { describe, it, expect } from 'vitest'
import { buildBadgeLinkTarget, buildBadgeMarkdown } from '../badge'
import { SERVICE_ID_TO_SLUG } from '../../../api/is-down/slug-map'

describe('buildBadgeLinkTarget — #805 backlinks must hit the crawlable is-down page', () => {
  it('links to the is-down page when slug == id', () => {
    expect(buildBadgeLinkTarget('claude')).toBe('https://ai-watch.dev/is-claude-down')
  })

  it('uses the slug override when id != slug (claudeai → claude-ai)', () => {
    expect(buildBadgeLinkTarget('claudeai')).toBe('https://ai-watch.dev/is-claude-ai-down')
  })

  it.each([
    ['copilot', 'github-copilot'],
    ['claudecode', 'claude-code'],
    ['langsmith', 'langchain'],
    ['bfl', 'flux'],
    ['characterai', 'character-ai'],
  ])('resolves the override slug for %s → is-%s-down', (id, slug) => {
    expect(buildBadgeLinkTarget(id)).toBe(`https://ai-watch.dev/is-${slug}-down`)
  })

  it('NEVER emits a non-crawlable hash route for a service that has an is-down page', () => {
    for (const id of Object.keys(SERVICE_ID_TO_SLUG)) {
      expect(buildBadgeLinkTarget(id)).toMatch(/^https:\/\/ai-watch\.dev\/is-[a-z0-9-]+-down$/)
    }
  })

  it('falls back to the SPA detail route for services with no is-down page (bedrock/azureopenai)', () => {
    expect(buildBadgeLinkTarget('bedrock')).toBe('https://ai-watch.dev/#bedrock')
    expect(buildBadgeLinkTarget('azureopenai')).toBe('https://ai-watch.dev/#azureopenai')
  })
})

describe('buildBadgeMarkdown', () => {
  it('embeds the badge image and links it to the is-down page', () => {
    expect(buildBadgeMarkdown('claude', 'Claude API')).toBe(
      '[![Claude API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/claude)](https://ai-watch.dev/is-claude-down)',
    )
  })
})
