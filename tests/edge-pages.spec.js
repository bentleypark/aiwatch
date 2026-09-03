import { test, expect } from './fixtures.js'
import { PLUGIN_MARKETPLACE_ADD, PLUGIN_INSTALL_CMD } from '../api/_shared/plugin-cta'

// #1051 — the Edge SSR pages that shipped with NO e2e: plugin, methodology, badges,
// plugin-privacy, extension-privacy (+ the confirm 400 path). `test:edge` ran only
// is-down/intro/reports/consent, so "Edge E2E (Vercel Preview) pass" was green on PRs that
// changed a page it never loaded — which is how #920's /plugin published an install command
// that resolved for nobody, for months, behind green CI.
//
// What this adds over the SSR unit tests (plugin-page.test.ts et al): those render the template
// in-process and prove the STRING is right. Only an e2e proves the DEPLOYED page is reachable
// and serves it — locally via `vercel dev` :3333, in CI against the PR's Vercel Preview.
//
// NOTE adding an Edge spec takes THREE edits, not two: its project (playwright.config.js), the
// `desktop` project's testIgnore (desktop points at Vite :5173, where these paths 404), AND
// `--project=<name>` in package.json test:edge. The third is the one #1051 actually missed.
// scripts/check-edge-e2e-coverage.mjs enforces all three.

// path → the title it must serve. Derived from the live pages, not guessed.
const PAGES = [
  { path: '/plugin', title: /AIWatch for Claude Code/ },
  { path: '/methodology', title: /Methodology/ },
  { path: '/badges', title: /AI Status Badges/ },
  { path: '/plugin-privacy', title: /Privacy Policy/ },
  { path: '/extension-privacy', title: /Privacy Policy/ },
]

test.describe('Edge SSR pages — shared contract (#1051)', () => {
  for (const { path, title } of PAGES) {
    test(`${path} is served, indexable, canonical + CSP-enforced`, async ({ page, request }) => {
      // Status + header first: a page that 500s, or a preview serving the Deployment-Protection
      // wall (401 to anonymous requests — see edge-e2e.yml) must fail HERE, not as a confusing
      // empty-locator error further down. maxRedirects:0 so a redirect to an SSO page is caught as
      // a redirect rather than followed and reported as the wall's own status.
      const res = await request.get(path, { maxRedirects: 0 })
      expect(res.status(), `${path} must serve 200`).toBe(200)
      expect(res.headers()['content-security-policy'], `${path} must enforce a CSP`).toBeTruthy()

      await page.goto(path, { waitUntil: 'domcontentloaded' })
      await expect(page).toHaveTitle(title)
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        `https://ai-watch.dev${path}`,
      )
      // Anchored: /index/ also matches "noindex" — a page silently flipped to noindex would pass.
      // Not hypothetical, api/confirm.ts ships content="noindex". For methodology/badges/*-privacy
      // this is the ONLY robots check in the repo (plugin-page.test.ts pins /plugin at unit level).
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /^index\b/)
    })
  }
})

test.describe('/plugin serves install commands that resolve (#920)', () => {
  test('renders the exact commands the code publishes', async ({ page }) => {
    await page.goto('/plugin', { waitUntil: 'domcontentloaded' })
    const cmd = page.locator('.install .cmd')
    await expect(cmd).toBeVisible()
    // Imported, never re-typed: a copy here would drift the same way the page drifted from the
    // (absent) catalog. plugin-page.test.ts pins these constants against .claude-plugin/marketplace.json;
    // this pins the DEPLOYED page against the constants. Together: page → constants → shipped catalog.
    await expect(cmd).toContainText(PLUGIN_MARKETPLACE_ADD)
    await expect(cmd).toContainText(PLUGIN_INSTALL_CMD)
    // The pre-#1050 state: a "🚧 In review" note gating commands nobody could run.
    await expect(page.locator('body')).not.toContainText('In review')
  })
})

test.describe('/confirm token gate (#486)', () => {
  // A VALID token needs the worker's signing secret, so the happy path isn't reachable from e2e
  // (confirm.test.ts unit-tests it). What e2e can prove: the deployed function rejects a bad token
  // deliberately instead of crashing or 500ing — i.e. it is wired and running at all.
  test('rejects a malformed token with 400 rather than crashing', async ({ request }) => {
    const res = await request.get('/confirm?h=bogus&c=bogus', { maxRedirects: 0 })
    // 400 distinguishes "deployed and routed" from 404 (route miss) and 500 (crashed) — the wiring
    // proof confirm.test.ts can't give.
    expect(res.status()).toBe(400)
    // The invalid state must render NO activate button: the button is what a crawler prefetching
    // the link would trigger, so its absence is the #486 crawler-safety invariant. Nothing else
    // pins it end-to-end.
    expect(await res.text()).not.toContain('<button')
  })
})
