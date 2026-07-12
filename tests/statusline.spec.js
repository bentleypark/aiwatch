// #400 Phase 0 — /statusline guide page (Claude Code statusline integration).
// Pins: hash route works, all 6 presets render with copy buttons, sidebar nav
// entry exists, and each preset is a thin curl at its per-preset path
// `/api/statusline/<preset>` (#918 — the Worker renders the final string
// server-side; the path is both the route and the WAE adoption tag). A regression
// in any of these would re-block Phase 1's "snippet documented somewhere reachable
// from ai-watch.dev" criterion or silently invalidate the traction baseline.

import { test, expect } from './fixtures.js'
import { waitForDataLoad } from './helpers.js'

test.describe('Statusline guide page (#400 Phase 0)', () => {
  test('accessible via #statusline hash', async ({ page }) => {
    await page.goto('/#statusline')
    await waitForDataLoad(page)
    await expect(page.locator('h1').filter({ hasText: /statusline/i })).toBeVisible()
  })

  test('renders the recommended preset snippet (thin curl, no jq — #918)', async ({ page }) => {
    await page.goto('/#statusline')
    await waitForDataLoad(page)
    // Pin the canonical thin-curl pieces: the Worker host + per-preset path (#438 —
    // polls hit the Worker directly, not the Vercel-proxied ai-watch.dev path),
    // 2s timeout, fail-silent fallback. The display logic is server-side now (#918),
    // so there is NO jq in the snippet.
    const code = page.locator('pre').first()
    await expect(code).toBeVisible()
    const text = (await code.textContent()) || ''
    expect(text).toContain('aiwatch-worker.p2c2kbf.workers.dev/api/statusline/branded')
    expect(text).not.toContain('ai-watch.dev/api/') // must not poll the Vercel-proxied path
    expect(text).not.toContain('jq')                // formatting moved server-side
    expect(text).toContain('--max-time 2')
    expect(text).toContain('|| true')
  })

  test('renders all six documented presets with copy buttons', async ({ page }) => {
    await page.goto('/#statusline')
    await waitForDataLoad(page)
    // 6 presets = 6 <pre> code blocks + 6 Copy buttons.
    // (branded [quick start], compact_badge, full_list, scoped, clickable, degraded_only [minimalist])
    await expect(page.locator('pre')).toHaveCount(6)
    const copyButtons = page.locator('button').filter({ hasText: /^Copy$/ })
    await expect(copyButtons).toHaveCount(6)
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

  test('every preset is a thin curl at its own /api/statusline/<preset> path (#918)', async ({ page }) => {
    // The per-preset path is BOTH the route and the WAE adoption tag (#400/#918):
    // it makes statusline traffic distinguishable per preset AND (since #918) is
    // the single place the display logic is selected — the snippet itself is a
    // dumb curl. A refactor that collapses the paths or reintroduces client jq
    // would re-block the gate or re-freeze the formatting on users' machines.
    // Preset order matches Statusline.jsx render order: Quick start (branded) then
    // Other presets (compact_badge, full_list, scoped, clickable, degraded_only).
    await page.goto('/#statusline')
    await waitForDataLoad(page)
    const presetOrder = ['branded', 'compact_badge', 'full_list', 'scoped', 'clickable', 'degraded_only']
    const preBlocks = page.locator('pre')
    await expect(preBlocks).toHaveCount(presetOrder.length)
    for (let i = 0; i < presetOrder.length; i++) {
      const text = (await preBlocks.nth(i).textContent()) || ''
      // This preset's path must be present AND not replaced by another preset's
      // path (catches "all snippets share one path" inline-helper regressions).
      expect(text, `preset #${i} (${presetOrder[i]}) snippet`).toContain(`/api/statusline/${presetOrder[i]}`)
      expect(text, `preset #${i} (${presetOrder[i]}) must have no jq`).not.toContain('jq')
      for (const other of presetOrder) {
        if (other === presetOrder[i]) continue
        expect(text, `preset #${i} (${presetOrder[i]}) must not carry path for ${other}`).not.toContain(`/api/statusline/${other}`)
      }
    }
  })

  test('"How it works" documents server-side rendering + the no-identifier guarantee (#918)', async ({ page }) => {
    // Transparency contract: the section explains the request carries the preset in
    // its PATH (not a query tag / identifier) and that formatting is server-side
    // (the "improvements reach you automatically" property that motivated #918).
    // Scoped to the "How it works" <section> so a snippet <pre> elsewhere can't mask
    // a deleted prose bullet.
    await page.goto('/#statusline')
    await waitForDataLoad(page)
    const howItWorks = page.locator('section').filter({ hasText: /How it works/i })
    await expect(howItWorks).toHaveCount(1)
    await expect(howItWorks).toContainText(/\/api\/statusline\//)
    // The no-identifier guarantee must remain explicit (negation-anchored so prose
    // that accidentally describes collecting an identifier can't satisfy it).
    await expect(howItWorks).toContainText(/(?:no|never).{0,40}user identifier/i)
  })

  test('Clickable preset documents terminal compatibility caveat', async ({ page }) => {
    // The Worker emits OSC 8 hyperlinks for the branded/clickable presets, but the
    // escape isn't universal — tmux and some older shells render it as raw text.
    // Documenting this in the prose keeps users from copying the snippet into an
    // unsupported terminal and concluding AIWatch is broken.
    await page.goto('/#statusline')
    await waitForDataLoad(page)
    await expect(page.locator('body')).toContainText(/OSC 8/i)
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
