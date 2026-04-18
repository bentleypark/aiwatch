import { test, expect } from '@playwright/test'

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
        await expect(p.locator('.cta a.btn-primary')).toHaveAttribute('href', 'https://ai-watch.dev/#settings')
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
    await expect(desc).toHaveAttribute('content', /Check if Claude is down right now/)
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
    expect(Number(m[3])).toBeLessThanOrEqual(28) // bedrock+azureopenai filtered
  })

  test('tied rank shows "(tied)" marker for services in a stable tie cluster', async ({ page }) => {
    // Cohere/Fireworks/DeepSeek have tied at score 83 for weeks. Guards the rankTied
    // render path — deleting ${service.rankTied ? ' (tied)' : ''} would fail this.
    // If the cluster ever un-ties, move to another known-tied service.
    const tiedCandidates = ['fireworks', 'cohere', 'deepseek']
    let foundTied = false
    for (const slug of tiedCandidates) {
      await page.goto(`/is-${slug}-down`, { waitUntil: 'domcontentloaded' })
      const rankLine = page.locator('p.meta', { hasText: /is ranked #\d+/ })
      if (await rankLine.isVisible().catch(() => false)) {
        const text = (await rankLine.textContent()) || ''
        if (text.includes('(tied)')) { foundTied = true; break }
      }
    }
    expect(foundTied, 'at least one of fireworks/cohere/deepseek must show "(tied)"').toBe(true)
  })

  test('rank excludes estimate-only services with zero incidents', async ({ page }) => {
    // Bedrock + Azure OpenAI are uptimeSource=estimate + 0 incidents → hidden from
    // dashboard ranking. SEO page must use the same filter so totalRanked matches
    // the dashboard count (28, not 30).
    await page.goto('/is-pinecone-down', { waitUntil: 'domcontentloaded' })
    const rankLine = page.locator('p.meta', { hasText: /is ranked #\d+/ })
    await expect(rankLine).toBeVisible()
    const text = (await rankLine.textContent()) || ''
    const m = text.match(/of (\d+) AI services/)
    expect(m).not.toBeNull()
    expect(Number(m && m[1])).toBeLessThanOrEqual(28)
  })

  test('hides "Uptime (30d): N/A" when no uptime data is available', async ({ page }) => {
    // Services like xai/perplexity/gemini/mistral/character-ai/etc. don't always have
    // uptime data. The header meta line must omit the Uptime segment entirely rather
    // than show "Uptime (30d): N/A" (regression: previously hardcoded with N/A literal).
    await page.goto('/is-xai-down', { waitUntil: 'domcontentloaded' })
    const meta = page.locator('p.meta.mono', { hasText: 'Last checked' })
    await expect(meta).toBeVisible()
    const text = (await meta.textContent()) || ''
    // Must NEVER show "Uptime (30d): N/A" literal — either hidden or valid percentage
    expect(text).not.toMatch(/Uptime \(30d\):\s*N\/A/)
    // If the Uptime segment appears at all, it must be a valid percentage
    const uptimeMatch = text.match(/Uptime \(30d\):\s*([^\s·&]+)/)
    if (uptimeMatch) expect(uptimeMatch[1]).toMatch(/^\d+\.\d+%$/)
  })

  test('shows uptime when available (groq always has 100% uptime in 30d)', async ({ page }) => {
    // Positive control: services with uptime data must still show the segment.
    await page.goto('/is-groq-down', { waitUntil: 'domcontentloaded' })
    const meta = page.locator('p.meta.mono', { hasText: 'Last checked' })
    await expect(meta).toBeVisible()
    const text = (await meta.textContent()) || ''
    expect(text).toMatch(/Uptime \(30d\):\s*\d+\.\d+%/)
  })
})
