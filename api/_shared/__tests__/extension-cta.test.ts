import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXTENSION_STORE_URL, FIREFOX_ADDON_URL, EXTENSION_STORES, renderExtInstallCta, isClaudeSurface } from '../extension-cta'

// #888 — the extension install CTA is URL-gated: a store whose URL is empty gets no link, and with
// every URL empty renderExtInstallCta returns '' so no CTA ships.
describe('renderExtInstallCta (#888)', () => {
  const NONE = { chrome: '', firefox: '' }
  it('returns "" when every store URL is empty (CTA hidden until a store approves)', () => {
    expect(renderExtInstallCta(NONE, { loc: 'is_down_page', variant: 'is-down' })).toBe('')
    expect(renderExtInstallCta(NONE, { loc: 'landing_cta', variant: 'landing' })).toBe('')
  })

  const URL = 'https://chromewebstore.google.com/detail/abcdef123456'
  const FX = 'https://addons.mozilla.org/firefox/addon/some-addon/'
  const CHROME_ONLY = { chrome: URL, firefox: '' }
  const BOTH = { chrome: URL, firefox: FX }

  it('is-down variant: a QUIET standalone strip (not a 5th button in the CTA block) with the store href + GA4 hook', () => {
    const html = renderExtInstallCta(CHROME_ONLY, { loc: 'is_down_page', variant: 'is-down' })
    expect(html).toContain(`href="${URL}"`)
    expect(html).toContain('data-ga="install_extension"')
    expect(html).toContain('data-ga-loc="is_down_page"')
    expect(html).toContain('class="ext-strip"') // standalone strip, NOT inside the .cta block
    expect(html).not.toContain('class="cta-alt"')
    expect(html).toContain('alt="Available in the Chrome Web Store"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener"')
  })

  it('landing variant: its own badge row under the cta-box buttons, with the store href + GA4 hook', () => {
    const html = renderExtInstallCta(CHROME_ONLY, { loc: 'landing_cta', variant: 'landing' })
    expect(html).toContain(`href="${URL}"`)
    expect(html).toContain('class="ext-badges"')
    expect(html).not.toContain('class="btn-secondary"')
    expect(html).toContain('data-ga="install_extension"')
    expect(html).toContain('data-ga-loc="landing_cta"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener"')
    expect(html).toContain('Claude Status') // names the Claude scope (landing is multi-service)
  })

  it('is CSP-clean — no inline event handler (GA4 fires via the delegated data-ga listener)', () => {
    const html = renderExtInstallCta(CHROME_ONLY, { loc: 'is_down_page', variant: 'is-down' })
    expect(html).not.toMatch(/\son(click|load|error|mouseover)=/i)
  })

  it('escapes the href + loc (defensive — both are trusted constants, but no attribute breakout)', () => {
    const html = renderExtInstallCta({ chrome: 'https://x.test/a?b=1&c=2', firefox: '' }, { loc: 'is_down_page', variant: 'is-down' })
    expect(html).toContain('b=1&amp;c=2')
    expect(html).not.toContain('b=1&c=2') // raw & would be unescaped
  })

  // #1773 — one link per store, each tagged with its store so install_extension clicks split by store.
  const anchors = (html: string): string[] => html.match(/<a [^>]*>/g) ?? []
  for (const variant of ['is-down', 'landing'] as const) {
    it(`${variant}: renders one link per non-empty store, tagged data-ga-source=<store>`, () => {
      const both = anchors(renderExtInstallCta(BOTH, { loc: 'x', variant }))
      expect(both).toHaveLength(2)
      expect(both[0]).toContain(`href="${URL}"`)
      expect(both[0]).toContain('data-ga-source="chrome"')
      expect(both[1]).toContain(`href="${FX}"`)
      expect(both[1]).toContain('data-ga-source="firefox"')
      for (const a of both) expect(a).toContain('data-ga="install_extension"')

      const fxOnly = anchors(renderExtInstallCta({ chrome: '', firefox: FX }, { loc: 'x', variant }))
      expect(fxOnly).toHaveLength(1)
      expect(fxOnly[0]).toContain('data-ga-source="firefox"')
    })
  }

  it('is-down variant: both store badges share ONE quiet strip', () => {
    const html = renderExtInstallCta(BOTH, { loc: 'is_down_page', variant: 'is-down' })
    expect(html.match(/class="ext-strip"/g)).toHaveLength(1)
    expect(html.match(/<img /g)).toHaveLength(2)
  })

  it('every badge src is a file shipped from public/, with an alt and both dimensions', () => {
    const imgs = renderExtInstallCta(BOTH, { loc: 'x', variant: 'landing' }).match(/<img [^>]*>/g) ?? []
    expect(imgs).toHaveLength(2)
    for (const img of imgs) {
      const src = img.match(/src="([^"]+)"/)![1]
      expect(src.startsWith('/'), src).toBe(true)
      expect(existsSync(join(__dirname, '../../../public', src)), src).toBe(true)
      expect(img).toMatch(/alt="[^"]+"/)
      expect(img).toMatch(/width="\d+" height="\d+"/)
    }
  })

  // Chrome's branding rules allow resizing only with the ratio preserved, so each rendered size must
  // keep the shipped file's own ratio (PNG IHDR / SVG viewBox).
  it('renders every badge at its source file ratio', () => {
    const imgs = renderExtInstallCta(BOTH, { loc: 'x', variant: 'landing' }).match(/<img [^>]*>/g) ?? []
    for (const img of imgs) {
      const [, src, w, h] = img.match(/src="([^"]+)".*width="(\d+)" height="(\d+)"/)!
      const file = readFileSync(join(__dirname, '../../../public', src))
      const [fw, fh] = src.endsWith('.png')
        ? [file.readUInt32BE(16), file.readUInt32BE(20)]
        : file.toString().match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!.slice(1).map(Number)
      expect(Math.abs(Number(w) / Number(h) - fw / fh), src).toBeLessThan(0.02)
    }
  })

  it('ships both live listings, and EXTENSION_STORES is built from them', () => {
    expect(FIREFOX_ADDON_URL).toBe('https://addons.mozilla.org/firefox/addon/aiwatch-claude-status/')
    expect(EXTENSION_STORES).toEqual({ chrome: EXTENSION_STORE_URL, firefox: FIREFOX_ADDON_URL })
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
