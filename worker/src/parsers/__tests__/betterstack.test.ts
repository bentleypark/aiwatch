import { describe, it, expect, vi } from 'vitest'
import { parseRssIncidents, parseXaiRssIncidents, parseBetterStackStatus, parseBetterStackUptime } from '../betterstack'

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

  it('limits to 20 incidents', () => {
    const items = Array.from({ length: 25 }, (_, i) => `
      <item>
        <guid>http://example.com#${i}</guid>
        <title>Svc ${i} went down</title>
        <pubDate>Sat, 01 Mar 2026 ${String(i).padStart(2, '0')}:00:00 GMT</pubDate>
        <description>Down</description>
      </item>
    `).join('')
    const result = parseRssIncidents(`<rss>${items}</rss>`)
    expect(result).toHaveLength(20)
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

describe('parseBetterStackStatus', () => {
  it('returns operational for aggregate_state "operational"', () => {
    expect(parseBetterStackStatus({ data: { attributes: { aggregate_state: 'operational' } } })).toBe('operational')
  })

  it('returns down for aggregate_state "downtime"', () => {
    expect(parseBetterStackStatus({ data: { attributes: { aggregate_state: 'downtime' } } })).toBe('down')
  })

  it('returns degraded for "degraded" and "maintenance"', () => {
    expect(parseBetterStackStatus({ data: { attributes: { aggregate_state: 'degraded' } } })).toBe('degraded')
    expect(parseBetterStackStatus({ data: { attributes: { aggregate_state: 'maintenance' } } })).toBe('degraded')
  })

  it('returns degraded with warning for unknown state', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseBetterStackStatus({ data: { attributes: { aggregate_state: 'new_state' } } })).toBe('degraded')
    expect(spy).toHaveBeenCalledOnce()
    spy.mockRestore()
  })

  it('returns null when data or aggregate_state is missing', () => {
    expect(parseBetterStackStatus({})).toBeNull()
    expect(parseBetterStackStatus({ data: {} })).toBeNull()
    expect(parseBetterStackStatus({ data: { attributes: {} } })).toBeNull()
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
