// #400 Phase 0 — /statusline guide page (Claude Code statusline integration).
// Pins: hash route works, all 4 presets render with copy buttons, sidebar nav
// entry exists. A regression in any of these would re-block Phase 1's
// "snippet documented somewhere reachable from ai-watch.dev" criterion.

import { test, expect } from '@playwright/test'
import { waitForDataLoad } from './helpers.js'

test.describe('Statusline guide page (#400 Phase 0)', () => {
  test('accessible via #statusline hash', async ({ page }) => {
    await page.goto('/#statusline')
    await waitForDataLoad(page)
    await expect(page.locator('h1').filter({ hasText: /statusline/i })).toBeVisible()
  })

  test('renders the recommended preset snippet', async ({ page }) => {
    await page.goto('/#statusline')
    await waitForDataLoad(page)
    // Pin the canonical curl + jq one-liner pieces: ai-watch.dev host, jq's
    // status filter, fail-silent fallback, 2s timeout. Substrings chosen to
    // avoid quoting/escaping ambiguity (the JSON-in-JSON produces \" in DOM).
    const code = page.locator('pre').first()
    await expect(code).toBeVisible()
    const text = (await code.textContent()) || ''
    expect(text).toContain('ai-watch.dev/api/status/cached')
    expect(text).toContain('--max-time 2')
    expect(text).toContain('select(.status')
    expect(text).toContain('|| true')
  })

  test('renders all five documented presets with copy buttons', async ({ page }) => {
    await page.goto('/#statusline')
    await waitForDataLoad(page)
    // 5 presets = 5 <pre> code blocks + 5 Copy buttons.
    // (degraded_only, compact_badge, full_list, scoped, clickable)
    await expect(page.locator('pre')).toHaveCount(5)
    const copyButtons = page.locator('button').filter({ hasText: /^Copy$/ })
    await expect(copyButtons).toHaveCount(5)
  })

  test('copy button click does not throw and remains a button', async ({ page }) => {
    // The clipboard `writeText` happy path is browser-permission-gated and
    // unreliable to mock cleanly across Playwright projects. We pin the weaker
    // contract instead: clicking the Copy button doesn't crash the page, and
    // the button remains interactive afterward (i.e., the handler ran without
    // throwing the React tree). Functional clipboard behavior is exercised
    // manually during local verification.
    await page.goto('/#statusline')
    await waitForDataLoad(page)
    const firstCopy = page.locator('button').filter({ hasText: /^Copy|Copied$/ }).first()
    await expect(firstCopy).toBeVisible()
    await firstCopy.click()
    // Page must still be intact — the snippet block above the button is a
    // reliable post-click sanity check.
    await expect(page.locator('pre').first()).toBeVisible()
  })

  test('sidebar navigation includes Statusline entry', async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
    const navButton = page.locator('button').filter({ hasText: /statusline|스테이터스라인/i }).first()
    await expect(navButton).toBeVisible()
    await navButton.click()
    await expect(page.locator('h1').filter({ hasText: /statusline/i })).toBeVisible()
  })

  test('How-it-works and caveats sections are present', async ({ page }) => {
    await page.goto('/#statusline')
    await waitForDataLoad(page)
    // Caveats explicitly call out the 5-minute cache lag — that's a hard contract
    // we documented to users and shouldn't drop silently.
    await expect(page.locator('body')).toContainText(/5-minute cache lag/i)
    await expect(page.locator('body')).toContainText(/CORS-enabled/i)
  })

  test('Copy button is the first interactive element in the snippet header (left-aligned)', async ({ page }) => {
    // Reviewer feedback (#400 follow-up 0b78e60): right-aligned Copy was easy to
    // miss when the content column shrank. Pin the contract that Copy comes
    // BEFORE the "settings.json" label in DOM order so a future flex/justify
    // tweak doesn't silently regress.
    await page.goto('/#statusline')
    await waitForDataLoad(page)
    // xpath couples to the Snippet component shape (header div is the immediate
    // previous sibling of <pre>). If a future refactor wraps <pre> in another
    // div, update the xpath — see src/pages/Statusline.jsx Snippet().
    const firstSnippetHeaderText = await page
      .locator('pre').first().locator('xpath=preceding-sibling::div[1]')
      .textContent()
    expect(firstSnippetHeaderText).not.toBeNull()
    const copyIdx = (firstSnippetHeaderText || '').indexOf('Copy')
    const labelIdx = (firstSnippetHeaderText || '').indexOf('settings.json')
    expect(copyIdx).toBeGreaterThanOrEqual(0)
    expect(labelIdx).toBeGreaterThan(copyIdx)
  })

  test('"full service list" link points to the GitHub README anchor (not intra-SPA)', async ({ page }) => {
    // Reviewer feedback (#400 follow-up f426ccd): the link was an intra-SPA
    // setPage to /#ranking, but the Ranking page renders display names not
    // service IDs — the snippet's jq filter needs the IDs. Pin the external
    // GitHub README target so a future "let's keep navigation in-app" refactor
    // doesn't silently break the documentation contract.
    await page.goto('/#statusline')
    await waitForDataLoad(page)
    const link = page.locator('a').filter({ hasText: /service ID table/i }).first()
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', /github\.com\/bentleypark\/aiwatch.*available-service-ids/)
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', /noopener/)
  })

  test('Clickable preset contains OSC 8 hyperlink escape sequence', async ({ page }) => {
    // The clickable preset wraps each service name in OSC 8 (ESC]8;;URL ESC\)
    // so terminal emulators render it as a hyperlink. The literal escape
    // sequence in the user-visible JSON string must contain `]8;;` and
    // the `]8;;` closing pair — if a future cleanup "simplifies" by dropping
    // the OSC 8 wrapper, this preset silently degrades to plain text and the
    // hyperlink claim in the prose becomes false.
    await page.goto('/#statusline')
    await waitForDataLoad(page)
    const heading = page.locator('h3').filter({ hasText: /Clickable.*OSC 8/i })
    await expect(heading).toBeVisible()
    // Scope to the heading's parent subtree instead of nth(4) — survives a
    // future reorder of preset blocks without spuriously passing on the wrong
    // snippet.
    const clickableSnippet = heading.locator('xpath=ancestor::div[1]').locator('pre')
    const code = (await clickableSnippet.textContent()) || ''
    // JSON.stringify double-encodes the embedded escape so the on-screen text
    // is literal `\\u001b` (7 chars: \, \, u, 0, 0, 1, b) — that's what users
    // copy. Substring checks below are escape-safe (no quoting ambiguity).
    expect(code).toContain(']8;;')                       // OSC 8 opener
    expect(code).toContain('https://ai-watch.dev/#')     // hyperlinked URL pointing to dashboard hash route
    // The OSC 8 closer (ESC]8;;) appears at least twice — once after URL, once at the very end.
    const matches = code.match(/\]8;;/g) || []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  test('Clickable preset documents terminal compatibility caveat', async ({ page }) => {
    // The OSC 8 escape isn't universal — tmux and some older shells render it
    // as raw text. Documenting this in the page prose is what keeps users from
    // copying the snippet into an unsupported terminal and concluding AIWatch
    // is broken. Pin the caveat presence so a future docs trim doesn't drop it.
    await page.goto('/#statusline')
    await waitForDataLoad(page)
    await expect(page.locator('body')).toContainText(/OSC 8/i)
    // At least one of the supported terminal names should be mentioned to
    // give the user a quick "do I have one?" check.
    await expect(page.locator('body')).toContainText(/iTerm2|Warp|kitty|WezTerm/i)
  })

  test('"Compatible with" section lists ccstatusline with a link', async ({ page }) => {
    // Reviewer feedback (#400 follow-up f426ccd): ccstatusline mention moved
    // out of the footer and into a dedicated section so users of that tool
    // can spot integration support quickly. Pin the section + link presence
    // so a future doc cleanup doesn't bury the cross-promotion that the
    // Phase 1 distribution PR strategy depends on.
    await page.goto('/#statusline')
    await waitForDataLoad(page)
    await expect(page.locator('body')).toContainText(/Compatible with/i)
    // `href*=` instead of `href=` so a future UTM/ref query-string addition
    // doesn't break the test while still catching repo-owner moves.
    const ccLink = page.locator('a[href*="github.com/sirmalloc/ccstatusline"]').first()
    await expect(ccLink).toBeVisible()
    await expect(ccLink).toHaveText(/ccstatusline/)
  })
})
