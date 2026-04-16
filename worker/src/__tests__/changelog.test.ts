import { describe, it, expect } from 'vitest'
import { parseRssEntries, parseAnthropicNews, isRelevantEntry, formatChangelogSection, CHANGELOG_SOURCES, type ChangelogEntry } from '../changelog'

describe('CHANGELOG_SOURCES', () => {
  it('has 4 sources (3 pilot + copilot)', () => {
    expect(CHANGELOG_SOURCES).toHaveLength(4)
    expect(CHANGELOG_SOURCES.map((s) => s.id)).toEqual(['openai', 'google', 'anthropic', 'copilot'])
  })

  it('copilot source uses rss type with pre-filtered changelog feed', () => {
    const copilot = CHANGELOG_SOURCES.find((s) => s.id === 'copilot')!
    expect(copilot.type).toBe('rss')
    expect(copilot.feedUrl).toContain('github.blog/changelog/label/copilot')
  })

  it('anthropic source uses html type', () => {
    const anthropic = CHANGELOG_SOURCES.find((s) => s.id === 'anthropic')!
    expect(anthropic.type).toBe('html')
    expect(anthropic.feedUrl).toBe('https://www.anthropic.com/news')
  })
})

describe('parseRssEntries', () => {
  const sampleRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>OpenAI News</title>
    <item>
      <title>Introducing GPT-5</title>
      <link>https://openai.com/blog/gpt-5</link>
      <pubDate>Wed, 09 Apr 2026 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title><![CDATA[New API pricing update]]></title>
      <link>https://openai.com/blog/pricing</link>
      <pubDate>Tue, 08 Apr 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Team spotlight: safety research</title>
      <link>https://openai.com/blog/team</link>
      <pubDate>Mon, 07 Apr 2026 09:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`

  it('parses RSS items with title, link, date', () => {
    const entries = parseRssEntries(sampleRss, 'openai')
    expect(entries).toHaveLength(3)
    expect(entries[0].title).toBe('Introducing GPT-5')
    expect(entries[0].url).toBe('https://openai.com/blog/gpt-5')
    expect(entries[0].source).toBe('openai')
    expect(entries[0].date).toContain('2026-04-09')
  })

  it('handles CDATA in title', () => {
    const entries = parseRssEntries(sampleRss, 'openai')
    expect(entries[1].title).toBe('New API pricing update')
  })

  it('limits to 50 items', () => {
    const items = Array.from({ length: 60 }, (_, i) =>
      `<item><title>Item ${i}</title><link>https://example.com/${i}</link><pubDate>Wed, 09 Apr 2026 12:00:00 GMT</pubDate></item>`,
    ).join('')
    const xml = `<rss><channel>${items}</channel></rss>`
    expect(parseRssEntries(xml, 'test')).toHaveLength(50)
  })

  it('returns empty for invalid XML', () => {
    expect(parseRssEntries('not xml', 'test')).toEqual([])
    expect(parseRssEntries('<rss><channel></channel></rss>', 'test')).toEqual([])
  })

  it('handles malformed dates gracefully', () => {
    const xml = `<rss><channel><item><title>Test</title><link>https://example.com</link><pubDate>not-a-date</pubDate></item></channel></rss>`
    const entries = parseRssEntries(xml, 'test')
    expect(entries).toHaveLength(1)
    expect(entries[0].date).toBe('')
  })
})

describe('parseAnthropicNews', () => {
  // Minimal mock of the Next.js SSR payload structure
  const mockHtml = `<html><script>self.__next_f.push([1,"
    \\"publishedOn\\":\\"2026-04-07T18:00:00.000Z\\",\\"slug\\":{\\"_type\\":\\"slug\\",\\"current\\":\\"project-glasswing\\"},\\"subjects\\":[],\\"title\\":\\"Project Glasswing\\"
    \\"publishedOn\\":\\"2026-02-17T18:00:00.000Z\\",\\"slug\\":{\\"_type\\":\\"slug\\",\\"current\\":\\"claude-sonnet-4-6\\"},\\"subjects\\":[],\\"title\\":\\"Introducing Claude Sonnet 4.6\\"
    \\"publishedOn\\":\\"2026-02-05T18:00:00.000Z\\",\\"slug\\":{\\"_type\\":\\"slug\\",\\"current\\":\\"claude-opus-4-6\\"},\\"subjects\\":[],\\"title\\":\\"Introducing Claude Opus 4.6\\"
    \\"publishedOn\\":\\"2026-03-12T14:39:00.000Z\\",\\"slug\\":{\\"_type\\":\\"slug\\",\\"current\\":\\"claude-partner-network\\"},\\"subjects\\":[],\\"title\\":\\"Anthropic invests $100 million into the Claude Partner Network\\"
    \\"publishedOn\\":\\"2025-12-02T18:00:00.000Z\\",\\"slug\\":{\\"_type\\":\\"slug\\",\\"current\\":\\"anthropic-acquires-bun\\"},\\"subjects\\":[],\\"title\\":\\"Anthropic acquires Bun as Claude Code reaches $1B milestone\\"
  "])</script></html>`

  it('extracts news list posts with title, slug, date', () => {
    const entries = parseAnthropicNews(mockHtml)
    expect(entries.length).toBeGreaterThanOrEqual(4)
    const sonnet = entries.find((e) => e.title === 'Introducing Claude Sonnet 4.6')
    expect(sonnet).toBeDefined()
    expect(sonnet!.url).toBe('https://www.anthropic.com/news/claude-sonnet-4-6')
    expect(sonnet!.date).toContain('2026-02-17')
  })

  it('extracts featured grid items (e.g. Project Glasswing)', () => {
    const featuredHtml = `<html><script>self.__next_f.push([1,"
      \\"_type\\":\\"featuredGridLink\\",\\"date\\":\\"2026-04-07\\",\\"subject\\":\\"Announcements\\",\\"summary\\":\\"A new initiative...\\",\\"title\\":\\"Project Glasswing\\",\\"url\\":\\"/glasswing\\"
      \\"_type\\":\\"featuredGridLink\\",\\"date\\":\\"2026-03-18\\",\\"summary\\":\\"We invited Claude.ai users...\\",\\"title\\":\\"What 81,000 people want from AI\\",\\"url\\":\\"/news/what-81000-people-want\\"
    "])</script></html>`
    const entries = parseAnthropicNews(featuredHtml)
    expect(entries.length).toBe(2)
    const glasswing = entries.find((e) => e.title === 'Project Glasswing')
    expect(glasswing).toBeDefined()
    expect(glasswing!.url).toBe('https://www.anthropic.com/glasswing')
    expect(glasswing!.date).toContain('2026-04-07')
  })

  it('combines featured + news list and deduplicates', () => {
    const combinedHtml = `<html><script>self.__next_f.push([1,"
      \\"_type\\":\\"featuredGridLink\\",\\"date\\":\\"2026-04-07\\",\\"summary\\":\\"test\\",\\"title\\":\\"Project Glasswing\\",\\"url\\":\\"/glasswing\\"
      \\"publishedOn\\":\\"2026-02-17T18:00:00.000Z\\",\\"slug\\":{\\"_type\\":\\"slug\\",\\"current\\":\\"claude-sonnet-4-6\\"},\\"subjects\\":[],\\"title\\":\\"Introducing Claude Sonnet 4.6\\"
    "])</script></html>`
    const entries = parseAnthropicNews(combinedHtml)
    expect(entries.length).toBe(2)
    expect(entries.map((e) => e.title)).toContain('Project Glasswing')
    expect(entries.map((e) => e.title)).toContain('Introducing Claude Sonnet 4.6')
  })

  it('deduplicates by URL', () => {
    const duped = mockHtml + mockHtml
    const entries = parseAnthropicNews(duped)
    const urls = entries.map((e) => e.url)
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('returns empty for non-Anthropic HTML', () => {
    expect(parseAnthropicNews('<html><body>Hello</body></html>')).toEqual([])
  })
})

describe('isRelevantEntry', () => {
  describe('Anthropic news', () => {
    it('product launches are relevant', () => {
      expect(isRelevantEntry('Introducing Claude Sonnet 4.6', 'anthropic')).toBe(true)
      expect(isRelevantEntry('Introducing Claude Opus 4.6', 'anthropic')).toBe(true)
      expect(isRelevantEntry('Claude Opus 4.1', 'anthropic')).toBe(true)
      expect(isRelevantEntry('Introducing Claude Haiku 4.5', 'anthropic')).toBe(true)
      expect(isRelevantEntry('Anthropic acquires Bun as Claude Code reaches $1B milestone', 'anthropic')).toBe(true)
      expect(isRelevantEntry('Introducing the Model Context Protocol', 'anthropic')).toBe(true)
      expect(isRelevantEntry('Enabling Claude Code to work more autonomously', 'anthropic')).toBe(true)
      expect(isRelevantEntry('Developing a computer use model', 'anthropic')).toBe(true)
      // Frontier model / project codenames
      expect(isRelevantEntry('Project Glasswing', 'anthropic')).toBe(true)
      expect(isRelevantEntry('Claude Mythos Preview', 'anthropic')).toBe(true)
      expect(isRelevantEntry('Making frontier cybersecurity capabilities available to defenders', 'anthropic')).toBe(true)
    })

    it('corporate/policy posts are filtered', () => {
      expect(isRelevantEntry('Australian government and Anthropic sign MOU for AI safety', 'anthropic')).toBe(false)
      expect(isRelevantEntry('Anthropic\'s Responsible Scaling Policy: Version 3.0', 'anthropic')).toBe(false)
      expect(isRelevantEntry('Statement from Dario Amodei on the Paris AI Action Summit', 'anthropic')).toBe(false)
      expect(isRelevantEntry('Where things stand with the Department of War', 'anthropic')).toBe(false)
      expect(isRelevantEntry('Anthropic Education Report: How university students use Claude', 'anthropic')).toBe(false)
      expect(isRelevantEntry('Sydney will become Anthropic\'s fourth office in Asia-Pacific', 'anthropic')).toBe(false)
      expect(isRelevantEntry('Mariano-Florentino Cuéllar appointed to Anthropic\'s Long-Term Benefit Trust', 'anthropic')).toBe(false)
    })
  })

  describe('OpenAI/Google blog', () => {
    it('API/model posts are relevant', () => {
      expect(isRelevantEntry('Introducing GPT-5', 'openai')).toBe(true)
      expect(isRelevantEntry('New API pricing update', 'openai')).toBe(true)
      expect(isRelevantEntry('Gemini 2.5 Pro release', 'google')).toBe(true)
      expect(isRelevantEntry('Fine-tuning API updates', 'openai')).toBe(true)
      expect(isRelevantEntry('Batch API now available', 'openai')).toBe(true)
      // Real OpenAI product announcements
      expect(isRelevantEntry('Introducing GPT-5.4 mini and nano', 'openai')).toBe(true)
      expect(isRelevantEntry('Codex now offers more flexible pricing for teams', 'openai')).toBe(true)
      expect(isRelevantEntry('Creating with Sora Safely', 'openai')).toBe(true)
      expect(isRelevantEntry('From model to agent: Equipping the Responses API with a computer environment', 'openai')).toBe(true)
      // Real Google product announcements
      expect(isRelevantEntry('New ways to balance cost and reliability in the Gemini API', 'google')).toBe(true)
      expect(isRelevantEntry('Build with Veo 3.1 Lite, our most cost-effective video generation model', 'google')).toBe(true)
      expect(isRelevantEntry('Gemini 3.1 Flash Live: Making audio AI more natural and reliable', 'google')).toBe(true)
    })

    it('noise posts are filtered', () => {
      expect(isRelevantEntry('Team spotlight: safety research', 'openai')).toBe(false)
      expect(isRelevantEntry('We are hiring engineers', 'openai')).toBe(false)
      expect(isRelevantEntry('Using custom GPTs', 'openai')).toBe(false)
      expect(isRelevantEntry('Creating images with ChatGPT', 'openai')).toBe(false)
      expect(isRelevantEntry('ChatGPT for marketing teams', 'openai')).toBe(false)
      expect(isRelevantEntry('Getting started with ChatGPT', 'openai')).toBe(false)
      // Safety/policy/internal posts
      expect(isRelevantEntry('Introducing the Child Safety Blueprint', 'openai')).toBe(false)
      expect(isRelevantEntry('Inside our approach to the Model Spec', 'openai')).toBe(false)
      expect(isRelevantEntry('Introducing the OpenAI Safety Bug Bounty program', 'openai')).toBe(false)
      expect(isRelevantEntry('How we monitor internal coding agents for misalignment', 'openai')).toBe(false)
      expect(isRelevantEntry('Our response to the Axios developer tool compromise', 'openai')).toBe(false)
    })

    it('generic posts without keywords are filtered', () => {
      expect(isRelevantEntry('Our thoughts on responsible AI', 'openai')).toBe(false)
      expect(isRelevantEntry('Partnering with schools in Kenya', 'google')).toBe(false)
    })
  })

  describe('GitHub Copilot changelog', () => {
    it('all entries are relevant (pre-filtered feed)', () => {
      expect(isRelevantEntry('Enable Copilot cloud agent via custom properties', 'copilot')).toBe(true)
      expect(isRelevantEntry('Model selection for Claude and Codex agents on github.com', 'copilot')).toBe(true)
      expect(isRelevantEntry('Copilot now supports multi-file edits', 'copilot')).toBe(true)
    })
  })
})

describe('formatChangelogSection', () => {
  it('formats entries with date and source', () => {
    const entries: ChangelogEntry[] = [
      { source: 'openai', title: 'GPT-5 released', url: 'https://openai.com', date: '2026-04-10T00:00:00Z' },
      { source: 'anthropic', title: 'Introducing Claude Sonnet 4.6', url: 'https://anthropic.com', date: '2026-04-09T00:00:00Z' },
    ]
    const result = formatChangelogSection(entries)
    expect(result).toContain('OpenAI: GPT-5 released (4/10)')
    expect(result).toContain('Anthropic: Introducing Claude Sonnet 4.6 (4/9)')
  })

  it('returns fallback message for empty entries', () => {
    expect(formatChangelogSection([])).toBe('No service changes detected this week.')
  })

  it('limits to 8 items and sorts by date descending', () => {
    const entries: ChangelogEntry[] = Array.from({ length: 12 }, (_, i) => ({
      source: 'openai', title: `Item ${i}`, url: 'https://example.com', date: `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }))
    const lines = formatChangelogSection(entries).split('\n')
    expect(lines).toHaveLength(8)
    // First line should be most recent
    expect(lines[0]).toContain('4/12')
  })
})
