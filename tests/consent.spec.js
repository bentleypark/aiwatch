import { test, expect } from './fixtures.js'

// #352: GDPR consent gate for Edge SSR + Jekyll surfaces.
//
// CLAUDE.md acceptance criteria: "with consent denied/absent, no requests to
// google-analytics.com/g/collect from these routes; with consent granted, GA4 fires
// normally". This spec asserts both halves with a Playwright network listener.
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
    test('no _ga cookie set when consent is absent (Consent Mode v2 default-denied)', async ({ page }) => {
      const hits = recordCollect(page)
      // No prior localStorage seed → consent key is absent on first visit.
      await page.goto(surface.path, { waitUntil: 'networkidle' })
      await page.waitForTimeout(1500) // catch any deferred GA pings

      // Acceptance criterion: no analytics cookies are written to the user's device.
      // Privacy Policy documents that cookieless pings still flow under Consent Mode v2
      // — those carry a per-request `cid` that is NOT persisted in any cookie.
      expect(await getGaCookies(page)).toHaveLength(0)

      // If a collect ping fires, it MUST signal denied consent (gcs=G1xx where 1=denied).
      // gcs=G111 / G110 / G100 all indicate analytics_storage=denied.
      for (const url of hits) {
        const gcs = (url.match(/[?&]gcs=([^&]+)/) || [])[1]
        expect(gcs, `g/collect must carry gcs=denied marker, got ${url}`).toMatch(/^G1/)
      }
    })

    test('no _ga cookie set when localStorage explicitly denies consent', async ({ page }) => {
      const hits = recordCollect(page)
      await page.addInitScript(() => {
        try { localStorage.setItem('aiwatch-cookie-consent', 'denied') } catch {}
      })
      await page.goto(surface.path, { waitUntil: 'networkidle' })
      await page.waitForTimeout(1500)

      expect(await getGaCookies(page)).toHaveLength(0)
      for (const url of hits) {
        const gcs = (url.match(/[?&]gcs=([^&]+)/) || [])[1]
        expect(gcs, `g/collect must carry gcs=denied marker, got ${url}`).toMatch(/^G1/)
      }
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

  test('Accept-failure gating: when setItem throws, banner stays + no consent upgrade fires', async ({ page }) => {
    // Simulate Safari private mode / quota-exhausted: localStorage.setItem throws on the
    // consent key. Capture every gtag call so we can assert no "consent","update","granted"
    // ever fires under this failure mode.
    await page.addInitScript(() => {
      const origSet = Storage.prototype.setItem
      Storage.prototype.setItem = function (key, value) {
        if (key === 'aiwatch-cookie-consent') throw new Error('simulated quota')
        return origSet.call(this, key, value)
      }
      window.__gtagCalls = []
      const realPush = Array.prototype.push
      // Hook the dataLayer queue instead of window.gtag directly — gtag() pushes into
      // dataLayer, so monkey-patching the queue captures all calls regardless of when
      // gtag.js arrives.
      Object.defineProperty(window, 'dataLayer', {
        configurable: true,
        get() { return this._dataLayer || (this._dataLayer = []) },
        set(v) { this._dataLayer = v },
      })
      const wrappedPush = function (...args) {
        for (const a of args) window.__gtagCalls.push(a)
        return realPush.apply(this, args)
      }
      // Wait for dataLayer init then attach the spy.
      const interval = setInterval(() => {
        if (window.dataLayer && !window.dataLayer.__hooked) {
          window.dataLayer.push = wrappedPush
          window.dataLayer.__hooked = true
          clearInterval(interval)
        }
      }, 5)
    })
    await page.goto('/is-claude-api-down', { waitUntil: 'domcontentloaded' })
    await page.locator('[data-aiwatch-cb="accept"]').click()
    // Banner must remain visible — user re-prompted next interaction since choice didn't persist.
    await expect(page.locator('#aiwatch-cookie-banner')).toBeVisible()
    // Consent state stays denied — no upgrade-to-granted ever queued.
    const grantedCalls = await page.evaluate(() =>
      (window.__gtagCalls || []).filter(
        (c) => Array.isArray(c) && c[0] === 'consent' && c[1] === 'update' && c[2]?.analytics_storage === 'granted'
      ).length
    )
    expect(grantedCalls, 'no gtag(consent, update, granted) call must fire when persistence failed').toBe(0)
  })
})
