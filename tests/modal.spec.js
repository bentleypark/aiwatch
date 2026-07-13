import { test, expect } from './fixtures.js'
import { waitForDataLoad, navigateVia } from './helpers.js'

test.describe('Modal / Detail Panel', () => {
  test('Incidents detail panel opens and closes', async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
    await navigateVia(page, 'Incidents')

    // Find incident rows in rowgroup (skip header row)
    const incidentRows = page.locator('main [role="rowgroup"] [role="row"]')
    const count = await incidentRows.count()
    if (count === 0) {
      // No incidents available (live data may have none) — skip gracefully
      return
    }
    await incidentRows.first().click({ force: true })
    // Detail panel shows close button with "닫기" / "Close" text
    const closeBtn = page.locator('main').getByRole('button', { name: /닫기|Close/i })
    await expect(closeBtn).toBeVisible()

    await closeBtn.evaluate((el) => el.click())
    await expect(closeBtn).toBeHidden({ timeout: 5000 })
  })

  test('Privacy modal opens from footer and closes on ESC, restoring focus', async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)

    // Scroll to footer and open privacy link. focus() before click() so the trigger is the
    // document.activeElement at showModal() time — native <dialog> returns focus there on close.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    const privacyBtn = page.getByRole('button', { name: /개인정보|Privacy/i })
    await privacyBtn.waitFor({ state: 'visible' })
    await privacyBtn.evaluate((el) => { el.focus(); el.click() })

    // Modal should be visible
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByText(/수집하는 정보|Information We Collect/)).toBeVisible()

    // Close with ESC (native <dialog> cancel→close)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    // Native <dialog> restores focus to the trigger (AC: "focus returns to trigger")
    await expect(privacyBtn).toBeFocused()
  })

  test('Privacy modal closes on the ✕ button', async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    const privacyBtn = page.getByRole('button', { name: /개인정보|Privacy/i })
    await privacyBtn.waitFor({ state: 'visible' })
    await privacyBtn.evaluate((el) => el.click())

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // ✕ is the one app-owned close path (ESC/backdrop are browser-native). It must call onClose()
    // → setModal(null) → unmount; a regression to a direct dialog.close() would leave isOpen=true.
    await dialog.getByRole('button', { name: /닫기|Close/i }).evaluate((el) => el.click())
    await expect(dialog).toBeHidden()
  })

  test('Terms modal opens and closes on backdrop click', async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    const termsBtn = page.getByRole('button', { name: /이용약관|Terms/i })
    await termsBtn.waitFor({ state: 'visible' })
    await termsBtn.evaluate((el) => el.click())

    // Modal should be visible
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByText(/서비스 개요|Service Overview/)).toBeVisible()

    // Close by clicking the backdrop. boundingBox() returns the PANEL rect (the <dialog> is the panel);
    // a click 20px above it lands on the ::backdrop region, where e.target === dialog and the point is
    // outside the panel rect → the JS handleClick guard (and native closedby) closes it. Assumes the
    // panel is centered with backdrop above (true at min(600,90vw)/80vh on the default test viewport).
    const box = await page.locator('dialog').boundingBox()
    await page.mouse.click(box.x + box.width / 2, Math.max(2, box.y - 20))
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('Terms modal external license link opens in a new tab', async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    const termsBtn = page.getByRole('button', { name: /이용약관|Terms/i })
    await termsBtn.waitFor({ state: 'visible' })
    await termsBtn.evaluate((el) => el.click())
    await expect(page.getByRole('dialog')).toBeVisible()

    // The AGPL link is external; without target="_blank" it navigates the SPA away (full reload on
    // back → modal lost). Assert it opens in a new tab with a safe rel. Regression guard for the
    // same-tab-navigation bug found during #481 verification.
    const license = page.getByRole('dialog').getByRole('link', { name: /AGPL-3\.0/i })
    await expect(license).toHaveAttribute('target', '_blank')
    await expect(license).toHaveAttribute('rel', /noopener/)
  })
})
