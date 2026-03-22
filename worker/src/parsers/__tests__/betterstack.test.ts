import { describe, it, expect } from 'vitest'
import { parseRssIncidents, parseXaiRssIncidents, parseBetterStackUptime } from '../betterstack'

describe('parseRssIncidents', () => {
  it('groups RSS items by guid into incidents', () => {
    const xml = `
      <item>
        <guid>http://example.com#1</guid>
        <title>Service A went down</title>
        <pubDate>Sat, 01 Mar 2026 10:00:00 GMT</pubDate>
        <description>Down</description>
      </item>
      <item>
        <guid>http://example.com#1</guid>
        <title>Service A recovered</title>
        <pubDate>Sat, 01 Mar 2026 10:30:00 GMT</pubDate>
        <description>Back up</description>
      </item>
    `
    const result = parseRssIncidents(xml)
    expect(result).toHaveLength(1)
    expect(result[0].title).toContain('Service A')
    expect(result[0].title).toContain('recovered')
    expect(result[0].status).toBe('resolved')
    expect(result[0].duration).toBe('30m')
    expect(result[0].timeline).toHaveLength(2)
  })

  it('marks unresolved when no recovery item', () => {
    const xml = `
      <item>
        <guid>http://example.com#2</guid>
        <title>Service B went down</title>
        <pubDate>Sat, 01 Mar 2026 10:00:00 GMT</pubDate>
        <description>Down</description>
      </item>
    `
    const result = parseRssIncidents(xml)
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('investigating')
    expect(result[0].duration).toBeNull()
  })

  it('returns empty for no items', () => {
    expect(parseRssIncidents('<rss></rss>')).toEqual([])
  })

  it('limits to 5 incidents', () => {
    const items = Array.from({ length: 10 }, (_, i) => `
      <item>
        <guid>http://example.com#${i}</guid>
        <title>Svc ${i} went down</title>
        <pubDate>Sat, 01 Mar 2026 ${10 + i}:00:00 GMT</pubDate>
        <description>Down</description>
      </item>
    `).join('')
    const result = parseRssIncidents(`<rss>${items}</rss>`)
    expect(result).toHaveLength(5)
  })
})

describe('parseXaiRssIncidents', () => {
  it('parses xAI RSS with HTML description', () => {
    const xml = `
      <item>
        <title>[API] High Error Rates</title>
        <guid isPermaLink="false">inc-123</guid>
        <description><![CDATA[
          Status: RESOLVED
          Resolved: Sat, 01 Mar 2026 12:00:00 GMT
          <div><strong>Sat, 01 Mar 2026 10:00:00 GMT</strong><h3>Investigating</h3><p>Looking into it</p></div>
          <div><strong>Sat, 01 Mar 2026 12:00:00 GMT</strong><h3>Resolved</h3><p>Fixed</p></div>
        ]]></description>
      </item>
    `
    const result = parseXaiRssIncidents(xml)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('[API] High Error Rates')
    expect(result[0].status).toBe('resolved')
    expect(result[0].timeline.length).toBeGreaterThan(0)
  })

  it('returns empty for no items', () => {
    expect(parseXaiRssIncidents('<rss></rss>')).toEqual([])
  })
})

describe('parseBetterStackUptime', () => {
  it('computes average availability from resources', () => {
    const data = {
      included: [
        { type: 'status_page_resource', attributes: { availability: 0.999 } },
        { type: 'status_page_resource', attributes: { availability: 1.0 } },
        { type: 'status_page_section', attributes: { name: 'section' } },
      ],
    }
    const result = parseBetterStackUptime(data)
    expect(result).toBe(99.95) // (99.9 + 100) / 2
  })

  it('returns null when no resources', () => {
    expect(parseBetterStackUptime({ included: [] })).toBeNull()
    expect(parseBetterStackUptime({})).toBeNull()
  })

  it('returns null for out-of-range availability', () => {
    const data = {
      included: [
        { type: 'status_page_resource', attributes: { availability: 9.99 } },
      ],
    }
    // 9.99 * 100 = 999% → out of range
    expect(parseBetterStackUptime(data)).toBeNull()
  })
})
