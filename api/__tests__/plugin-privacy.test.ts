import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { renderPluginPrivacyPage } from '../plugin-privacy'

// #920 — the public /plugin-privacy page (the claude-community marketplace privacy-policy URL for
// the Claude Code plugin). Static (no per-request data), so these assertions guard: it renders, is
// indexable + canonical, carries the required policy sections + the real contact email, honestly
// discloses what it DOES transmit (outbound GET polls + anonymous aggregate counting — NOT a blanket
// "no data" claim), states it's separate from the website policy, and stays CSP-clean (#482).
const html = renderPluginPrivacyPage()

describe('renderPluginPrivacyPage (#920)', () => {
  it('renders a full HTML document with the plugin privacy title', () => {
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toMatch(/<title>[^<]*Privacy Policy[^<]*<\/title>/)
    expect(html).toContain('AIWatch for Claude Code')
  })

  it('is indexable + canonical to /plugin-privacy', () => {
    expect(html).toContain('rel="canonical"')
    expect(html).toContain('https://ai-watch.dev/plugin-privacy')
    expect(html).not.toMatch(/noindex/i)
  })

  it('carries the real contact email (the marketplace requires a monitored contact)', () => {
    expect(html).toContain('contact@ai-watch.dev')
  })

  it('states it is SEPARATE from the website policy (no cookies/analytics/code-reading)', () => {
    expect(html).toMatch(/separate from/i)
    expect(html).toMatch(/no cookies/i)
    expect(html).toMatch(/reads.*(no|none).*code/i)
  })

  it('honestly discloses what it transmits (outbound polls + anonymous aggregate count, not a blanket "no data")', () => {
    expect(html).toMatch(/transmits/i)
    expect(html).toMatch(/anonymous/i)
    expect(html).toMatch(/aggregate/i)
  })

  it('covers the required policy sections', () => {
    for (const heading of ['does NOT do', 'transmits', 'usage measurement', 'retention', 'Third-party', 'rights', "Children", 'Changes', 'Contact']) {
      expect(html, `missing section: ${heading}`).toContain(heading)
    }
  })

  it('is CSP-clean — no inline <script> and no inline event handlers (#482)', () => {
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/\son(click|error|mouseover|load|change)=/i)
  })

  // The served page + plugin/aiwatch/README.md's Privacy section are two hand-kept copies. Pin the
  // load-bearing facts so a future edit to one can't silently drift from the other (the marketplace
  // links to the served page; the README ships in the plugin bundle).
  it('agrees with plugin/aiwatch/README.md on the load-bearing facts', () => {
    const md = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin', 'aiwatch', 'README.md'), 'utf8')
    for (const fact of ['anonymous', 'public', 'agpl']) {
      expect(html.toLowerCase(), `page missing: ${fact}`).toContain(fact)
      expect(md.toLowerCase(), `README.md missing: ${fact}`).toContain(fact)
    }
  })
})
