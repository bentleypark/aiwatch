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

  test('renders all four documented presets with copy buttons', async ({ page }) => {
    await page.goto('/#statusline')
    await waitForDataLoad(page)
    // 4 presets = 4 <pre> code blocks + 4 Copy buttons.
    await expect(page.locator('pre')).toHaveCount(4)
    const copyButtons = page.locator('button').filter({ hasText: /^Copy$/ })
    await expect(copyButtons).toHaveCount(4)
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
})
