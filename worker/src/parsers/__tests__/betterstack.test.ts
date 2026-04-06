import { describe, it, expect, vi } from 'vitest'
import { parseRssIncidents, parseXaiRssIncidents, parseBetterStackStatus, parseBetterStackUptime, parseBetterStackDailyImpact, parseBetterStackResolvedIds } from '../betterstack'

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

  it('filters out micro-incidents resolved in under 60 seconds', () => {
    const xml = `
      <item>
        <guid>http://example.com#micro</guid>
        <title>Service C went down</title>
        <pubDate>Sat, 01 Mar 2026 10:00:00 GMT</pubDate>
        <description>Down</description>
      </item>
      <item>
        <guid>http://example.com#micro</guid>
        <title>Service C recovered</title>
        <pubDate>Sat, 01 Mar 2026 10:00:30 GMT</pubDate>
        <description>Back up</description>
      </item>
    `
    const result = parseRssIncidents(xml)
    expect(result).toHaveLength(0)
  })

  it('keeps incidents resolved in 60 seconds or more', () => {
    const xml = `
      <item>
        <guid>http://example.com#ok</guid>
        <title>Service D went down</title>
        <pubDate>Sat, 01 Mar 2026 10:00:00 GMT</pubDate>
        <description>Down</description>
      </item>
      <item>
        <guid>http://example.com#ok</guid>
        <title>Service D recovered</title>
        <pubDate>Sat, 01 Mar 2026 10:01:00 GMT</pubDate>
        <description>Back up</description>
      </item>
    `
    const result = parseRssIncidents(xml)
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('resolved')
  })

  it('keeps ongoing (unresolved) micro-incidents', () => {
    const xml = `
      <item>
        <guid>http://example.com#ongoing</guid>
        <title>Service E went down</title>
        <pubDate>Sat, 01 Mar 2026 10:00:00 GMT</pubDate>
        <description>Down</description>
      </item>
    `
    const result = parseRssIncidents(xml)
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('investigating')
  })

  it('detects resolved status from description when title unchanged (Modal pattern)', () => {
    const xml = `
      <item>
        <guid>http://example.com/incident/1#hash1</guid>
        <link>http://example.com/incident/1</link>
        <title>Web endpoint degradation</title>
        <pubDate>Sat, 01 Mar 2026 10:00:00 GMT</pubDate>
        <description>Web endpoints are experiencing degradation</description>
      </item>
      <item>
        <guid>http://example.com/incident/1#hash2</guid>
        <link>http://example.com/incident/1</link>
        <title>Web endpoint degradation</title>
        <pubDate>Sat, 01 Mar 2026 10:30:00 GMT</pubDate>
        <description>Things have recovered</description>
      </item>
    `
    const result = parseRssIncidents(xml)
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('resolved')
    expect(result[0].duration).toBe('30m')
  })

  it('detects resolved status from description with "resolved" keyword', () => {
    const xml = `
      <item>
        <guid>http://example.com/incident/2#hash1</guid>
        <link>http://example.com/incident/2</link>
        <title>Sandbox scheduling degraded</title>
        <pubDate>Sat, 01 Mar 2026 10:00:00 GMT</pubDate>
        <description>Sandbox scheduling is degraded</description>
      </item>
      <item>
        <guid>http://example.com/incident/2#hash2</guid>
        <link>http://example.com/incident/2</link>
        <title>Sandbox scheduling degraded</title>
        <pubDate>Sat, 01 Mar 2026 11:00:00 GMT</pubDate>
        <description>We have resolved the issue</description>
      </item>
    `
    const result = parseRssIncidents(xml)
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('resolved')
    expect(result[0].duration).toBe('1h 0m')
  })

  it.each([
    ['is back', 'Our GPU capacity is back.'],
    ['back up', 'Everything is back up.'],
    ['fixed', 'We have identified and fixed the issue.'],
    ['restored', 'Service is fully restored.'],
    ['mitigated', 'The issue has been mitigated.'],
    ['healthy again', 'Web endpoints are healthy again.'],
    ['operational', 'All services operational.'],
  ])('detects resolved via "%s" keyword in description', (_, desc) => {
    const xml = `
      <item>
        <guid>http://example.com/incident/kw#h1</guid>
        <link>http://example.com/incident/kw</link>
        <title>Service outage</title>
        <pubDate>Sat, 01 Mar 2026 10:00:00 GMT</pubDate>
        <description>Something went wrong</description>
      </item>
      <item>
        <guid>http://example.com/incident/kw#h2</guid>
        <link>http://example.com/incident/kw</link>
        <title>Service outage</title>
        <pubDate>Sat, 01 Mar 2026 10:30:00 GMT</pubDate>
        <description>${desc}</description>
      </item>
    `
    const result = parseRssIncidents(xml)
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('resolved')
  })

  it('returns empty for no items', () => {
    expect(parseRssIncidents('<rss></rss>')).toEqual([])
  })

  it('limits to 20 incidents', () => {
    const items = Array.from({ length: 25 }, (_, i) => `
      <item>
        <guid>http://example.com/incident/${i}#hash</guid>
        <link>http://example.com/incident/${i}</link>
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

  it('returns down for aggregate_state "downtime" without resource data', () => {
    expect(parseBetterStackStatus({ data: { attributes: { aggregate_state: 'downtime' } } })).toBe('down')
  })

  it('returns degraded for "downtime" when minority of resources are down', () => {
    expect(parseBetterStackStatus({
      data: { attributes: { aggregate_state: 'downtime' } },
      included: [
        { type: 'status_page_resource', attributes: { status: 'operational' } },
        { type: 'status_page_resource', attributes: { status: 'operational' } },
        { type: 'status_page_resource', attributes: { status: 'downtime' } },
      ],
    })).toBe('degraded')
  })

  it('returns down for "downtime" when majority of resources are down', () => {
    expect(parseBetterStackStatus({
      data: { attributes: { aggregate_state: 'downtime' } },
      included: [
        { type: 'status_page_resource', attributes: { status: 'downtime' } },
        { type: 'status_page_resource', attributes: { status: 'downtime' } },
        { type: 'status_page_resource', attributes: { status: 'operational' } },
      ],
    })).toBe('down')
  })

  it('returns down for "downtime" when all resources are down', () => {
    expect(parseBetterStackStatus({
      data: { attributes: { aggregate_state: 'downtime' } },
      included: [
        { type: 'status_page_resource', attributes: { status: 'downtime' } },
        { type: 'status_page_resource', attributes: { status: 'downtime' } },
      ],
    })).toBe('down')
  })

  it('returns degraded for "downtime" when exactly half are down (conservative)', () => {
    expect(parseBetterStackStatus({
      data: { attributes: { aggregate_state: 'downtime' } },
      included: [
        { type: 'status_page_resource', attributes: { status: 'downtime' } },
        { type: 'status_page_resource', attributes: { status: 'operational' } },
      ],
    })).toBe('degraded')
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

describe('parseBetterStackDailyImpact', () => {
  // Helper: generate N resources, each with the same status_history for a day
  function makeResources(count: number, day: string, status: string, downtime: number) {
    return Array.from({ length: count }, () => ({
      type: 'status_page_resource',
      attributes: {
        status_history: [{ day, status, downtime_duration: downtime, maintenance_duration: 0 }],
      },
    }))
  }

  it('returns null when no resources have status_history', () => {
    expect(parseBetterStackDailyImpact({})).toBeNull()
    expect(parseBetterStackDailyImpact({ included: [] })).toBeNull()
    expect(parseBetterStackDailyImpact({
      included: [{ type: 'status_page_resource', attributes: { status: 'operational' } }],
    })).toBeNull()
  })

  it('returns null when all days are operational', () => {
    const data = {
      included: [{
        type: 'status_page_resource',
        attributes: {
          status_history: [
            { day: '2026-03-25', status: 'operational', downtime_duration: 0, maintenance_duration: 0 },
            { day: '2026-03-26', status: 'operational', downtime_duration: 0, maintenance_duration: 0 },
          ],
        },
      }],
    }
    expect(parseBetterStackDailyImpact(data)).toBeNull()
  })

  it('skips not_monitored status (not actual downtime)', () => {
    const data = {
      included: [{
        type: 'status_page_resource',
        attributes: {
          status_history: [
            { day: '2026-03-25', status: 'not_monitored', downtime_duration: 0, maintenance_duration: 0 },
          ],
        },
      }],
    }
    expect(parseBetterStackDailyImpact(data)).toBeNull()
  })

  // --- Duration-based thresholds (single resource) ---

  it('critical when single resource has 4h+ downtime', () => {
    const data = {
      included: [{
        type: 'status_page_resource',
        attributes: {
          status_history: [
            { day: '2026-03-25', status: 'downtime', downtime_duration: 14400, maintenance_duration: 0 },
          ],
        },
      }],
    }
    expect(parseBetterStackDailyImpact(data)).toEqual({ '2026-03-25': 'critical' })
  })

  it('major (not critical) when 1 of many resources has 1h-4h downtime', () => {
    // 1 of 32 resources with 1h downtime: 3% ratio (below 12%), 3600s (below 14400s) → major
    const affected = makeResources(1, '2026-03-25', 'downtime', 3600)
    const healthy = makeResources(31, '2026-03-25', 'operational', 0)
    expect(parseBetterStackDailyImpact({ included: [...affected, ...healthy] }))
      .toEqual({ '2026-03-25': 'major' })
  })

  it('minor when 1 of many resources has 10min-1h downtime', () => {
    // 1 of 32 resources with 20min downtime: 3% ratio, 1200s → minor
    const affected = makeResources(1, '2026-03-25', 'downtime', 1200)
    const healthy = makeResources(31, '2026-03-25', 'operational', 0)
    expect(parseBetterStackDailyImpact({ included: [...affected, ...healthy] }))
      .toEqual({ '2026-03-25': 'minor' })
  })

  it('skips negligible downtime (<10min) when few resources affected', () => {
    // 1 of 32 resources with 5min downtime: 3% ratio, 300s → negligible
    const affected = makeResources(1, '2026-03-25', 'downtime', 300)
    const healthy = makeResources(31, '2026-03-25', 'operational', 0)
    expect(parseBetterStackDailyImpact({ included: [...affected, ...healthy] })).toBeNull()
  })

  // --- Affected resource ratio thresholds ---

  it('critical when 25%+ resources are affected (even with short downtime)', () => {
    // 8 of 32 resources (25%) have 15min downtime each
    const affected = makeResources(8, '2026-03-25', 'downtime', 900)
    const healthy = makeResources(24, '2026-03-25', 'operational', 0)
    const data = { included: [...affected, ...healthy] }
    expect(parseBetterStackDailyImpact(data)).toEqual({ '2026-03-25': 'critical' })
  })

  it('major when 12-25% resources are affected', () => {
    // 4 of 32 resources (12.5%) have 15min downtime each
    const affected = makeResources(4, '2026-03-25', 'downtime', 900)
    const healthy = makeResources(28, '2026-03-25', 'operational', 0)
    const data = { included: [...affected, ...healthy] }
    expect(parseBetterStackDailyImpact(data)).toEqual({ '2026-03-25': 'major' })
  })

  it('minor when few resources have moderate downtime (below ratio thresholds)', () => {
    // 1 of 32 resources has 20min downtime (3% affected, below 12%)
    const affected = makeResources(1, '2026-03-25', 'downtime', 1200)
    const healthy = makeResources(31, '2026-03-25', 'operational', 0)
    const data = { included: [...affected, ...healthy] }
    expect(parseBetterStackDailyImpact(data)).toEqual({ '2026-03-25': 'minor' })
  })

  // --- Combined: old worst-case bias scenario now correctly handled ---

  it('does not over-escalate: 1 of 32 with 2h downtime → major (not critical)', () => {
    // Old behavior: critical (1h+ on any resource). New: major (2h < 4h threshold, 3% ratio)
    const affected = makeResources(1, '2026-03-25', 'downtime', 7200)
    const healthy = makeResources(31, '2026-03-25', 'operational', 0)
    const data = { included: [...affected, ...healthy] }
    expect(parseBetterStackDailyImpact(data)).toEqual({ '2026-03-25': 'major' })
  })

  it('ignores non-resource entries in included array', () => {
    const data = {
      included: [
        { type: 'status_page_section', attributes: { name: 'section' } },
        {
          type: 'status_page_resource',
          attributes: {
            status_history: [
              { day: '2026-03-25', status: 'downtime', downtime_duration: 14400, maintenance_duration: 0 },
            ],
          },
        },
      ],
    }
    expect(parseBetterStackDailyImpact(data)).toEqual({ '2026-03-25': 'critical' })
  })

  it('handles missing downtime_duration (undefined) gracefully', () => {
    const data = {
      included: [{
        type: 'status_page_resource',
        attributes: {
          status_history: [
            { day: '2026-03-25', status: 'downtime', maintenance_duration: 0 } as any, // no downtime_duration
          ],
        },
      }],
    }
    // downtime_duration ?? 0 → 0 → skipped as negligible
    expect(parseBetterStackDailyImpact(data)).toBeNull()
  })

  it('warns on unknown status values', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const data = {
      included: [{
        type: 'status_page_resource',
        attributes: {
          status_history: [
            { day: '2026-03-25', status: 'new_future_status', downtime_duration: 14400, maintenance_duration: 0 },
          ],
        },
      }],
    }
    const result = parseBetterStackDailyImpact(data)
    expect(result).toEqual({ '2026-03-25': 'critical' })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('unknown status "new_future_status"'))
    spy.mockRestore()
  })

  it('maintenance-only with 0 downtime is skipped (negligible)', () => {
    const data = {
      included: [{
        type: 'status_page_resource',
        attributes: {
          status_history: [
            { day: '2026-03-25', status: 'maintenance', downtime_duration: 0, maintenance_duration: 7200 },
          ],
        },
      }],
    }
    // 0 downtime, 0% ratio → skipped (negligible)
    expect(parseBetterStackDailyImpact(data)).toBeNull()
  })

  it('multi-day history on same resources classifies correctly', () => {
    const resources = Array.from({ length: 32 }, (_, i) => ({
      type: 'status_page_resource',
      attributes: {
        status_history: [
          // Day 1: 10 of 32 resources down (31%) → critical by ratio
          { day: '2026-03-20', status: i < 10 ? 'downtime' : 'operational', downtime_duration: i < 10 ? 900 : 0, maintenance_duration: 0 },
          // Day 2: 1 of 32 resources down 5h → critical by duration
          { day: '2026-03-21', status: i === 0 ? 'downtime' : 'operational', downtime_duration: i === 0 ? 18000 : 0, maintenance_duration: 0 },
          // Day 3: 1 of 32 resources down 30min → minor
          { day: '2026-03-22', status: i === 0 ? 'downtime' : 'operational', downtime_duration: i === 0 ? 1800 : 0, maintenance_duration: 0 },
          // Day 4: all operational
          { day: '2026-03-23', status: 'operational', downtime_duration: 0, maintenance_duration: 0 },
        ],
      },
    }))
    const result = parseBetterStackDailyImpact({ included: resources })
    expect(result).toEqual({
      '2026-03-20': 'critical',  // 31% ratio
      '2026-03-21': 'critical',  // 5h duration
      '2026-03-22': 'minor',     // 30min, 3% ratio
    })
  })
})

describe('parseBetterStackResolvedIds', () => {
  it('extracts resolved status_report IDs', () => {
    const data = {
      included: [
        { type: 'status_report', id: '123', attributes: { aggregate_state: 'resolved' } },
        { type: 'status_report', id: '456', attributes: { aggregate_state: 'investigating' } },
        { type: 'status_report', id: '789', attributes: { aggregate_state: 'resolved' } },
        { type: 'status_page_resource', id: '999', attributes: { status: 'operational' } },
      ],
    }
    const result = parseBetterStackResolvedIds(data)
    expect(result).toEqual(new Set(['123', '789']))
  })

  it('returns empty set when no status_reports', () => {
    expect(parseBetterStackResolvedIds({})).toEqual(new Set())
    expect(parseBetterStackResolvedIds({ included: [] })).toEqual(new Set())
  })
})
