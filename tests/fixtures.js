// #998 — every e2e spec must import `test` / `expect` from HERE, not from '@playwright/test'.
//
// Why: `.env` carries the REAL production measurement id (VITE_GA4_ID=G-D4ZWVHQ7JK), and the Edge
// SSR pages hardcode the same id in `api/_shared/consent-init.ts`. So a test run — or a manual
// screen check that clicks "Accept All" — sends genuine hits to the property we use to measure
// growth. This fixture aborts them at the network layer so no test run can reach GA4, whatever the
// consent state.
//
// Two things keep the block honest:
//   - `tests/ga-block.spec.js` proves at runtime, in the always-run `desktop` project, that a
//     request to a GA4 collect endpoint cannot leave the browser.
//   - `scripts/check-e2e-ga-guard.mjs` (CI-gated via `npm run test:scripts`) fails the build if a
//     spec escapes the fixture — by importing '@playwright/test' directly, or by building its own
//     context/page off the `browser` fixture without calling `blockGaHits` on it.
//
// Known limit, not currently exercised by any spec: a PAGE-level catch-all route
// (`page.route('**/*', r => r.continue())`) takes precedence over context-level routes and would
// re-open GA4, as would `context.unrouteAll()`. No guard catches that — if you add one, block GA
// inside it.

import { test as base, expect } from '@playwright/test'
import { GA_HIT_RE } from './ga-hosts.js'

export { GA_HIT_RE }

// Block GA4 hits on a Page or a BrowserContext. Specs that build their own context or page off the
// `browser` fixture (bypassing the `context` override below) must call this on it.
export async function blockGaHits(pageOrContext) {
  await pageOrContext.route(GA_HIT_RE, (route) => route.abort())
}

export const test = base.extend({
  // Overriding `context` (not `page`) covers every page opened in it, popups included.
  // The provide callback is positional, so it is named `provide` rather than Playwright's
  // conventional `use` — `use(...)` in a non-component function trips eslint's
  // react-hooks/rules-of-hooks, which reads it as React's `use` hook.
  context: async ({ context }, provide) => {
    await blockGaHits(context)
    await provide(context)
  },
})

export { expect }
