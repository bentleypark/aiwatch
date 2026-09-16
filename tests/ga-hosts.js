// #998 — the GA4 *measurement* endpoints, kept in a dependency-free module so the CI-gated
// `npm run test:scripts` can pin them (importing tests/fixtures.js would drag in @playwright/test).
//
// This regex is the load-bearing piece of the block: a typo here fails OPEN — every test run
// silently resumes reporting into the production property — so it is unit-tested in
// scripts/check-e2e-ga-guard.test.mjs rather than only exercised end-to-end.

// Hits land on `/g/collect` (and `/mp/collect`), served from the regional variants the CSP allows
// (`www.` / `region1.` google-analytics.com) or from analytics.google.com.
//
// googletagmanager.com is deliberately NOT matched: gtag.js is a static script that carries no
// measurement, and tests/consent.spec.js needs it to load — the `_ga` cookie that spec asserts is
// written client-side by gtag.js, not by a collect response.
export const GA_HIT_RE = /(google-analytics\.com|analytics\.google\.com)\//

// #1436 — the is-down audience beacon (`api/_shared/audience-beacon.ts`) posts to the PRODUCTION
// worker from any host, including the Vercel Preview the Edge E2E job runs against, whose origin the
// worker allows. Unblocked, every PR run booked its page loads as real audience in `growth:daily`.
export const AUDIENCE_BEACON_RE = /\/api\/pageview(?:$|[?#])/
