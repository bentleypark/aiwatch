import { test, expect } from './fixtures.js'
import { GA_HIT_RE } from './ga-hosts.js'

// #352 / #2070: consent gate for the Edge SSR surfaces. With consent denied or absent, no request
// for gtag.js and no collect request; with consent granted, GA4 fires normally. This spec asserts
// both halves with a Playwright network listener.
//
// GA4 issues collect requests to either domain depending on region/CDN routing:
//   - https://www.google-analytics.com/g/collect
//   - https://analytics.google.com/g/collect
// Both are matched by COLLECT_RE.

const COLLECT_RE = /(google-analytics\.com|analytics\.google\.com)\/g\/collect/

function recordCollect(page) {
  const hits = []
  page.on('request', (req) => {
    if (COLLECT_RE.test(req.url())) hits.push(req.url())
  })
  return hits
}

function recordGoogle(page) {
  const hits = []
  page.on('request', (req) => {
    const url = req.url()
    if (new URL(url).hostname === 'www.googletagmanager.com' || GA_HIT_RE.test(url)) hits.push(url)
  })
  return hits
}

async function getGaCookies(page) {
  const cookies = await page.context().cookies()
  return cookies.filter((c) => c.name.startsWith('_ga') || c.name.startsWith('_gid') || c.name.startsWith('_gcl_au'))
}

// #1164 — /is-claude-down became the Anthropic family group page (no GA4/consent-banner script of
// its own yet); the single-service consent/GA4 apparatus this spec exercises moved with the rest of
// the single-service content to /is-claude-api-down.
const SURFACES = [
  { name: '/is-claude-api-down', path: '/is-claude-api-down' },
  { name: '/intro', path: '/intro' },
]

for (const surface of SURFACES) {
  test.describe(`Consent gate (#352) — ${surface.name}`, () => {
    for (const [label, seed] of [['absent', null], ['explicitly denied', 'denied']]) {
      test(`nothing is requested from Google when consent is ${label}`, async ({ page }) => {
        const hits = recordGoogle(page)
        if (seed) {
          await page.addInitScript((value) => {
            try { localStorage.setItem('aiwatch-cookie-consent', value) } catch {}
          }, seed)
        }
        await page.goto(surface.path, { waitUntil: 'networkidle' })
        await page.waitForTimeout(1500) // catch any deferred GA request

        expect(hits).toEqual([])
        expect(await getGaCookies(page)).toHaveLength(0)
      })
    }

    test('Accept All starts GA4 on the same page view, without a reload', async ({ page }) => {
      const google = recordGoogle(page)
      const collect = recordCollect(page)
      await page.goto(surface.path, { waitUntil: 'networkidle' })
      await page.waitForTimeout(1000)
      expect(google).toEqual([])
      await page.evaluate(() => { window.__sameDocument = true })

      await page.locator('[data-aiwatch-cb="accept"]').click()

      await expect.poll(() => collect.length, { timeout: 10_000 }).toBeGreaterThan(0)
      expect(await page.evaluate(() => window.__sameDocument)).toBe(true)
    })

    test('g/collect fires AND _ga cookie is set when consent is granted', async ({ page }) => {
      const hits = recordCollect(page)
      await page.addInitScript(() => {
        try { localStorage.setItem('aiwatch-cookie-consent', 'granted') } catch {}
      })
      await page.goto(surface.path, { waitUntil: 'networkidle' })
      await page.waitForTimeout(2000) // GA4 first-event delay

      // At least one collect request must fire (page_view).
      expect(hits.length).toBeGreaterThan(0)

      // GA4 should set the _ga cookie under granted consent.
      const cookies = await getGaCookies(page)
      const gaCookie = cookies.find((c) => c.name === '_ga')
      expect(gaCookie, 'expected _ga cookie to be set when consent is granted').toBeDefined()
    })

    // #998 — the consent tests above deliberately grant consent, so GA4 genuinely tries to report.
    // The `blockGaHits` fixture must stop those hits from reaching the production property.
    //
    // The invariant is ZERO COMPLETIONS, not "aborted count == issued count": a hit that reaches
    // GA4 is by definition a request that got a response, and counting two async event streams at
    // one instant would flake on a collect issued late in the wait window (its `requestfailed`
    // could land after the assertion). `issued > 0` keeps the test from passing vacuously if GA4
    // ever stops attempting a hit here — at which point this no longer exercises the block.
    test('#998 — no collect request completes, so no hit reaches the production property', async ({ page }) => {
      const issued = recordCollect(page)
      const completed = []
      page.on('response', (res) => {
        if (COLLECT_RE.test(res.url())) completed.push(res.url())
      })
      await page.addInitScript(() => {
        try { localStorage.setItem('aiwatch-cookie-consent', 'granted') } catch {}
      })
      await page.goto(surface.path, { waitUntil: 'networkidle' })
      await page.waitForTimeout(2000)

      expect(issued.length, 'GA4 did not even attempt a hit — the test no longer exercises the block').toBeGreaterThan(0)
      expect(completed, 'a GA4 collect request completed — the fixture is not blocking hits').toEqual([])
    })
  })
}

test.describe('Consent banner DOM (#352)', () => {
  test('banner is visible on first visit (no consent key)', async ({ page }) => {
    await page.goto('/is-claude-api-down', { waitUntil: 'domcontentloaded' })
    const banner = page.locator('#aiwatch-cookie-banner')
    await expect(banner).toBeVisible()
  })

  test('banner is hidden when consent already granted', async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('aiwatch-cookie-consent', 'granted') } catch {}
    })
    await page.goto('/is-claude-api-down', { waitUntil: 'domcontentloaded' })
    const banner = page.locator('#aiwatch-cookie-banner')
    await expect(banner).toBeHidden()
  })

  test('clicking "Essential Only" writes "denied" and hides the banner', async ({ page }) => {
    await page.goto('/is-claude-api-down', { waitUntil: 'domcontentloaded' })
    await page.locator('[data-aiwatch-cb="essential"]').click()
    const stored = await page.evaluate(() => localStorage.getItem('aiwatch-cookie-consent'))
    expect(stored).toBe('denied')
    await expect(page.locator('#aiwatch-cookie-banner')).toBeHidden()
  })

  test('clicking "Accept All" writes "granted" and hides the banner', async ({ page }) => {
    await page.goto('/is-claude-api-down', { waitUntil: 'domcontentloaded' })
    await page.locator('[data-aiwatch-cb="accept"]').click()
    const stored = await page.evaluate(() => localStorage.getItem('aiwatch-cookie-consent'))
    expect(stored).toBe('granted')
    await expect(page.locator('#aiwatch-cookie-banner')).toBeHidden()
  })

  test('Accept-failure gating: when setItem throws, banner stays and GA4 does not start', async ({ page }) => {
    // Simulate Safari private mode / quota-exhausted: localStorage.setItem throws on the consent key.
    const google = recordGoogle(page)
    await page.addInitScript(() => {
      const origSet = Storage.prototype.setItem
      Storage.prototype.setItem = function (key, value) {
        if (key === 'aiwatch-cookie-consent') throw new Error('simulated quota')
        return origSet.call(this, key, value)
      }
    })
    await page.goto('/is-claude-api-down', { waitUntil: 'domcontentloaded' })
    await page.locator('[data-aiwatch-cb="accept"]').click()
    await page.waitForTimeout(1500)
    // Banner must remain visible — user re-prompted next interaction since choice didn't persist.
    await expect(page.locator('#aiwatch-cookie-banner')).toBeVisible()
    expect(google).toEqual([])
    expect(await page.evaluate(() => typeof window.gtag)).toBe('undefined')
  })
})
