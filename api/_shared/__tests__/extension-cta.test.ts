import { describe, it, expect } from 'vitest'
import { EXTENSION_STORE_URL, renderExtInstallCta, isClaudeSurface } from '../extension-cta'

// #888 — the "install the Chrome extension" CTA is URL-gated: EXTENSION_STORE_URL is empty until the
// extension is approved + published, and while empty renderExtInstallCta returns '' so no CTA ships.
describe('renderExtInstallCta (#888)', () => {
  it('returns "" when the URL is empty (CTA hidden until CWS approval)', () => {
    expect(renderExtInstallCta('', { loc: 'is_down_page', variant: 'is-down' })).toBe('')
    expect(renderExtInstallCta('', { loc: 'landing_cta', variant: 'landing' })).toBe('')
  })

  const URL = 'https://chromewebstore.google.com/detail/abcdef123456'

  it('is-down variant: a QUIET standalone strip (not a 5th button in the CTA block) with the store href + GA4 hook', () => {
    const html = renderExtInstallCta(URL, { loc: 'is_down_page', variant: 'is-down' })
    expect(html).toContain(`href="${URL}"`)
    expect(html).toContain('data-ga="install_extension"')
    expect(html).toContain('data-ga-loc="is_down_page"')
    expect(html).toContain('class="ext-strip"') // standalone strip, NOT inside the .cta block
    expect(html).not.toContain('class="cta-alt"')
    expect(html).toContain('Add to Chrome')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener"')
  })

  it('landing variant: cta-box secondary button with the store href + GA4 hook', () => {
    const html = renderExtInstallCta(URL, { loc: 'landing_cta', variant: 'landing' })
    expect(html).toContain(`href="${URL}"`)
    expect(html).toContain('class="btn-secondary"')
    expect(html).toContain('data-ga="install_extension"')
    expect(html).toContain('data-ga-loc="landing_cta"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener"')
    expect(html).toContain('Claude Status') // names the Claude scope (landing is multi-service)
  })

  it('is CSP-clean — no inline event handler (GA4 fires via the delegated data-ga listener)', () => {
    const html = renderExtInstallCta(URL, { loc: 'is_down_page', variant: 'is-down' })
    expect(html).not.toMatch(/\son(click|load|error|mouseover)=/i)
  })

  it('escapes the href + loc (defensive — both are trusted constants, but no attribute breakout)', () => {
    const html = renderExtInstallCta('https://x.test/a?b=1&c=2', { loc: 'is_down_page', variant: 'is-down' })
    expect(html).toContain('b=1&amp;c=2')
    expect(html).not.toContain('b=1&c=2') // raw & would be unescaped
  })

  it('isClaudeSurface — only the 3 Anthropic surfaces (the extension is Claude-only; no CTA on /is-openai-down etc.)', () => {
    expect(isClaudeSurface('claude')).toBe(true)
    expect(isClaudeSurface('claudeai')).toBe(true)
    expect(isClaudeSurface('claudecode')).toBe(true)
    expect(isClaudeSurface('openai')).toBe(false)
    expect(isClaudeSurface('gemini')).toBe(false)
    expect(isClaudeSurface('')).toBe(false)
  })

  it('ships the live CWS listing URL (extension approved 2026-07-07, #837) — CTA now on everywhere', () => {
    // Was empty pre-approval; flipped once the extension cleared Chrome Web Store review. Must stay the
    // canonical /detail/{slug}/{id} URL — id as the terminal segment, no tracking params (?hl/?authuser)
    // and no extra path tail — so every share is clean. One regex pins slug-then-id + no query/hash.
    expect(EXTENSION_STORE_URL).toMatch(
      /^https:\/\/chromewebstore\.google\.com\/detail\/[^/?#]+\/mmngmhijlancegmfgcbegiackjkalocc$/,
    )
  })
})
