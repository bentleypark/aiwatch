import { describe, it, expect } from 'vitest'
import { renderPage } from '../_is-down/html-template'
import { getSEOContent } from '../_is-down/seo-content'
import { SLUG_TO_SERVICE } from '../_is-down/slug-map'

/**
 * #1028 — `insight` became optional, so the e2e guard that used to require the label on every page
 * can no longer catch a wiped value: the template renders `''` and `undefined` identically. An emptied
 * or truncated insight fails here, omitting one stays a deliberate edit rather than an accident, and
 * the render path keeps a pin now that the per-page e2e assertion is gone.
 */
const OMITTED = ['cohere', 'fireworks', 'elevenlabs', 'assemblyai', 'stability', 'voyageai', 'deepseek-app', 'character-ai']

describe('is-down insight contract', () => {
  it('an insight that exists carries real copy', () => {
    const tooShort: string[] = []
    for (const slug of Object.keys(SLUG_TO_SERVICE)) {
      const seo = getSEOContent(slug)
      if (!seo || seo.insight === undefined) continue
      if (seo.insight.trim().length < 20) tooShort.push(`${slug}:${JSON.stringify(seo.insight)}`)
    }
    expect(tooShort).toEqual([])
  })

  it('exactly the services decided to have none are the ones without one', () => {
    const without = Object.keys(SLUG_TO_SERVICE)
      .filter((slug) => {
        const seo = getSEOContent(slug)
        return seo != null && seo.insight === undefined
      })
      .sort()
    expect(without).toEqual([...OMITTED].sort())
  })

  it('every slug meets the FAQ floor the e2e asserts over its 13-page sample', () => {
    const belowFloor = Object.keys(SLUG_TO_SERVICE)
      .map((slug) => ({ slug, count: getSEOContent(slug)?.faqs?.length ?? 0 }))
      .filter(({ count }) => count < 4)
      .map(({ slug, count }) => `${slug}:${count}`)
    expect(belowFloor).toEqual([])
  })

  it('an insight that exists reaches the page, and an omitted one renders no box', () => {
    const svc = {
      id: 'kimi', name: 'Kimi', provider: 'Moonshot AI', category: 'api',
      status: 'operational', latency: null, uptime30d: null, lastChecked: new Date().toISOString(),
      incidents: [], aiwatchScore: null, scoreGrade: null,
    }
    const withInsight = renderPage('kimi', svc as never, getSEOContent('kimi')!, [], null)
    expect(withInsight).toContain('AIWatch Insight:')
    expect(withInsight).toContain(getSEOContent('kimi')!.insight!.slice(0, 40))

    const omitted = renderPage('stability', { ...svc, id: 'stability' } as never, getSEOContent('stability')!, [], null)
    expect(omitted).not.toContain('AIWatch Insight:')
  })
})

describe('is-down app copy (#1028 apps batch)', () => {
  const APPS = ['claude-ai', 'chatgpt', 'grok', 'character-ai', 'deepseek-app']
  const copyOf = (slug: string) => {
    const seo = getSEOContent(slug)!
    return [seo.description, seo.insight ?? '', seo.whenDown, ...seo.faqs.map((f) => f.a)].join('\n')
  }

  it('no app page recommends the Gemini API as a chat app or links the retired chat.openai.com domain', () => {
    for (const slug of APPS) expect(copyOf(slug), slug).not.toMatch(/Gemini|chat\.openai\.com/)
  })

  it('Character.AI states no daily-active-user or most-used claim', () => {
    expect(copyOf('character-ai')).not.toMatch(/daily active users|most-used/i)
  })

  it('Grok copy makes no claim about the integration in X, which this page does not track', () => {
    expect(copyOf('grok')).not.toMatch(/integration in X|via X\b/)
  })

  it('Grok does not enumerate which surfaces the page tracks', () => {
    expect(copyOf('grok')).not.toMatch(/grok\.com and the mobile apps|iOS, Android, and Web app surfaces|those three app tags|Grok iOS \/ Grok Android/)
  })

  it('Character.AI points readers to no incident history or resolution times its page cannot show', () => {
    const answers = getSEOContent('character-ai')!.faqs.map((f) => f.a).join('\n')
    expect(answers).not.toMatch(/incident history|incidents section|resolution times/i)
  })

  it('Character.AI names every eligible chat-app peer', () => {
    const a = getSEOContent('character-ai')!.faqs.find((f) => /alternatives/i.test(f.q))!.a
    for (const peer of ['ChatGPT', 'claude.ai', 'Grok', 'DeepSeek App']) expect(a).toContain(peer)
  })

  it('Grok says nothing about whether AIWatch merges per-platform incidents', () => {
    expect(copyOf('grok')).not.toMatch(/merge/i)
  })

  it('claude.ai lists its desktop apps among the ways to use it', () => {
    expect(getSEOContent('claude-ai')!.description).toMatch(/desktop/i)
  })
})
