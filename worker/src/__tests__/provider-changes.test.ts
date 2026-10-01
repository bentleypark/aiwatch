import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  PROVIDER_CHANGE_SOURCES,
  classifyProviderChange,
  unescapeXml,
  htmlToText,
  parseOpenAiChanges,
  splitAnthropicEntries,
  parseAnthropicChanges,
  collectProviderChanges,
  type ProviderChange,
} from '../provider-changes'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PROVIDER_CHANGE_SOURCES', () => {
  it('declares the two verified first-party Phase 1 sources', () => {
    expect(PROVIDER_CHANGE_SOURCES.map((s) => s.id)).toEqual([
      'openai',
      'anthropic',
    ])
    expect(PROVIDER_CHANGE_SOURCES[0].feedUrl).toBe(
      'https://community.openai.com/c/announcements/6.rss',
    )
    expect(PROVIDER_CHANGE_SOURCES[1].feedUrl).toBe(
      'https://platform.claude.com/docs/en/release-notes/feed.xml',
    )
  })
})

describe('classifyProviderChange', () => {
  it('detects pricing from money/price signals', () => {
    expect(classifyProviderChange('The API now costs $1.50 per million tokens')).toBe(
      'pricing',
    )
    expect(classifyProviderChange('Reduced pricing for cached input tokens')).toBe(
      'pricing',
    )
  })

  it('detects deprecation before billing/limits', () => {
    expect(
      classifyProviderChange('The v1 endpoint is deprecated and will be removed'),
    ).toBe('deprecation')
    expect(classifyProviderChange('This model is being retired next month')).toBe(
      'deprecation',
    )
  })

  it('detects billing, limits and launch', () => {
    expect(classifyProviderChange('Updated invoices now include taxes')).toBe(
      'billing',
    )
    expect(classifyProviderChange('Higher rate limits for the paid tier')).toBe(
      'limits',
    )
    expect(classifyProviderChange('We are launching a new image model')).toBe(
      'launch',
    )
  })

  it('returns null for non-actionable lines', () => {
    expect(classifyProviderChange('Fixed a typo in the documentation')).toBeNull()
    expect(classifyProviderChange('')).toBeNull()
  })
})

describe('unescapeXml / htmlToText', () => {
  it('unwraps CDATA and decodes entities', () => {
    expect(unescapeXml('<![CDATA[AT&T &amp; co]]>')).toBe('AT&T & co')
    expect(unescapeXml('&#x27;hi&#x27;')).toBe("'hi'")
  })

  it('strips tags and collapses whitespace', () => {
    expect(htmlToText('<li>Hello <b>world</b></li>')).toBe('Hello world')
  })
})

describe('parseOpenAiChanges', () => {
  const feed = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>New API pricing</title>
    <link>https://community.openai.com/t/1</link>
    <pubDate>Wed, 01 Oct 2026 12:00:00 GMT</pubDate>
    <description><![CDATA[<p>We lowered the price to $0.75 per million tokens.</p>]]></description>
  </item>
  <item>
    <title>A community thread</title>
    <link>https://community.openai.com/t/2</link>
    <pubDate>Tue, 30 Sep 2026 12:00:00 GMT</pubDate>
    <description><![CDATA[<p>General discussion about prompts.</p>]]></description>
  </item>
</channel></rss>`

  it('keeps body-classified changes and drops non-actionable items', () => {
    const changes = parseOpenAiChanges(feed)
    expect(changes).toHaveLength(1)
    expect(changes[0].provider).toBe('openai')
    expect(changes[0].category).toBe('pricing')
    expect(changes[0].date).toContain('2026-10-01')
  })
})

describe('parseAnthropicChanges — mixed price / non-price day (#1570)', () => {
  // One per-day item whose body mixes one pricing bullet with non-price bullets.
  const feed = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>October 1, 2026</title>
    <link>https://platform.claude.com/docs/en/release-notes</link>
    <pubDate>Thu, 01 Oct 2026 12:00:00 GMT</pubDate>
    <description><![CDATA[
      <ul>
        <li>Reduced the price of the Sonnect API to $2 per million input tokens.</li>
        <li>Improved the reliability of the tool-use streaming endpoint.</li>
        <li>Added a new code example to the files guide.</li>
        <li>The legacy completions endpoint is deprecated and will be removed.</li>
      </ul>
    ]]></description>
  </item>
</channel></rss>`

  it('splits the day into individual <li> entries', () => {
    const item = feed.match(/<item[\s>][\s\S]*?<\/item>/i)![0]
    const entries = splitAnthropicEntries(item)
    expect(entries).toHaveLength(4)
    expect(entries[0].text).toContain('Reduced the price')
    expect(entries[0].date).toContain('2026-10-01')
    expect(entries[0].url).toContain('#L1')
  })

  it('classifies only the actionable lines, not the non-price lines', () => {
    const changes = parseAnthropicChanges(feed)
    // price bullet + deprecation bullet; reliability/example lines dropped
    expect(changes.map((c) => c.category).sort()).toEqual([
      'deprecation',
      'pricing',
    ])
    const price = changes.find((c) => c.category === 'pricing')!
    expect(price.provider).toBe('anthropic')
    expect(price.title).toContain('$2 per million')
    expect(price.date).toContain('2026-10-01')
  })

  it('does not force-classify a day with only non-actionable lines', () => {
    const onlyNoise = `<?xml version="1.0"?><rss><channel><item>
      <title>September 30, 2026</title>
      <link>https://example.com/notes</link>
      <pubDate>Wed, 30 Sep 2026 12:00:00 GMT</pubDate>
      <description><![CDATA[<ul>
        <li>Fixed a small typo.</li>
        <li>Polished the docs layout.</li>
      </ul>]]></description>
    </item></channel></rss>`
    expect(parseAnthropicChanges(onlyNoise)).toHaveLength(0)
  })
})

describe('collectProviderChanges', () => {
  it('returns recent changes and tolerates one source failing', async () => {
    const openaiFeed = `<?xml version="1.0"?><rss><channel><item>
      <title>Price cut</title><link>https://community.openai.com/t/9</link>
      <pubDate>${new Date().toUTCString()}</pubDate>
      <description><![CDATA[<p>Price reduced to $1 per million tokens.</p>]]></description>
    </item></channel></rss>`

    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('community.openai.com')) return openaiFeed
      throw new Error('region blocked')
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const changes = await collectProviderChanges({ fetchImpl })
    expect(changes).toHaveLength(1)
    expect(changes[0].category).toBe('pricing')
    expect(warnSpy).toHaveBeenCalled()
  })

  it('drops entries older than the lookback window', async () => {
    const oldFeed = `<?xml version="1.0"?><rss><channel><item>
      <title>Old price</title><link>https://community.openai.com/t/old</link>
      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
      <description><![CDATA[<p>Pricing changed to $5 per million.</p>]]></description>
    </item></channel></rss>`
    const fetchImpl = vi.fn(async () => oldFeed)
    const changes = await collectProviderChanges({ fetchImpl })
    expect(changes).toHaveLength(0)
  })
})
