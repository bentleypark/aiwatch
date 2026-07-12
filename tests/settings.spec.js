import { test, expect } from './fixtures.js'
import { waitForDataLoad, navigateToSettings } from './helpers.js'

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage to avoid state pollution between tests
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await waitForDataLoad(page)
    await navigateToSettings(page)
    // Wait for Settings page content
    await expect(page.locator('main').getByText('General')).toBeVisible()
  })

  test('#546: deep-link #settings?focus=alerts routes to Settings and scrolls to the Alerts section', async ({ page }) => {
    // The Is-X-Down "Notify Me When Fixed" CTA links here; the outage visitor must land AT the
    // Alerts section, not the page top (the 3-clicks→0-registers friction).
    await page.goto('/#settings?focus=alerts')
    await page.reload({ waitUntil: 'domcontentloaded' }) // unambiguous fresh mount (beforeEach already sits on #settings; a fragment-only goto may not remount)
    await expect(page.locator('main').getByText('General')).toBeVisible() // routing unaffected by ?focus
    // Strict: the window must actually scroll so the Alerts section sits at/near the viewport top —
    // NOT merely intersect it (a long page can intersect #alerts at scrollY=0, which toBeInViewport
    // would false-pass). Poll the section's top until the scroll settles.
    await expect.poll(
      async () => page.locator('#alerts').evaluate((el) => Math.round(el.getBoundingClientRect().top)),
      { timeout: 15000 },
    ).toBeLessThan(120)
  })

  test('theme toggle persists to localStorage', async ({ page }) => {
    const html = page.locator('html')

    // Click Light theme button via evaluate to bypass pointer interception
    const lightBtn = page.locator('main button').filter({ hasText: 'Light' })
    await lightBtn.evaluate((el) => el.click())
    await expect(html).toHaveAttribute('data-theme', 'light')

    // Verify localStorage
    const stored = await page.evaluate(() => localStorage.getItem('aiwatch-theme'))
    expect(stored).toBe('light')

    // Reload and verify persistence (theme applies before API data loads)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(html).toHaveAttribute('data-theme', 'light')

    // Restore dark theme
    await navigateToSettings(page)
    const darkBtn = page.locator('main button').filter({ hasText: 'Dark' })
    await darkBtn.evaluate((el) => el.click())
    await expect(html).not.toHaveAttribute('data-theme', 'light')
  })

  test('Alert Targets "Custom" reveals a per-service picker (#470)', async ({ page }) => {
    const main = page.locator('main')
    // Default target is "All" — no picker rendered.
    await expect(main.getByText(/Alert services \(/)).toHaveCount(0)

    // Switch the Alert Targets segment to Custom → picker appears, all selected by default.
    await main.locator('button').filter({ hasText: /^Custom$/ }).evaluate((el) => el.click())
    await expect(main.getByText(/Alert services \(\d+\/\d+\)/)).toBeVisible()

    // "None" empties the selection → count 0 + an explicit "no alerts" warning.
    await main.locator('button').filter({ hasText: /^None$/ }).evaluate((el) => el.click())
    await expect(main.getByText(/Alert services \(0\//)).toBeVisible()
    await expect(main.getByText(/won't receive any alerts/)).toBeVisible()

    // Note: alertTarget/alertServices are only persisted through the Discord webhook
    // subscription flow (persistWebhookSettings), not via the general "Save settings"
    // button (#486 PR2). Persistence across reload is therefore not testable here without
    // a webhook URL.
  })

  test('language toggle switches UI text', async ({ page }) => {
    await expect(page.locator('main').getByText('General')).toBeVisible()

    // Switch to Korean
    const koBtn = page.locator('main button').filter({ hasText: '한국어' })
    await koBtn.evaluate((el) => el.click())

    // Verify Korean text appears
    await expect(page.locator('main').getByText('일반')).toBeVisible()
    await expect(page.locator('main').getByText('테마')).toBeVisible()

    // Verify localStorage
    const stored = await page.evaluate(() => localStorage.getItem('aiwatch-lang'))
    expect(stored).toBe('ko')

    // Switch back to English
    const enBtn = page.locator('main button').filter({ hasText: 'English' })
    await enBtn.evaluate((el) => el.click())
    await expect(page.locator('main').getByText('General')).toBeVisible()
  })

  test('save button shows feedback', async ({ page }) => {
    // Change a setting so save button becomes active
    const periodBtn = page.locator('main button').filter({ hasText: '30' }).first()
    await periodBtn.evaluate((el) => el.click())
    await page.waitForTimeout(200)
    const saveBtn = page.locator('main button').filter({ hasText: /저장|Save/ })
    await saveBtn.evaluate((el) => el.click())
    await expect(page.locator('main').getByText(/저장됨|Saved/)).toBeVisible()
    await expect(page.locator('main').getByText(/저장됨|Saved/)).toBeHidden({ timeout: 3000 })
  })

  test('theme & language live in the "Display" section, applied instantly — Save stays disabled (#582)', async ({ page }) => {
    // #582 — theme/lang are instant-apply (live switching + persisted on toggle), so they are NOT
    // governed by the Save button. They're separated into a "Display · applied instantly" section so
    // the user can tell save-required settings apart from instant ones.
    const main = page.locator('main')
    await expect(main.getByText(/Display|화면/).first()).toBeVisible()
    await expect(main.getByText(/Applied instantly|즉시 적용/)).toBeVisible()

    const saveBtn = main.locator('button').filter({ hasText: /저장|Save/ }).first()
    await expect(saveBtn).toBeDisabled() // fresh Settings, no save-required change

    // Changing language applies instantly (UI switches to Korean) but does NOT enable Save.
    await main.locator('button').filter({ hasText: '한국어' }).first().evaluate((el) => el.click())
    await expect(main.getByText('일반')).toBeVisible() // instant-apply confirmed
    await expect(saveBtn).toBeDisabled()              // language is not save-governed
  })

  test('a save-required setting (period) DOES enable the Save button — contrast with Display (#582)', async ({ page }) => {
    const saveBtn = page.locator('main button').filter({ hasText: /저장|Save/ }).first()
    await expect(saveBtn).toBeDisabled()
    await page.locator('main button').filter({ hasText: '30' }).first().evaluate((el) => el.click())
    await expect(saveBtn).toBeEnabled()
  })
})

test.describe('Settings — RSS feed (#433)', () => {
  test('Alerts section offers the all-services feed with copy-to-clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    // Navigate via the header gear (no API/mock data needed) so this doesn't
    // depend on the flaky waitForDataLoad path used by the suite's beforeEach.
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'AIWatch' }).first()).toBeVisible({ timeout: 15000 })
    await navigateToSettings(page)
    await expect(page.locator('main').getByText('General')).toBeVisible({ timeout: 20000 })

    // All-services feed URL surfaced in the Alerts section. There are now two read-only
    // inputs (RSS feed + Slack /feed command, #467) — the RSS feed is first in DOM order.
    const feedInput = page.locator('main input[readonly]').first()
    await expect(feedInput).toHaveValue('https://ai-watch.dev/feed.xml')
    const shownUrl = await feedInput.inputValue()

    // Copy button → clipboard + "Copied ✓" feedback (success path). Assert the
    // clipboard equals the *displayed* URL — what you see is what you copy, so a
    // future divergence between the input value and copyFeed() would fail here.
    // Scope to this row's button so the Slack /feed Copy button doesn't collide.
    const copyBtn = feedInput.locator('xpath=following-sibling::button')
    await copyBtn.click()
    await expect(copyBtn).toHaveText(/Copied ✓|복사됨 ✓/)
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shownUrl)
  })

  test('Alerts section offers the Slack /feed subscribe command with copy-to-clipboard (#467)', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'AIWatch' }).first()).toBeVisible({ timeout: 15000 })
    await navigateToSettings(page)
    await expect(page.locator('main').getByText('General')).toBeVisible({ timeout: 20000 })

    // Slack subscribes via its native /feed RSS app — no webhook. The command embeds the feed URL.
    // Second read-only input in DOM order (after the RSS feed URL).
    const slackInput = page.locator('main input[readonly]').nth(1)
    await expect(slackInput).toHaveValue('/feed subscribe https://ai-watch.dev/feed.xml')
    const shownCmd = await slackInput.inputValue()

    const copyBtn = slackInput.locator('xpath=following-sibling::button')
    await copyBtn.click()
    await expect(copyBtn).toHaveText(/Copied ✓|복사됨 ✓/)
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shownCmd)
  })
})
