import { describe, it, expect } from 'vitest'
import { renderPluginInstall, PLUGIN_MARKETPLACE_URL, PLUGIN_INSTALL_CMD } from '../_shared/plugin-cta'
import { renderPluginPage } from '../_plugin/html-template'

// #920 — the /plugin Edge SSR landing page. Pins the install gate + the CSP/SEO contract so the
// page can't silently regress to a non-indexable or inline-handler (CSP-breaking) shape.

describe('renderPluginInstall gate (#920)', () => {
  it('ships pending (empty URL) by default — safe before marketplace approval', () => {
    expect(PLUGIN_MARKETPLACE_URL).toBe('')
    const out = renderPluginInstall('')
    expect(out).toContain('In review')          // pending note
    expect(out).toContain(PLUGIN_INSTALL_CMD)   // commands still shown for reference
    expect(out).not.toContain('View on the community marketplace') // no live link while pending
  })

  it('goes live when the URL is set → commands + marketplace link (GA4-tagged)', () => {
    const out = renderPluginInstall('https://github.com/anthropics/claude-plugins-community')
    expect(out).toContain(PLUGIN_INSTALL_CMD)
    expect(out).toContain('View on the community marketplace')
    expect(out).toContain('data-ga="view_plugin_marketplace"')
    expect(out).not.toContain('In review')
  })

  it('HTML-escapes to stay injection-safe', () => {
    // The commands are static, but the render must not emit a raw < that could break out of markup.
    expect(renderPluginInstall('')).not.toMatch(/<script/i)
  })
})

describe('renderPluginPage SSR contract (#920)', () => {
  const html = renderPluginPage('test-nonce')

  it('is an indexable HTML doc with the canonical /plugin URL + SoftwareApplication JSON-LD', () => {
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<link rel="canonical" href="https://ai-watch.dev/plugin">')
    expect(html).toContain('<meta name="robots" content="index, follow">')
    expect(html).toContain('"@type":"SoftwareApplication"')
    expect(html).toContain('AIWatch for Claude Code')
  })

  it('is CSP-clean — no inline event handlers; the one <script> carries the nonce', () => {
    expect(html).not.toMatch(/\son[a-z]+=/i)          // no on*="..." inline handlers
    expect(html).toContain('<script nonce="test-nonce">')
  })

  it('renders the (gated) install section + the discoverability cross-link to the statusline guide', () => {
    expect(html).toContain(PLUGIN_INSTALL_CMD)
    expect(html).toContain('ai-watch.dev/#statusline')
  })
})
