import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { renderExtensionPrivacyPage } from '../extension-privacy'

// #837 — the public /extension-privacy page (the Chrome Web Store privacy-policy URL for the
// extension). Static (no per-request data), so these assertions guard: it renders, is indexable +
// canonical, carries the required policy sections + the real contact email, honestly discloses the
// user-initiated report transmission (NOT a blanket "no data" claim), states it's separate from the
// website policy, and stays CSP-clean (no inline script / no inline event handlers, #482).
const html = renderExtensionPrivacyPage()

describe('renderExtensionPrivacyPage (#837)', () => {
  it('renders a full HTML document with the extension privacy title', () => {
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toMatch(/<title>[^<]*Privacy Policy[^<]*<\/title>/)
    expect(html).toContain('AIWatch — Claude Status')
  })

  it('is indexable + canonical to /extension-privacy', () => {
    expect(html).toContain('rel="canonical"')
    expect(html).toContain('https://ai-watch.dev/extension-privacy')
    expect(html).not.toMatch(/noindex/i)
  })

  it('carries the real contact email (Web Store requires a monitored contact)', () => {
    expect(html).toContain('contact@ai-watch.dev')
  })

  it('states it is SEPARATE from the website policy (no analytics/cookies/page-reading)', () => {
    expect(html).toMatch(/separate from/i)
    expect(html).toMatch(/no analytics/i)
  })

  it('honestly discloses the user-initiated report transmission (not a blanket "no data")', () => {
    expect(html).toMatch(/Report an issue/)
    expect(html).toMatch(/anonymous/i)
    // must describe transmitting data, not claim it transmits nothing
    expect(html).toMatch(/transmits|sends an anonymous report/i)
  })

  it('covers the required policy sections', () => {
    for (const heading of ['does NOT do', 'retention', 'Permissions', 'Third-party', 'rights', "Children", 'Changes', 'Contact']) {
      expect(html, `missing section: ${heading}`).toContain(heading)
    }
  })

  it('is CSP-clean — no inline <script> and no inline event handlers (#482)', () => {
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/\son(click|error|mouseover|load|change)=/i)
  })

  // The served page + extension/PRIVACY.md are two hand-kept copies. Pin the load-bearing facts so a
  // future edit to one can't silently drift from the other (Web Store links to the served page).
  it('agrees with extension/PRIVACY.md on the load-bearing facts', () => {
    const md = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension', 'PRIVACY.md'), 'utf8')
    for (const fact of ['contact@ai-watch.dev', 'every 2 minutes', 'separate from', 'no analytics']) {
      expect(html.toLowerCase(), `page missing: ${fact}`).toContain(fact.toLowerCase())
      expect(md.toLowerCase(), `PRIVACY.md missing: ${fact}`).toContain(fact.toLowerCase())
    }
  })
})
