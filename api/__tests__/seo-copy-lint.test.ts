import { describe, it, expect } from 'vitest'
import { getSEOContent, type ServiceSEO } from '../_is-down/seo-content'
import { SLUG_TO_SERVICE } from '../_is-down/slug-map'

/**
 * #1723 — `npm run lint:seo-copy`. A frequency, comparative or market sentence in the is-down copy
 * stays only when it is backed by AIWatch's own record, the vendor's own page, or a first-party
 * causal structure (the #1028 criterion, applied in PR #1724). Each backed sentence is listed WHOLE
 * below with its source and the pages that source covers, so any edit to it fails until it is re-read.
 *
 * The word list catches the listed words only. A claim built from ordinary words ("share
 * infrastructure", "same backend") passes it, so this is a gate on those words, not proof that the
 * copy carries no unbacked claim; the add-a-service step in docs/reference/adding-a-service.md asks
 * for a read for those.
 */
const CLAIM_WORDS = /\b(often|usually|typically|frequent\w*|common\w*|always|never|rarely|generally|widely|popular\w*|leading|largest|known for|de facto|millions|thousands|best|fastest|faster|slower|cheaper|affordab\w*|lower[- ]cost|positioned|(?<!rather )than)\b/i

const AIWATCH_SHARED_IDS = 'AIWatch record, production /api/status 2026-10-18: 33 of 37 claude incidents share their id with claudeai, 32 with claudecode (PR #1724)'

const BACKED: Record<string, { slugs: string[]; source: string }> = {
  "Used by millions for writing, research, coding, and creative tasks, it is powered by OpenAI's latest language models.":
    { slugs: ['chatgpt'], source: "OpenAI's own published usage and model statements (PR #1724)" },
  'A ChatGPT outage does not always mean the API is down — and vice versa.':
    { slugs: ['chatgpt'], source: 'AIWatch record, production /api/status 2026-10-18: 3 of 19 chatgpt incidents share their id with openai (PR #1724)' },
  'Usually a browser extension or URL blocker interfering with loading the page.':
    { slugs: ['chatgpt'], source: 'https://help.openai.com/en/articles/7996703' },
  'Not always — enterprise deployments can route inference through a cloud provider instead.':
    { slugs: ['claude-code'], source: 'https://code.claude.com/docs/en/third-party-integrations — "Organizations can deploy Claude Code through Anthropic directly or through a cloud provider."' },
  'Check the AIWatch dashboard at ai-watch.dev to see if Claude API is also experiencing issues — they often share the same incidents.':
    { slugs: ['claude-code', 'claude-ai'], source: AIWATCH_SHARED_IDS },
  'An API-level outage will typically affect claude.ai as well.':
    { slugs: ['claude-ai'], source: AIWATCH_SHARED_IDS },
  'The DeepSeek API is often affected by the same incident, since DeepSeek files many outages against both Web and API; check the DeepSeek API page as well.':
    { slugs: ['deepseek-app'], source: 'AIWatch record, production /api/status 2026-10-18: 12 of 17 deepseekapp incidents share their id with deepseek (PR #1724)' },
}

/** Reader-facing prose of one entry, split into sentences. FAQ questions are search queries and are
 *  left out, as the #1028 criterion leaves them. */
function sentencesOf(seo: ServiceSEO): string[] {
  const texts = [
    seo.description,
    seo.insight ?? '',
    seo.whenDown,
    ...seo.faqs.map((f) => f.a),
    ...(seo.errors?.items ?? []).flatMap((i) => [i.meaning, i.fix]),
  ]
  return texts.flatMap((t) => t.split(/(?<=[.!?])\s+/)).map((s) => s.trim()).filter(Boolean)
}

/** Sentences on `slug`'s page carrying a claim word that are not, character for character, a
 *  sentence backed for that page. */
function unbackedClaims(sentences: string[], slug: string): string[] {
  return sentences.filter((s) => CLAIM_WORDS.test(s) && !BACKED[s]?.slugs.includes(slug))
}

function allSentences(): Array<{ slug: string; sentence: string }> {
  return Object.keys(SLUG_TO_SERVICE).flatMap((slug) => {
    const seo = getSEOContent(slug)
    return seo ? sentencesOf(seo).map((sentence) => ({ slug, sentence })) : []
  })
}

describe('seo copy lint (#1723)', () => {
  it('every sentence in the copy carrying a listed claim word is a backed one', () => {
    const found = allSentences()
      .filter(({ slug, sentence }) => unbackedClaims([sentence], slug).length > 0)
      .map(({ slug, sentence }) => `${slug}: ${sentence}`)
    expect(found).toEqual([])
  })

  it('every backed sentence is still on each page it is backed for, so a reworded one cannot leave its entry behind', () => {
    const present = new Set(allSentences().map(({ slug, sentence }) => `${slug}: ${sentence}`))
    const missing = Object.entries(BACKED).flatMap(([sentence, { slugs }]) =>
      slugs.map((slug) => `${slug}: ${sentence}`).filter((k) => !present.has(k)))
    expect(missing).toEqual([])
  })

  it('every backed sentence still carries a claim word, so the list holds nothing the gate ignores', () => {
    expect(Object.keys(BACKED).filter((s) => !CLAIM_WORDS.test(s))).toEqual([])
  })

  it.each([
    'Cohere is widely used in enterprise search and knowledge applications.',
    'Groq is known for sub-100ms response times that traditional GPU-based providers cannot match.',
    'It is positioned as a high-performance alternative to Together AI.',
    "DeepSeek API provides access to DeepSeek's frontier reasoning models (V3, R1) at significantly lower price points than Western providers.",
    'Hugging Face hosts the largest open-source AI model hub plus Inference API endpoints, datasets, and Spaces (deployed apps).',
    'It is the de facto registry for open ML and a major inference provider.',
    'Voyage AI provides best-in-class embedding and reranking APIs optimized for retrieval-augmented generation (RAG).',
    "Modal's serverless model means individual function failures are common but don't indicate platform-wide outages.",
    'Deployments that chose Kimi for its large context window or lower cost lose their primary backend until it recovers.',
    'OpenAI API provides access to OpenAI\'s language, image, and audio models used by millions of developers.',
    'This affects thousands of third-party apps, chatbots, and developer tools that rely on OpenAI as their backend.',
  ])('a sentence deleted under the criterion fails when restored: %s', (sentence) => {
    expect(unbackedClaims([sentence], 'cohere')).toEqual([sentence])
  })

  it('a clause added to a backed sentence fails, since the match is on the whole sentence', () => {
    const [backed, { slugs }] = Object.entries(BACKED)[0]
    const widened = backed.replace(/\.$/, ', often within minutes.')
    expect(widened).not.toBe(backed)
    expect(unbackedClaims([widened], slugs[0])).toEqual([widened])
  })

  it.each([
    ['often', 'It often fails.'],
    ['usually', 'It usually fails.'],
    ['typically', 'It typically fails.'],
    ['frequent', 'It shows frequent alerts.'],
    ['common', 'Failures are common.'],
    ['always', 'It always fails.'],
    ['never', 'It never fails.'],
    ['rarely', 'It rarely fails.'],
    ['generally', 'It generally fails.'],
    ['widely', 'It is widely adopted.'],
    ['popular', 'It serves popular models.'],
    ['leading', 'It is the leading API.'],
    ['largest', 'It is the largest hub.'],
    ['known for', 'It is known for speed.'],
    ['de facto', 'It is the de facto registry.'],
    ['millions', 'It serves millions.'],
    ['thousands', 'It serves thousands of apps.'],
    ['best', 'It is best-in-class.'],
    ['fastest', 'It has the fastest throughput.'],
    ['faster', 'It is faster.'],
    ['slower', 'Requests fall back to slower providers.'],
    ['cheaper', 'It is cheaper.'],
    ['affordab', 'It is chosen for affordability.'],
    ['lower cost', 'It is chosen for lower cost.'],
    ['positioned', 'It is positioned as a rival.'],
    ['than', 'It costs less than Y.'],
  ])('the word %s is caught: %s', (_word, sentence) => {
    expect(unbackedClaims([sentence], 'x')).toEqual([sentence])
  })

  it('every prose field of an entry is scanned', () => {
    const poisoned: ServiceSEO = {
      displayName: 'X',
      description: 'X is widely used.',
      insight: 'X is often slow.',
      whenDown: 'X is faster than Y.',
      faqs: [{ q: 'Is X usually down?', a: 'X is the leading API.' }],
      errors: {
        source: { label: 'X docs', url: 'https://example.com' },
        items: [{ message: 'E1', meaning: 'This is common.', fix: 'Retry, it usually works.' }],
      },
    }
    expect(unbackedClaims(sentencesOf(poisoned), 'x')).toEqual([
      'X is widely used.', 'X is often slow.', 'X is faster than Y.', 'X is the leading API.', 'This is common.', 'Retry, it usually works.',
    ])
  })

  it('a backed sentence fails on a page its source does not cover', () => {
    const chatgptOnly = 'Usually a browser extension or URL blocker interfering with loading the page.'
    expect(unbackedClaims([chatgptOnly], 'gemini')).toEqual([chatgptOnly])
    expect(unbackedClaims([chatgptOnly], 'chatgpt')).toEqual([])
  })

  it('"rather than" is not a comparative claim', () => {
    expect(unbackedClaims(['AIWatch weighs the days a service was affected rather than the number of entries it filed.'], 'mistral')).toEqual([])
  })
})
