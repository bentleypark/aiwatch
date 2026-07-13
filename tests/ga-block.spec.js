// #998 — proof that the GA4 block in tests/fixtures.js is live.
//
// This lives in the always-run `desktop` project on purpose. The block's real job is to protect
// LOCAL runs: `.env` is gitignored, so `VITE_GA4_ID` is empty in CI and the SPA never loads gtag.js
// there — meaning CI would happily stay green with a broken block while every developer's
// `npm test` resumed reporting into the production property. A typo in GA_HIT_RE fails OPEN and is
// otherwise invisible. So the assertion has to be independent of consent state and of whether a GA4
// id is configured: drive a request at a collect endpoint directly and require that WE killed it.
//
// Both tests assert on `failure().errorText`, never on whether the request reached Google — an
// abort we issue surfaces as `net::ERR_FAILED`, while a real network problem surfaces as
// `ERR_CONNECTION_REFUSED` / `ERR_NAME_NOT_RESOLVED` / `ERR_INTERNET_DISCONNECTED`. That distinction
// is what keeps this suite off the live-dependency flake path (`feedback_deflake_proddata_e2e`):
// an offline machine can neither fake a pass nor cause a false red.
import { test, expect } from './fixtures.js'

const ABORTED = 'net::ERR_FAILED' // what Playwright's route.abort() produces in Chromium

// Record every request failure, keyed by host substring, so a test can ask "did WE abort this?"
function recordFailures(page) {
  const failures = []
  page.on('requestfailed', (req) => failures.push({ url: req.url(), errorText: req.failure()?.errorText }))
  return failures
}

test.describe('GA4 hit block (#998)', () => {
  test('a request to a GA4 collect endpoint is aborted, so no hit can reach the property', async ({ page }) => {
    const failures = recordFailures(page)
    await page.goto('/')

    const outcome = await page.evaluate(
      (u) => fetch(u, { mode: 'no-cors' }).then(() => 'completed', () => 'failed'),
      'https://www.google-analytics.com/g/collect?v=2&tid=G-TEST&en=page_view',
    )
    expect(outcome, 'a GA4 collect request COMPLETED — tests/fixtures.js is not blocking hits').toBe('failed')

    const collect = failures.filter((f) => f.url.includes('google-analytics.com'))
    expect(collect.length, 'no requestfailed recorded for the collect request').toBeGreaterThan(0)
    // The point of this assertion: a `failed` fetch on an offline machine would satisfy the check
    // above without the fixture doing anything. Requiring OUR abort code makes the pass mean
    // "the block killed it", not "the network happened to be down".
    for (const f of collect) {
      expect(f.errorText, `collect failed for a reason other than our abort: ${f.errorText}`).toBe(ABORTED)
    }
  })

  test('googletagmanager.com is not aborted — gtag.js stays reachable', async ({ page }) => {
    // The carve-out consent.spec.js depends on: gtag.js carries no measurement, and the `_ga`
    // cookie that spec asserts is written by gtag.js itself. Blocking it would break that suite in
    // a way that reads as unrelated, so pin the boundary here. Asserting "we did not abort it"
    // rather than "it loaded" keeps the test independent of Google's CDN being up.
    const failures = recordFailures(page)
    await page.goto('/')

    await page.evaluate(
      (u) => fetch(u, { mode: 'no-cors' }).catch(() => {}),
      'https://www.googletagmanager.com/gtag/js?id=G-TEST',
    )

    const aborted = failures.filter((f) => f.url.includes('googletagmanager.com') && f.errorText === ABORTED)
    expect(aborted, 'gtag.js was aborted — GA_HIT_RE has widened past the carve-out in tests/ga-hosts.js').toEqual([])
  })
})
