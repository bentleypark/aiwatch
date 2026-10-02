import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseOpenAIChangelog,
  parseAnthropicReleaseFeed,
  topLevelListItems,
  classifyChange,
  isLaunchPricing,
  pickSentence,
  buildChangeTweet,
  buildQuote,
  buildChangeEmbed,
  detectNewChanges,
  runProviderChanges,
  seenKey,
  xLength,
  BULK_REKEY_THRESHOLD,
  type ProviderChange,
  type ProviderChangeSource,
} from '../provider-changes'
import { TWEET_MAX } from '../alerts'

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8')
const OPENAI_MD = fixture('openai-changelog-2026-10-01.md')
const ANTHROPIC_XML = fixture('anthropic-release-notes-2026-10-01.xml')

const BREAKING_BEFORE_JULY = [
  'openai 2026-05-29 breaking',
  'openai 2026-04-24 breaking',
  'anthropic 2026-06-30 pricing,deprecation,breaking',
  'anthropic 2026-06-29 pricing,billing,breaking',
  'anthropic 2026-06-25 deprecation,breaking',
  'anthropic 2026-06-15 deprecation,breaking',
  'anthropic 2026-06-09 breaking',
  'anthropic 2026-05-28 breaking',
  'anthropic 2026-05-28 breaking',
  'anthropic 2026-04-30 deprecation,breaking',
  'anthropic 2026-04-20 deprecation,breaking',
  'anthropic 2026-03-30 deprecation,breaking',
  'anthropic 2026-03-13 breaking,limits',
  'anthropic 2026-02-19 deprecation,breaking',
  'anthropic 2026-01-05 deprecation,breaking',
  'anthropic 2025-10-28 deprecation,breaking',
  'anthropic 2025-07-21 deprecation,breaking',
]

describe('parseOpenAIChangelog (captured 2026-10-01)', () => {
  const entries = parseOpenAIChangelog(OPENAI_MD)

  it('dates each `### Mon DD` entry with the year of its `## Month, YYYY` section', () => {
    expect(entries[0].date).toBe('2026-09-29')
    expect(entries.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date))).toBe(true)
    expect(entries.some((e) => e.date.startsWith('2025-'))).toBe(true)
  })

  it('drops the `Feature · Model: …` label line and markdown link syntax from the text', () => {
    const sol = entries.find((e) => e.date === '2026-09-22' && e.text.includes('GPT-6 Luna'))!
    expect(sol.text.startsWith('Released GPT-6 Sol (gpt-6-sol)')).toBe(true)
    expect(sol.text).toContain('GPT-6 Sol: $2 input, $0.20 cached input, and $10 output.')
    expect(sol.text).not.toMatch(/\]\(|Feature ·/)
  })

  it('keeps same-day entries separate', () => {
    expect(entries.filter((e) => e.date === '2026-09-29').length).toBeGreaterThanOrEqual(3)
  })
})

describe('parseAnthropicReleaseFeed (captured 2026-10-01)', () => {
  const entries = parseAnthropicReleaseFeed(ANTHROPIC_XML)

  it('splits a day into one change per top-level <li>, each linked to its day anchor', () => {
    const sep24 = entries.filter((e) => e.date === '2026-09-24')
    expect(sep24.length).toBeGreaterThan(1)
    expect(sep24.every((e) => e.url.endsWith('#september-24-2026'))).toBe(true)
  })

  it('a day mixing a billing line with other lines tags each line on its own text', () => {
    const tagged = entries
      .filter((e) => e.date === '2026-09-24')
      .map((e) => ({ text: e.text, tags: classifyChange(e.text) }))
      .filter((e) => e.tags.length > 0)
    expect(tagged.map((e) => e.tags)).toEqual([['billing'], ['breaking']])
    expect(tagged[0].text).toMatch(/^We're resuming billing for refusals/)
    expect(tagged[1].text).toMatch(/^The Compliance API Activity Feed no longer returns/)
  })

  it('decodes entities and joins inline code without stray spaces', () => {
    const sonnet45 = entries.find((e) => e.date === '2026-09-30' && e.text.includes('Sonnet 4.5'))!
    expect(sonnet45.text).toContain('(claude-sonnet-4-5-20250929)')
    expect(sonnet45.text).not.toMatch(/&[a-z]+;|<\/?[a-z]/)
  })
})

describe('parseAnthropicReleaseFeed — entities', () => {
  it('decodes numeric entities inside the escaped description', () => {
    const xml = '<item><link>https://x.test/#d</link><pubDate>Thu, 24 Sep 2026 00:00:00 GMT</pubDate><description>&lt;ul&gt;&lt;li&gt;It&amp;#8217;s retired &amp;#x2014; done&lt;/li&gt;&lt;/ul&gt;</description></item>'
    expect(parseAnthropicReleaseFeed(xml).map((e) => e.text)).toEqual(['It\u2019s retired \u2014 done'])
  })
})

describe('topLevelListItems', () => {
  it('keeps a nested list inside its parent item', () => {
    const items = topLevelListItems('<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>')
    expect(items).toEqual(['a<ul><li>b</li></ul>', 'c'])
  })
})

describe('classifyChange', () => {
  it.each([
    ['Standard pricing per 1M tokens for prompts with up to 272K input tokens is $2 input, $0.10 cached input, and $10 output.', ['pricing']],
    ['GPT-5.6 Sol now costs $4 per million input tokens and $20 per million output tokens.', ['pricing']],
    ['It is available at $4 / $20 USD per MTok (Claude Opus 5 is $5 / $25).', ['pricing']],
    ['The introductory pricing for Claude Sonnet 5 is now the standard price.', ['pricing']],
    ["We're resuming billing for refusals that arrive before any output.", ['billing']],
    ['We announced the deprecation of the Claude Sonnet 4.5 model.', ['deprecation']],
    ["We've retired the Claude Opus 4.1 model.", ['deprecation']],
    ['The legacy Workbench is being sunset with access ending on August 17, 2026.', ['deprecation']],
    ['Setting temperature to a non-default value returns a 400 error on Claude Opus 4.8.', ['breaking']],
    ["Requests to this model will now return an error.", ['breaking']],
    ['Code written for Claude Sonnet 5 can break on Claude Sonnet 5.5 in five ways.', ['breaking']],
    ['Thinking budgets are a breaking change from Claude Opus 4.8.', ['breaking']],
    ['The Compliance API Activity Feed no longer returns file names.', ['breaking']],
    ['The batch endpoint will no longer return partial results.', ['breaking']],
    ["tool_choice types any and tool aren't supported on Claude Fable 5.1.", ['breaking']],
    ['Assistant prefill is not supported on Claude Fable 5.', ['breaking']],
    ["We've removed fast mode for Claude Opus 4.7.", ['breaking']],
    ['prompt_cache_retention now defaults to 24h instead of in_memory.', ['breaking']],
    ['The new beta header changes how listing memories behaves.', ['breaking']],
    ["We've raised rate limits across the Claude API.", ['limits']],
    ["We've increased rate limits for Claude Opus 4 on the Claude API.", ['limits']],
    ["We've lowered rate limits for Claude Haiku 3.", ['limits']],
    ['We reduced the rate limits on the batch tier.', ['limits']],
    ["We've updated our rate limits for the Messages API.", ['limits']],
    ['We replaced and updated the tokens per minute rate limit.', ['limits']],
    ['We increased capacity for Claude Opus 4 on the Claude API and its rate limits.', ['limits']],
    ["We've removed the dedicated 1M rate limits for all supported models.", ['breaking', 'limits']],
  ])('%s → %j', (text, tags) => {
    expect(classifyChange(text)).toEqual(tags)
  })

  it('tags exactly these real entries from 2026-07-01 on (both captured sources)', () => {
    const tagged = [...parseOpenAIChangelog(OPENAI_MD), ...parseAnthropicReleaseFeed(ANTHROPIC_XML)]
      .filter((c) => c.date >= '2026-07-01')
      .map((c) => ({ c, tags: classifyChange(c.text) }))
      .filter((x) => x.tags.length > 0)
      .map((x) => `${x.c.provider} ${x.c.date} ${x.tags.join(',')}`)
    expect(tagged).toEqual([
      'openai 2026-09-29 pricing',
      'openai 2026-09-29 breaking',
      'openai 2026-09-22 pricing',
      'openai 2026-09-10 pricing,billing',
      'openai 2026-09-08 pricing,billing',
      'openai 2026-09-02 breaking',
      'openai 2026-08-26 deprecation',
      'openai 2026-08-21 pricing',
      'openai 2026-07-30 pricing',
      'openai 2026-07-22 breaking',
      'anthropic 2026-09-30 deprecation',
      'anthropic 2026-09-28 breaking',
      'anthropic 2026-09-24 billing',
      'anthropic 2026-09-24 breaking',
      'anthropic 2026-09-22 pricing',
      'anthropic 2026-09-22 breaking',
      'anthropic 2026-09-01 pricing',
      'anthropic 2026-09-01 pricing',
      'anthropic 2026-09-01 breaking',
      'anthropic 2026-09-01 breaking',
      'anthropic 2026-08-20 deprecation',
      'anthropic 2026-08-10 pricing',
      'anthropic 2026-08-07 pricing',
      'anthropic 2026-08-05 deprecation,breaking',
      'anthropic 2026-07-24 pricing',
      'anthropic 2026-07-24 breaking',
      'anthropic 2026-07-24 breaking',
      'anthropic 2026-07-22 breaking',
      'anthropic 2026-07-17 deprecation,breaking',
      'anthropic 2026-07-17 deprecation,breaking',
      'anthropic 2026-07-02 breaking',
    ])
  })

  it('tags exactly these real rate-limit entries, all dates (both captured sources)', () => {
    const limits = [...parseOpenAIChangelog(OPENAI_MD), ...parseAnthropicReleaseFeed(ANTHROPIC_XML)]
      .filter((c) => classifyChange(c.text).includes('limits'))
      .map((c) => `${c.provider} ${c.date}`)
    expect(limits).toEqual([
      'anthropic 2026-06-26',
      'anthropic 2026-03-13',
      'anthropic 2025-08-26',
      'anthropic 2025-07-24',
      'anthropic 2025-07-17',
      'anthropic 2024-11-20',
    ])
  })

  it('tags these earlier real entries (before 2026-07-01) as breaking', () => {
    const breaking = [...parseOpenAIChangelog(OPENAI_MD), ...parseAnthropicReleaseFeed(ANTHROPIC_XML)]
      .filter((c) => c.date < '2026-07-01')
      .map((c) => ({ c, tags: classifyChange(c.text) }))
      .filter((x) => x.tags.includes('breaking'))
      .map((x) => `${x.c.provider} ${x.c.date} ${x.tags.join(',')}`)
    expect(breaking).toEqual(BREAKING_BEFORE_JULY)
  })

  it.each([
    'Added API key creation governance controls at the organization and project levels.',
    "We've released the Rate Limits API, allowing administrators to query the rate limits configured for their organization.",
    'View your current API rate limits in the new Rate Limits tab in the Developer Console.',
    'We increased the context window on Claude Sonnet 4 and added usage charts for requests, tokens and rate limits.',
    'See pricing for available processing tiers.',
    'Released the Agents API in public beta.',
    'Generations up to 20 seconds and 1080p output.',
  ])('no tag: %s', (text) => {
    expect(classifyChange(text)).toEqual([])
  })
})

const change = (over: Partial<ProviderChange> = {}): ProviderChange => ({
  provider: 'anthropic',
  key: 'anthropic:2026-09-22:k',
  date: '2026-09-22',
  text: "We've launched Claude Opus 5.5 for long-running agentic coding. It is priced at $4 / $20 USD per MTok (Claude Opus 5 is $5 / $25).",
  url: 'https://platform.claude.com/docs/en/release-notes/overview#september-22-2026',
  ...over,
})

describe('isLaunchPricing', () => {
  it('splits the real pricing-tagged entries into launches and the rest (both captured sources, all dates)', () => {
    const split = [...parseOpenAIChangelog(OPENAI_MD), ...parseAnthropicReleaseFeed(ANTHROPIC_XML)]
      .filter((c) => classifyChange(c.text).includes('pricing'))
      .map((c) => `${isLaunchPricing(c.text) ? 'launch' : 'other '} ${c.provider} ${c.date}`)
    expect(split).toEqual([
      'launch openai 2026-09-29',
      'launch openai 2026-09-22',
      'launch openai 2026-09-10',
      'launch openai 2026-09-08',
      'other  openai 2026-08-21',
      'other  openai 2026-07-30',
      'launch openai 2026-04-21',
      'other  openai 2026-03-12',
      'other  openai 2025-06-10',
      'launch anthropic 2026-09-22',
      'launch anthropic 2026-09-01',
      'other  anthropic 2026-09-01',
      'other  anthropic 2026-08-10',
      'other  anthropic 2026-08-07',
      'launch anthropic 2026-07-24',
      'launch anthropic 2026-06-30',
      'other  anthropic 2026-06-29',
      'launch anthropic 2026-04-16',
      'other  anthropic 2025-09-29',
    ])
  })

  it.each([
    ["We've launched Claude Opus 5.5 (claude-opus-5-5). It is priced at $4 / $20 per MTok.", true],
    ["We're launching Model X. It costs $1 per 1M tokens.", true],
    ['Released GPT-6 Sol (gpt-6-sol). Standard pricing per 1M tokens is $2 input.', true],
    ['Launched Model Y. Standard pricing per 1M tokens is $2 input.', true],
    ['Introducing Model Z. Standard pricing per 1M tokens is $2 input.', true],
    ['GPT-Live 1 is now generally available in the API. Standard pricing is $5 per minute.', true],
    ['Released o3-pro. Prices for the o3 model have also been reduced for all API requests.', false],
    ['Released Model X. Its price will increase to $3 next month.', false],
    ['Released Model X. Older model costs drop 50% today.', false],
    ['Released Model X. The price is cut to $1 for the old tier.', false],
    ['Released Model X. Model W now costs less.', false],
    ['Released Model X. Batch pricing is lower than before.', false],
    ['Released Model X. Older model prices were raised to $2.', false],
    ['GPT-5.6 Sol now costs $4 per million input tokens, representing 20% lower input pricing.', false],
    ['The model we Released in May now costs $1 per 1M tokens.', false],
    ['Model X adds prompt caching. It is now generally available at $1 per 1M tokens.', false],
    ['Released Model X, whose price is lower than Model W. Standard pricing is $1 per 1M tokens.', true],
  ])('%s → %s', (text, launch) => {
    expect(isLaunchPricing(text)).toBe(launch)
  })
})

describe('buildChangeTweet', () => {
  it('a price change to an existing model keeps the pricing-update head (real GPT-5.6 Sol cut)', () => {
    const sol = parseOpenAIChangelog(OPENAI_MD).find((e) => e.date === '2026-08-21' && e.text.startsWith('GPT-5.6 Sol now costs'))!
    expect(buildChangeTweet('OpenAI', sol, 'pricing').text.startsWith('OpenAI pricing update: ')).toBe(true)
    expect(buildChangeEmbed('OpenAI', sol, ['pricing']).title).toBe('💲 OpenAI — pricing (2026-08-21)')
  })

  it('only the pricing tag of a launch is relabelled (real Sonnet 5 launch, also deprecation + breaking)', () => {
    const s5 = parseAnthropicReleaseFeed(ANTHROPIC_XML).find((e) => e.date === '2026-06-30' && e.text.includes('Sonnet 5 (claude-sonnet-5)'))!
    expect(buildChangeEmbed('Anthropic', s5, classifyChange(s5.text)).title).toBe('💲 Anthropic — new model pricing · deprecation · breaking (2026-06-30)')
    expect(buildChangeTweet('Anthropic', s5, 'breaking').text.startsWith('Anthropic breaking change')).toBe(true)
  })

  it('a launch with no quotable sentence still says new model pricing', () => {
    const long = change({ text: `We've launched Model X. The price is $1 per 1M tokens and ${'very '.repeat(80)}long.` })
    expect(buildChangeTweet('Anthropic', long, 'pricing').text.startsWith('Anthropic new model pricing. Source: ')).toBe(true)
  })

  it('quotes the source sentence that carries the price, verbatim', () => {
    const { text } = buildChangeTweet('Anthropic', change(), 'pricing')
    expect(text).toBe(
      "Anthropic new model pricing: We've launched Claude Opus 5.5 for long-running agentic coding. It is priced at $4 / $20 USD per MTok (Claude Opus 5 is $5 / $25). Source: https://platform.claude.com/docs/en/release-notes/overview#september-22-2026",
    )
  })

  it('quotes the first sentence once when it is itself the evidence (real Sonnet 4.5 deprecation)', () => {
    const s45 = parseAnthropicReleaseFeed(ANTHROPIC_XML).find((e) => e.date === '2026-09-30' && e.text.includes('Sonnet 4.5'))!
    expect(buildChangeTweet('Anthropic', s45, 'deprecation').text).toBe(
      'Anthropic deprecation notice: We announced the deprecation of the Claude Sonnet 4.5 model (claude-sonnet-4-5-20250929), with retirement on the Claude API scheduled for November 30, 2026. Source: https://platform.claude.com/docs/en/release-notes/overview#september-30-2026',
    )
  })

  it('a short first sentence that is the evidence is not doubled (real Opus 4.1 retirement)', () => {
    const o41 = parseAnthropicReleaseFeed(ANTHROPIC_XML).find((e) => e.date === '2026-08-05' && e.text.includes('Opus 4.1'))!
    const { text } = buildChangeTweet('Anthropic', o41, 'deprecation')
    expect(text.match(/We've retired the Claude Opus 4\.1 model/g)).toHaveLength(1)
  })

  it('when both sentences do not fit, quotes the whole evidence sentence alone (real Opus 5.5 entry)', () => {
    const opus = parseAnthropicReleaseFeed(ANTHROPIC_XML).find((e) => e.date === '2026-09-22' && e.text.includes('Opus 5.5'))!
    expect(buildChangeTweet('Anthropic', opus, 'pricing').text).toBe(
      'Anthropic new model pricing: It has a 1M token context window by default, 128k max output tokens, and always-on adaptive thinking, at $4 / $20 USD per MTok (Claude Opus 5 is $5 / $25). Source: https://platform.claude.com/docs/en/release-notes/overview#september-22-2026',
    )
  })

  it('every dollar figure in a draft appears in the source entry, for each real tagged entry', () => {
    const all = [...parseOpenAIChangelog(OPENAI_MD), ...parseAnthropicReleaseFeed(ANTHROPIC_XML)]
    let checked = 0
    for (const c of all) {
      const tags = classifyChange(c.text)
      if (tags.length === 0) continue
      const { text } = buildChangeTweet(c.provider, c, tags[0])
      expect(xLength(text)).toBeLessThanOrEqual(TWEET_MAX)
      for (const amount of text.match(/\$\s?\d[\d,]*(?:\.\d+)?/g) ?? []) expect(c.text).toContain(amount)
      checked++
    }
    expect(checked).toBeGreaterThan(10)
  })

  it("each real tagged entry's draft quote, when present, carries the evidence for its own tag", () => {
    const all = [...parseOpenAIChangelog(OPENAI_MD), ...parseAnthropicReleaseFeed(ANTHROPIC_XML)]
    const lost: string[] = []
    for (const c of all) {
      const tags = classifyChange(c.text)
      if (tags.length === 0) continue
      const quote = buildQuote(c.text, tags[0], 210)
      if (quote !== '' && !classifyChange(quote).includes(tags[0])) lost.push(`${c.provider} ${c.date} ${tags[0]}: ${quote}`)
    }
    expect(lost).toEqual([])
  })

  it('a sentence too long for the tweet is not cut: the draft carries no quote', () => {
    const long = change({ text: `The price is $1 per 1M tokens and ${'very '.repeat(80)}long.` })
    expect(buildChangeTweet('Anthropic', long, 'pricing').text).toBe(
      'Anthropic pricing update. Source: https://platform.claude.com/docs/en/release-notes/overview#september-22-2026',
    )
  })

  it('the compose link carries no raw parentheses (they would end the Discord markdown link)', () => {
    const { intentUrl } = buildChangeTweet('Anthropic', change(), 'pricing')
    expect(intentUrl).not.toMatch(/[()]/)
  })
})

describe('xLength', () => {
  it('counts each URL as 23 characters', () => {
    expect(xLength('see https://example.com/a/very/long/path/that/is/long ok')).toBe('see '.length + 23 + ' ok'.length)
  })
})

describe('buildQuote', () => {
  it('returns whole sentences or nothing, never a cut', () => {
    expect(buildQuote('Model X is out. It is priced at $1 per 1M tokens.', 'pricing', 100)).toBe('Model X is out. It is priced at $1 per 1M tokens.')
    expect(buildQuote('Model X is out. It is priced at $1 per 1M tokens.', 'pricing', 40)).toBe('It is priced at $1 per 1M tokens.')
    expect(buildQuote('Model X is out. It is priced at $1 per 1M tokens.', 'pricing', 20)).toBe('')
  })
})

describe('pickSentence', () => {
  it('picks the sentence carrying the rate-limit change', () => {
    expect(pickSentence('Claude Opus 4 is our flagship model. We have increased rate limits for it.', 'limits')).toBe('We have increased rate limits for it.')
  })

  it('falls back to the first sentence when no sentence carries the tag evidence', () => {
    expect(pickSentence('First one. Second one.', 'deprecation')).toBe('First one.')
  })
})

describe('buildChangeEmbed', () => {
  it('a deprecation links an X search for the provider deprecation', () => {
    const e = buildChangeEmbed('Anthropic', change({ text: "We've retired the Claude Opus 4.1 model." }), ['deprecation'])
    expect(e.description).toContain('[🔍 Search X](https://x.com/search?q=Anthropic%20deprecation&f=top)')
  })

  it('links the source, the compose draft and an X search, and shows the draft text', () => {
    const e = buildChangeEmbed('Anthropic', change(), ['pricing'])
    expect(e.title).toBe('💲 Anthropic — new model pricing (2026-09-22)')
    expect(e.description).toContain('[Source](https://platform.claude.com/docs/en/release-notes/overview#september-22-2026)')
    expect(e.description).toContain('[✍️ Post on X](https://twitter.com/intent/tweet?text=')
    expect(e.description).toContain('[🔍 Search X](https://x.com/search?q=Anthropic%20pricing&f=top)')
    expect(e.description).toContain("> Anthropic new model pricing: We've launched Claude Opus 5.5")
  })

  it.each([
    ['breaking' as const, "We've removed fast mode for Claude Opus 4.7.", 'Anthropic%20breaking%20change', '> Anthropic breaking change: '],
    ['limits' as const, "We've raised rate limits across the Claude API.", 'Anthropic%20rate%20limits', '> Anthropic rate limit change: '],
  ])('a %s entry drafts and searches under its own tag', (tag, text, query, draft) => {
    const e = buildChangeEmbed('Anthropic', change({ text }), [tag])
    expect(e.description).toContain(`[🔍 Search X](https://x.com/search?q=${query}&f=top)`)
    expect(e.description).toContain(draft)
  })
})

describe('detectNewChanges', () => {
  const now = new Date('2026-10-01T12:00:00Z')
  const priced = change({ key: 'new', date: '2026-09-30' })

  it('first run (no stored key set) alerts nothing', () => {
    expect(detectNewChanges('Anthropic', [priced], null, now)).toEqual({ alerts: [], bulk: [] })
  })

  it('alerts a new, tagged, recent entry and nothing already seen', () => {
    const seen = change({ key: 'old', date: '2026-09-30' })
    const r = detectNewChanges('Anthropic', [priced, seen], ['old'], now)
    expect(r.alerts.map((a) => a.change.key)).toEqual(['new'])
    expect(r.alerts[0].tags).toEqual(['pricing'])
  })

  it('does not alert a new entry with no tag', () => {
    const plain = change({ key: 'new', date: '2026-09-30', text: 'Released the Agents API in public beta.' })
    expect(detectNewChanges('Anthropic', [plain], [], now).alerts).toEqual([])
  })

  it('does not alert a new key on an entry older than the alert window (an upstream edit re-keys it)', () => {
    const old = change({ key: 'new', date: '2026-08-01' })
    expect(detectNewChanges('Anthropic', [old], [], now).alerts).toEqual([])
  })

  it('reports a bulk re-key instead of alerting each entry', () => {
    const many = Array.from({ length: BULK_REKEY_THRESHOLD + 1 }, (_, i) => change({ key: `k${i}`, date: '2026-09-30' }))
    const r = detectNewChanges('Anthropic', many, [], now)
    expect(r.alerts).toEqual([])
    expect(r.bulk).toEqual([{ providerName: 'Anthropic', count: BULK_REKEY_THRESHOLD + 1 }])
  })
})

describe('runProviderChanges', () => {
  afterEach(() => vi.unstubAllGlobals())

  const now = new Date('2026-10-01T12:00:00Z')
  const fakeKv = (init: Record<string, string> = {}) => {
    const store = new Map(Object.entries(init))
    return {
      store,
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    }
  }
  const src = (entries: ProviderChange[]): ProviderChangeSource => ({ id: 'anthropic', name: 'Anthropic', url: 'https://example.test/feed', parse: () => entries })
  const okFetch = () => vi.stubGlobal('fetch', vi.fn(async () => new Response('body', { status: 200 })))
  const priced = change({ key: 'new', date: '2026-09-30' })
  const seen = change({ key: 'old', date: '2026-09-01', text: 'Released something.' })

  it('first run stores the key set and sends nothing', async () => {
    okFetch()
    const kv = fakeKv()
    const send = vi.fn(async () => true)
    await runProviderChanges(kv as unknown as KVNamespace, send, now, [src([priced, seen])])
    expect(send).not.toHaveBeenCalled()
    expect(JSON.parse(kv.store.get(seenKey('anthropic'))!)).toEqual(['new', 'old'])
  })

  it('sends a new tagged entry, then stores the new key set', async () => {
    okFetch()
    const kv = fakeKv({ [seenKey('anthropic')]: JSON.stringify(['old']) })
    const send = vi.fn(async () => true)
    await runProviderChanges(kv as unknown as KVNamespace, send, now, [src([priced, seen])])
    expect(send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(kv.store.get(seenKey('anthropic'))!)).toEqual(['new', 'old'])
  })

  it('a failed send keeps that entry out of the stored set so the next run retries it', async () => {
    okFetch()
    const kv = fakeKv({ [seenKey('anthropic')]: JSON.stringify(['old']) })
    await runProviderChanges(kv as unknown as KVNamespace, vi.fn(async () => false), now, [src([priced, seen])])
    expect(JSON.parse(kv.store.get(seenKey('anthropic')) ?? '[]')).not.toContain('new')
  })

  it('a failed bulk notice stores nothing, so the notice retries', async () => {
    okFetch()
    const many = Array.from({ length: BULK_REKEY_THRESHOLD + 1 }, (_, i) => change({ key: `k${i}`, date: '2026-09-30' }))
    const kv = fakeKv({ [seenKey('anthropic')]: JSON.stringify(['old']) })
    await runProviderChanges(kv as unknown as KVNamespace, vi.fn(async () => false), now, [src(many)])
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('a partial send failure retries only the entry whose send failed', async () => {
    okFetch()
    const a = change({ key: 'a', date: '2026-09-30', text: 'Model A is priced at $1 per 1M tokens.' })
    const b = change({ key: 'b', date: '2026-09-30', text: 'Model B is priced at $2 per 1M tokens.' })
    const kv = fakeKv({ [seenKey('anthropic')]: JSON.stringify(['old']) })
    const first = vi.fn(async (e: { description: string }) => !e.description.includes('Model B'))
    await runProviderChanges(kv as unknown as KVNamespace, first, now, [src([a, b, seen])])
    const second = vi.fn(async (_e: { description: string }) => true)
    await runProviderChanges(kv as unknown as KVNamespace, second, now, [src([a, b, seen])])
    expect(second.mock.calls.map((c) => c[0].description.includes('Model B'))).toEqual([true])
    expect(JSON.parse(kv.store.get(seenKey('anthropic'))!).sort()).toEqual(['a', 'b', 'old'])
  })

  it('an empty parse stores nothing (a broken read must not later make every entry look new)', async () => {
    okFetch()
    const kv = fakeKv({ [seenKey('anthropic')]: JSON.stringify(['old']) })
    const send = vi.fn(async () => true)
    await runProviderChanges(kv as unknown as KVNamespace, send, now, [src([])])
    expect(kv.put).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('an HTTP error stores nothing and sends nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    const kv = fakeKv({ [seenKey('anthropic')]: JSON.stringify(['old']) })
    const send = vi.fn(async () => true)
    await runProviderChanges(kv as unknown as KVNamespace, send, now, [src([priced])])
    expect(kv.put).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('a corrupt stored key set skips the run instead of treating it as a first run', async () => {
    okFetch()
    const kv = fakeKv({ [seenKey('anthropic')]: '{"not":"an array"}' })
    const send = vi.fn(async () => true)
    await runProviderChanges(kv as unknown as KVNamespace, send, now, [src([priced])])
    expect(kv.put).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('a bulk re-key sends one notice and no per-entry alerts, then stores the key set', async () => {
    okFetch()
    const many = Array.from({ length: BULK_REKEY_THRESHOLD + 1 }, (_, i) => change({ key: `k${i}`, date: '2026-09-30' }))
    const kv = fakeKv({ [seenKey('anthropic')]: JSON.stringify(['old']) })
    const send = vi.fn(async (_e: { title: string }) => true)
    await runProviderChanges(kv as unknown as KVNamespace, send, now, [src(many)])
    expect(send.mock.calls.map((c) => c[0].title)).toEqual(['⚠️ Anthropic changelog re-keyed'])
    expect(JSON.parse(kv.store.get(seenKey('anthropic'))!)).toHaveLength(BULK_REKEY_THRESHOLD + 1)
  })

  it('a source whose fetch throws does not stop the next source', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('first')) throw new TypeError('network down')
      return new Response('body', { status: 200 })
    }))
    const kv = fakeKv({ [seenKey('second')]: JSON.stringify(['old']) })
    const send = vi.fn(async () => true)
    const first: ProviderChangeSource = { id: 'first', name: 'First', url: 'https://first.test', parse: () => [priced] }
    const second: ProviderChangeSource = { id: 'second', name: 'Second', url: 'https://second.test', parse: () => [priced, seen] }
    await runProviderChanges(kv as unknown as KVNamespace, send, now, [first, second])
    expect(send).toHaveBeenCalledTimes(1)
    expect(kv.store.has(seenKey('first'))).toBe(false)
    expect(JSON.parse(kv.store.get(seenKey('second'))!)).toEqual(['new', 'old'])
  })

  it('an unchanged key set is not rewritten', async () => {
    okFetch()
    const kv = fakeKv({ [seenKey('anthropic')]: JSON.stringify(['new', 'old']) })
    await runProviderChanges(kv as unknown as KVNamespace, vi.fn(async () => true), now, [src([priced, seen])])
    expect(kv.put).not.toHaveBeenCalled()
  })
})
