import { test, expect } from '@playwright/test'
// #568/#643: upper bound on the is-down "ranked #X of N" denominator. constants.js is a pure data
// module (no browser deps) → importable in node/Playwright, so this auto-tracks service additions.
//
// #643 — the bound must be the TOTAL service count, not `total − 2`. api/is-down.ts drops a service
// from the ranked set only when `uptimeSource === 'estimate' && incidents.length === 0` (plus stale
// sources), which is DYNAMIC: an estimate-only service like bedrock/azureopenai is RANKED while it
// has a live incident. The old `total − NO_FEED_SERVICES.length` assumed those two are ALWAYS
// excluded, so the test flaked (denominator rose above the bound) whenever an estimate-only service
// had an active incident. The only static invariant is `denominator ≤ total`; the exact count varies
// with live data and can't be asserted statically here.
import { ALL_SERVICE_IDS } from '../src/utils/constants.js'
const MAX_RANKED = ALL_SERVICE_IDS.length

const PAGES = [
  // Phase A — original 6 services
  { slug: 'claude', title: 'Is Claude Down?', displayName: 'Claude' },
  { slug: 'chatgpt', title: 'Is ChatGPT Down?', displayName: 'ChatGPT' },
  { slug: 'gemini', title: 'Is Gemini Down?', displayName: 'Gemini' },
  { slug: 'github-copilot', title: 'Is GitHub Copilot Down?', displayName: 'GitHub Copilot' },
  { slug: 'cursor', title: 'Is Cursor Down?', displayName: 'Cursor' },
  { slug: 'claude-ai', title: 'Is claude.ai Down?', displayName: 'claude.ai' },
  // Phase B — representative samples per category (#263)
  // Skip exhaustive 19-page coverage to keep CI fast; spot-check covers each parser/branch
  { slug: 'mistral', title: 'Is Mistral Down?', displayName: 'Mistral' },         // Instatus parser
  { slug: 'groq', title: 'Is Groq Cloud Down?', displayName: 'Groq Cloud' },      // low-latency LLM, official uptime
  { slug: 'elevenlabs', title: 'Is ElevenLabs Down?', displayName: 'ElevenLabs' }, // estimate source, voice
  { slug: 'replicate', title: 'Is Replicate Down?', displayName: 'Replicate' },   // EXCLUDE_FALLBACK
  { slug: 'pinecone', title: 'Is Pinecone Down?', displayName: 'Pinecone' },      // top-ranked vector DB
  { slug: 'character-ai', title: 'Is Character.AI Down?', displayName: 'Character.AI' }, // dashed slug, app category
  { slug: 'codex', title: 'Is Codex Down?', displayName: 'Codex' }, // coding agent, no umbrella component (#294)
]

test.describe('Is X Down? SSR pages', () => {
  for (const page of PAGES) {
    test.describe(page.slug, () => {
      test(`renders with correct title`, async ({ page: p }) => {
        await p.goto(`/is-${page.slug}-down`, { waitUntil: 'domcontentloaded' })
        await expect(p).toHaveTitle(new RegExp(page.title))
      })

      test(`shows status indicator`, async ({ page: p }) => {
        await p.goto(`/is-${page.slug}-down`, { waitUntil: 'domcontentloaded' })
        // Status should be one of: Operational, Degraded Performance, Down
        await expect(p.locator('body')).toContainText(/(Operational|Degraded Performance|Down)/)
      })

      test(`has canonical URL`, async ({ page: p }) => {
        await p.goto(`/is-${page.slug}-down`, { waitUntil: 'domcontentloaded' })
        const canonical = p.locator('link[rel="canonical"]')
        await expect(canonical).toHaveAttribute('href', `https://ai-watch.dev/is-${page.slug}-down`)
      })

      test(`has FAQ section with schema.org markup`, async ({ page: p }) => {
        await p.goto(`/is-${page.slug}-down`, { waitUntil: 'domcontentloaded' })
        await expect(p.locator('h2', { hasText: 'Frequently Asked Questions' })).toBeVisible()
        // Verify FAQPage JSON-LD exists
        const jsonLd = await p.locator('script[type="application/ld+json"]').allTextContents()
        const hasFaqSchema = jsonLd.some(t => t.includes('FAQPage'))
        expect(hasFaqSchema).toBe(true)
      })

      test(`has About section with insight`, async ({ page: p }) => {
        await p.goto(`/is-${page.slug}-down`, { waitUntil: 'domcontentloaded' })
        await expect(p.locator('h2', { hasText: `About ${page.displayName}` })).toBeVisible()
        await expect(p.locator('body')).toContainText('AIWatch Insight:')
      })

      test(`has AIWatch Data summary`, async ({ page: p }) => {
        await p.goto(`/is-${page.slug}-down`, { waitUntil: 'domcontentloaded' })
        // Data summary should contain "Based on AIWatch data" or not exist (when service data unavailable)
        const body = await p.locator('body').textContent()
        if (body?.includes('AIWatch Data:')) {
          expect(body).toMatch(/Based on AIWatch data from the last 30 days/)
          // Should contain either incident count or "zero incidents"
          expect(body).toMatch(/experienced \d+ incident|zero incidents/)
        }
      })

      test(`has CTA alert banner`, async ({ page: p }) => {
        await p.goto(`/is-${page.slug}-down`, { waitUntil: 'domcontentloaded' })
        await expect(p.locator('.cta')).toBeVisible()
        // #696: the PRIMARY CTA is the zero-config Slack /feed button (lowest-friction action for the
        // dev/team audience); RSS is the secondary button; the Discord double-opt-in stays a
        // de-emphasized secondary text link (.cta-alt) that still carries the focus=alerts href.
        await expect(p.locator('.cta button.btn-primary[data-slack]')).toBeVisible()
        await expect(p.locator('.cta button[data-rss]')).toBeVisible()
        await expect(p.locator('.cta a.btn-primary')).toHaveCount(0)
        await expect(p.locator('.cta .cta-alt a')).toHaveAttribute('href', 'https://ai-watch.dev/#settings?focus=alerts')
      })

      test(`has GA4 tag`, async ({ page: p }) => {
        await p.goto(`/is-${page.slug}-down`, { waitUntil: 'domcontentloaded' })
        const ga = p.locator('script[src*="googletagmanager.com/gtag/js"]')
        await expect(ga).toHaveAttribute('src', /G-D4ZWVHQ7JK/)
      })

      test(`renders non-empty SEO content (insight + FAQ answers)`, async ({ page: p }) => {
        // Guards seo-content.ts against typos, accidental empty strings, merge-conflict wipes.
        // Catches any service missing displayName/description/insight/whenDown/FAQ answers.
        await p.goto(`/is-${page.slug}-down`, { waitUntil: 'domcontentloaded' })
        const body = (await p.locator('body').textContent()) || ''
        expect(body, `[${page.slug}] Insight label or body missing`).toMatch(/AIWatch Insight:\s*\S[^\n]{19,}/)

        const scripts = await p.locator('script[type="application/ld+json"]').allTextContents()
        const jsonLdRaw = scripts.find(t => t.includes('FAQPage'))
        // Fail loudly with slug + script-count context, not a misleading "0 < 4" later
        expect(jsonLdRaw, `[${page.slug}] no FAQPage JSON-LD (found ${scripts.length} scripts)`).toBeTruthy()

        let faqSchema
        try {
          faqSchema = JSON.parse(jsonLdRaw)
        } catch (err) {
          throw new Error(`[${page.slug}] FAQPage JSON-LD malformed — likely escaping bug in html-template.ts or a literal quote in seo-content.ts. ${err.message}\nFirst 200 chars: ${jsonLdRaw.slice(0, 200)}…`)
        }

        expect(faqSchema?.mainEntity?.length ?? 0, `[${page.slug}] fewer than 4 FAQ entries`).toBeGreaterThanOrEqual(4)
        for (const [i, entry] of (faqSchema?.mainEntity ?? []).entries()) {
          expect(
            entry.acceptedAnswer?.text?.length ?? 0,
            `[${page.slug}] FAQ[${i}] "${entry.name}" has a trivial/empty answer`,
          ).toBeGreaterThan(20)
        }
      })
    })
  }

  test('unknown slug does not match edge function', async ({ page }) => {
    // Unknown slugs are not in vercel.json rewrites, so they fall through to SPA
    // In vercel dev, this may cause redirects — we just verify the edge function
    // doesn't serve content for unknown slugs by checking the API directly
    const res = await page.request.get('/api/is-down?slug=nonexistent')
    expect(res.status()).toBe(404)
  })

  test('meta description contains dynamic status', async ({ page }) => {
    await page.goto('/is-claude-down', { waitUntil: 'domcontentloaded' })
    const desc = page.locator('meta[name="description"]')
    // #566: answer-first — leads with No/Yes/Issues + the plain-language status phrase.
    await expect(desc).toHaveAttribute('content', /(No|Yes|Issues) — Claude (is operational|is down right now|is having problems right now)/)
  })

  // #321 — 30-day incident window + grouping on SSR page for SEO depth.
  test('Recent Incidents heading says "Last 7 days"', async ({ page }) => {
    await page.goto('/is-claude-down', { waitUntil: 'domcontentloaded' })
    // #incident-history-collapse — the incident-history window aligned 30d → 7d. Claude reliably
    // has incidents in any recent 7-day window, so the heading is rendered.
    const heading = page.locator('h2', { hasText: 'Recent Incidents' })
    await expect(heading).toBeVisible()
    await expect(heading).toContainText('Last 7 days')
  })

  test('meta description on operational page includes 30-day incident count when > 0', async ({ page }) => {
    // Use a service that tends to have incidents tracked in the 30-day window.
    // If operational AND >0 incidents, description should surface "N incidents tracked (30d)".
    // When status is non-operational, AI Analysis copy replaces this — assertion is skipped.
    await page.goto('/is-claude-down', { waitUntil: 'domcontentloaded' })
    const desc = await page.locator('meta[name="description"]').getAttribute('content')
    const isOperational = /No — Claude is operational/i.test(desc ?? '')
    if (!isOperational) {
      test.info().annotations.push({ type: 'note', description: 'Claude non-operational — "incidents tracked" assertion deferred' })
      return
    }
    expect(desc).toMatch(/\d+ incidents tracked \(30d\)/)
  })

  test('<details> incident-group elements render with open attribute (crawler-friendly)', async ({ page }) => {
    // Target Fireworks: BetterStack per-model feed consistently produces ≥3 same-day
    // "<model> — recovered" entries, so grouping should materialize at least one row.
    // If no data happens to group on the test day, the test degrades to a structural
    // presence check and annotates the run.
    await page.goto('/is-fireworks-down', { waitUntil: 'domcontentloaded' })
    const groups = page.locator('details.incident-group')
    const n = await groups.count()
    if (n === 0) {
      test.info().annotations.push({ type: 'note', description: 'No grouped incidents on Fireworks today — structure-only check' })
      return
    }
    // Each group must be <details open> so crawlers read the entries without JS.
    const first = groups.first()
    await expect(first).toHaveAttribute('open', '')
    await expect(first.locator('summary')).toBeVisible()
    await expect(first.locator('.incident-group-entries .incident-item').first()).toBeAttached()
  })

  test('footer has internal cross-links to other service pages', async ({ page }) => {
    await page.goto('/is-claude-down', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('a[href="/is-chatgpt-down"]').first()).toBeAttached()
    await expect(page.locator('a[href="/is-gemini-down"]').first()).toBeAttached()
    await expect(page.locator('a[href="/is-cursor-down"]').first()).toBeAttached()
  })

  test('OG meta tags point to dynamic OG image', async ({ page }) => {
    await page.goto('/is-claude-down', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /Is Claude Down/)
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', 'https://ai-watch.dev/is-claude-down')
    // Dynamic OG image URL should contain /api/og with service param
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /\/api\/og\?service=Claude/)
    await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute('content', /\/api\/og\?service=Claude/)
  })

  test('share buttons are present', async ({ page }) => {
    await page.goto('/is-claude-down', { waitUntil: 'domcontentloaded' })
    // X (Twitter) share link
    await expect(page.locator('a.share-x')).toHaveAttribute('href', /x\.com\/intent\/tweet/)
    // Threads share link
    await expect(page.locator('a.share-threads')).toHaveAttribute('href', /threads\.net\/intent\/post/)
    // Copy Link button
    await expect(page.locator('button.share-copy')).toBeVisible()
    // KakaoTalk button exists (hidden until SDK loads)
    await expect(page.locator('#kakao-share')).toHaveCount(1)
  })

  test('share text includes AIWatch branding', async ({ page }) => {
    await page.goto('/is-claude-down', { waitUntil: 'domcontentloaded' })
    // Copy button data-text should mention AIWatch
    const copyText = await page.locator('button.share-copy').getAttribute('data-text')
    expect(copyText).toContain('AIWatch')
    // X share href should contain encoded text with AIWatch
    const xHref = await page.locator('a.share-x').getAttribute('href')
    expect(xHref).toContain('AIWatch')
  })

  test('related cross-links are present in footer', async ({ page }) => {
    await page.goto('/is-claude-down', { waitUntil: 'domcontentloaded' })
    // Claude page should cross-link to Claude Code and OpenAI
    await expect(page.locator('a[href="/is-claude-code-down"]').first()).toBeAttached()
    await expect(page.locator('a[href="/is-openai-down"]').first()).toBeAttached()
  })

  test('AI Insight card shows when analysis available', async ({ page }) => {
    await page.goto('/is-claude-down', { waitUntil: 'domcontentloaded' })
    // AI Insight card is conditional — only shows when Worker has analysis data
    const aiCard = page.locator('text=AI Analysis').or(page.locator('text=Post-Incident Analysis'))
    if (await aiCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Beta badge present
      await expect(page.locator('text=Beta').first()).toBeVisible()
      // Disclaimer present
      await expect(page.locator('text=AI-generated estimation').first()).toBeAttached()
    }
  })

  test('rank renders unconditionally for a service with a known-stable score (groq)', async ({ page }) => {
    // Regression guard: if someone removes the rank assignment in api/is-down.ts,
    // the rank line would vanish silently and isVisible-guarded tests would pass.
    // Use groq as anchor — it's consistently ranked in the top 3 of API services.
    await page.goto('/is-groq-down', { waitUntil: 'domcontentloaded' })
    const rankLine = page.locator('p.meta', { hasText: /is ranked #\d+/ })
    await expect(rankLine).toBeVisible()
    const text = (await rankLine.textContent()) || ''
    const m = text.match(/is ranked #(\d+)(\s*\(tied\))? of (\d+) AI services/)
    expect(m).not.toBeNull()
    expect(Number(m[1])).toBeGreaterThanOrEqual(1)
    expect(Number(m[3])).toBeLessThanOrEqual(MAX_RANKED) // ≤ total service count (#643 — exact ranked count is dynamic)
  })

  // #787 — the "(tied)" coverage moved to DETERMINISTIC unit tests: the render branch in
  // api/is-down/__tests__/html-template.test.ts ('renders "(tied)" iff rankTied is set') and the
  // rank+tie DERIVATION in api/is-down/__tests__/ranking.test.ts (computeRankPosition). The old e2e
  // here asserted a LIVE score tie existed among 6 services, which false-failed whenever scores
  // drifted apart (it blocked unrelated PR #786's Edge E2E). The SSR rank LINE stays covered by the
  // 'is ranked #N' e2e; both halves of the tie path now need no live data.

  test('rank denominator stays within the total service count', async ({ page }) => {
    // The SEO rank line ("ranked #X of N AI services") must use the same ranked set as the
    // dashboard — which excludes estimate-only-zero-incident + stale-source services. That count is
    // DYNAMIC (an estimate-only service is ranked while it has a live incident), so we assert the
    // static `N ≤ total` invariant rather than a hardcoded figure (#643 — the old `total − 2` bound
    // flaked whenever an estimate-only service had an active incident).
    await page.goto('/is-pinecone-down', { waitUntil: 'domcontentloaded' })
    const rankLine = page.locator('p.meta', { hasText: /is ranked #\d+/ })
    await expect(rankLine).toBeVisible()
    const text = (await rankLine.textContent()) || ''
    const m = text.match(/of (\d+) AI services/)
    expect(m).not.toBeNull()
    // ≤ total service count. #643 — the ranked set excludes estimate-only-zero-incident + stale
    // services, but that count is DYNAMIC (an estimate-only service is ranked while it has a live
    // incident), so we can only assert the static `≤ total` invariant here, not a precise figure.
    expect(Number(m && m[1])).toBeLessThanOrEqual(MAX_RANKED)
  })

  test('hides "Uptime: N/A" when no uptime data is available', async ({ page }) => {
    // Services like xai/perplexity/gemini/mistral/character-ai/etc. don't always have
    // uptime data. The header meta line must omit the Uptime segment entirely rather
    // than show "Uptime: N/A" (regression: previously hardcoded with N/A literal).
    // #654 — the "(30d)" window qualifier was dropped (the source window varies: official pages
    // report 30/60/90d, estimate is 90d), so the label is now a neutral "Uptime:".
    await page.goto('/is-xai-down', { waitUntil: 'domcontentloaded' })
    const meta = page.locator('p.meta.mono', { hasText: 'Last checked' })
    await expect(meta).toBeVisible()
    const text = (await meta.textContent()) || ''
    // Must NEVER show "Uptime: N/A" literal — either hidden or valid percentage
    expect(text).not.toMatch(/Uptime:\s*N\/A/)
    // If the Uptime segment appears at all, it must be a valid percentage
    const uptimeMatch = text.match(/Uptime:\s*([^\s·&]+)/)
    if (uptimeMatch) expect(uptimeMatch[1]).toMatch(/^\d+\.\d+%$/)
  })

  test('shows uptime when available (groq always has ~100% uptime)', async ({ page }) => {
    // Positive control: services with uptime data must still show the segment.
    await page.goto('/is-groq-down', { waitUntil: 'domcontentloaded' })
    const meta = page.locator('p.meta.mono', { hasText: 'Last checked' })
    await expect(meta).toBeVisible()
    const text = (await meta.textContent()) || ''
    expect(text).toMatch(/Uptime:\s*\d+\.\d+%/)
  })

  test.describe('CTA placement for outage-moment capture (#297)', () => {
    test('CTA renders before AI Insight card in DOM order', async ({ page }) => {
      // Regression guard: the alert subscription prompt must sit directly below
      // the status header, ahead of AI Analysis, so it catches peak intent.
      // Reverting the order would silently tank conversion on real outage traffic.
      await page.goto('/is-claude-down', { waitUntil: 'domcontentloaded' })
      const cta = page.locator('.cta').first()
      await expect(cta).toBeVisible()

      // Contract: CTA must appear before ANY card that follows — covers the
      // AI Analysis card (conditional on Worker data) and any future card
      // we'd otherwise want to insert above the CTA.
      const ctaIdx = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('.container > *'))
        const cta = document.querySelector('.container > .cta')
        return cta ? all.indexOf(cta) : -1
      })
      expect(ctaIdx).toBeGreaterThanOrEqual(0)

      // If an AI Analysis/Post-Incident Analysis card exists, it must render AFTER the CTA.
      const aiIdx = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('.container > *'))
        const idx = all.findIndex(el => /AI Analysis|Post-Incident Analysis/.test(el.textContent || ''))
        return idx
      })
      if (aiIdx >= 0) expect(aiIdx).toBeGreaterThan(ctaIdx)
    })

    test('primary CTA is the Slack-feed button; RSS secondary; Discord demoted to a text link (#547/#696)', async ({ page }) => {
      await page.goto('/is-claude-down', { waitUntil: 'domcontentloaded' })
      // #696 Primary = zero-config Slack /feed button → copy_slack_feed (success proxy).
      // #482: the click fires from the delegated [data-action] dispatcher (no inline onclick).
      const primary = page.locator('.cta button.btn-primary[data-slack]')
      await expect(primary).toBeVisible()
      expect(await primary.getAttribute('data-action')).toBe('copy-slack')
      expect(await primary.getAttribute('onclick')).toBeNull()
      // RSS is the secondary button now (.btn, not .btn-primary).
      const rss = page.locator('.cta button[data-rss]')
      await expect(rss).toBeVisible()
      expect(await rss.getAttribute('data-action')).toBe('copy-rss')
      expect(await rss.getAttribute('class')).not.toContain('btn-primary')
      // Heavy Discord path is a de-emphasized text link, tagged source=status_banner_secondary
      // (GA4 on the delegated [data-ga] listener) so the funnel comparison can tell post-reorder
      // clicks apart from the old primary placement.
      const alt = page.locator('.cta .cta-alt a')
      expect(await alt.getAttribute('data-ga')).toBe('click_cta_alerts')
      expect(await alt.getAttribute('data-ga-source')).toBe('status_banner_secondary')
      expect(await alt.getAttribute('data-ga-loc')).toBe('is_down_page')
    })

    test('down/degraded copy uses benefit-framed wording', async ({ page }) => {
      // Pick a page likely to be in a non-operational state at test time, but
      // fall back to any is-down page — we check the copy's shape, not the status.
      await page.goto('/is-chatgpt-down', { waitUntil: 'domcontentloaded' })
      const ctaText = await page.locator('.cta').textContent()
      // Accept either down-state copy (#696: "<svc> is down/having issues right now.
      // Stop refreshing — we'll ping you when it's back.") or operational copy
      // ("Get notified the next time X goes down.") — check shape, not live status.
      const isDownCopy = /is (down|having issues) right now\.\s*Stop refreshing/i.test(ctaText || '')
      const isOperationalCopy = /Get notified the next time .* goes down/i.test(ctaText || '')
      expect(isDownCopy || isOperationalCopy).toBe(true)

      // #696: the primary button is the zero-config Slack-feed button (both states).
      const btnText = (await page.locator('.cta button.btn-primary').textContent()) || ''
      expect(btnText).toMatch(/Get alerts in Slack/i)
    })
  })
})
