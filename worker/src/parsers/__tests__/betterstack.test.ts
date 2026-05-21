import { describe, it, expect, vi } from 'vitest'
import { parseRssIncidents, parseXaiRssIncidents, parseBetterStackStatus, parseBetterStackUptime, parseBetterStackDailyImpact, parseBetterStackResolvedIds, parseBetterStackPartialCount } from '../betterstack'

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

  it('separates incidents when link is homepage URL (Fireworks/Together/HuggingFace pattern)', () => {
    // BetterStack RSS: all <link> tags point to homepage, guid hash is per-incident
    const xml = `
      <item>
        <guid>https://status.fireworks.ai/#aaa111</guid>
        <link>https://status.fireworks.ai/</link>
        <title>Service A went down</title>
        <pubDate>Sat, 01 Mar 2026 10:00:00 GMT</pubDate>
        <description>Down</description>
      </item>
      <item>
        <guid>https://status.fireworks.ai/#aaa111</guid>
        <link>https://status.fireworks.ai/</link>
        <title>Service A recovered</title>
        <pubDate>Sat, 01 Mar 2026 10:30:00 GMT</pubDate>
        <description>Back up</description>
      </item>
      <item>
        <guid>https://status.fireworks.ai/#bbb222</guid>
        <link>https://status.fireworks.ai/</link>
        <title>Service B went down</title>
        <pubDate>Sat, 01 Mar 2026 12:00:00 GMT</pubDate>
        <description>Down</description>
      </item>
      <item>
        <guid>https://status.fireworks.ai/#bbb222</guid>
        <link>https://status.fireworks.ai/</link>
        <title>Service B recovered</title>
        <pubDate>Sat, 01 Mar 2026 12:15:00 GMT</pubDate>
        <description>Back up</description>
      </item>
    `
    const result = parseRssIncidents(xml)
    expect(result).toHaveLength(2)
    expect(result[0].title).toContain('Service A')
    expect(result[0].status).toBe('resolved')
    expect(result[1].title).toContain('Service B')
    expect(result[1].status).toBe('resolved')
  })

  it('groups by link when link is a unique incident URL (Modal pattern)', () => {
    // Modal RSS: <link> has unique incident URLs, guid hash varies per update
    const xml = `
      <item>
        <guid>https://status.modal.com/incident/100#hash1</guid>
        <link>https://status.modal.com/incident/100</link>
        <title>Web endpoint degradation</title>
        <pubDate>Sat, 01 Mar 2026 10:00:00 GMT</pubDate>
        <description>Degraded</description>
      </item>
      <item>
        <guid>https://status.modal.com/incident/100#hash2</guid>
        <link>https://status.modal.com/incident/100</link>
        <title>Web endpoint degradation</title>
        <pubDate>Sat, 01 Mar 2026 10:30:00 GMT</pubDate>
        <description>Recovered</description>
      </item>
      <item>
        <guid>https://status.modal.com/incident/200#hash3</guid>
        <link>https://status.modal.com/incident/200</link>
        <title>API latency spike</title>
        <pubDate>Sat, 01 Mar 2026 14:00:00 GMT</pubDate>
        <description>Spike detected</description>
      </item>
    `
    const result = parseRssIncidents(xml)
    expect(result).toHaveLength(2)
    expect(result[0].title).toContain('Web endpoint')
    expect(result[0].status).toBe('resolved')
    expect(result[1].title).toContain('API latency')
    expect(result[1].status).toBe('investigating')
  })

  it('does not merge different incidents into mega-incident when all links are homepage', () => {
    // Regression test: the actual bug — resolved + unresolved incidents from different dates
    // were merged into one 1712h mega-incident, causing false degraded status
    const xml = `
      <item>
        <guid>https://status.fireworks.ai/#old111</guid>
        <link>https://status.fireworks.ai/</link>
        <title>Llama API went down</title>
        <pubDate>Thu, 12 Mar 2026 18:02:55 GMT</pubDate>
        <description>Down</description>
      </item>
      <item>
        <guid>https://status.fireworks.ai/#old111</guid>
        <link>https://status.fireworks.ai/</link>
        <title>Llama API recovered</title>
        <pubDate>Thu, 12 Mar 2026 18:08:55 GMT</pubDate>
        <description>Back up</description>
      </item>
      <item>
        <guid>https://status.fireworks.ai/#new222</guid>
        <link>https://status.fireworks.ai/</link>
        <title>Embed API went down</title>
        <pubDate>Tue, 01 Apr 2026 03:05:14 GMT</pubDate>
        <description>Down</description>
      </item>
      <item>
        <guid>https://status.fireworks.ai/#new222</guid>
        <link>https://status.fireworks.ai/</link>
        <title>Embed API recovered</title>
        <pubDate>Tue, 01 Apr 2026 03:08:03 GMT</pubDate>
        <description>Back up</description>
      </item>
    `
    const result = parseRssIncidents(xml)
    expect(result).toHaveLength(2)
    // Each incident has correct short duration, not a merged 1712h duration
    expect(result[0].duration).toBe('6m')
    expect(result[1].duration).toBe('3m')
    expect(result.every(i => i.status === 'resolved')).toBe(true)
  })

  it('unresolved incident with homepage link does not infect resolved ones', () => {
    // An active "went down" should be its own incident, not merge with recovered ones
    const xml = `
      <item>
        <guid>https://status.together.ai/#resolved1</guid>
        <link>https://status.together.ai/</link>
        <title>Service X went down</title>
        <pubDate>Sat, 01 Mar 2026 10:00:00 GMT</pubDate>
        <description>Down</description>
      </item>
      <item>
        <guid>https://status.together.ai/#resolved1</guid>
        <link>https://status.together.ai/</link>
        <title>Service X recovered</title>
        <pubDate>Sat, 01 Mar 2026 10:30:00 GMT</pubDate>
        <description>Back up</description>
      </item>
      <item>
        <guid>https://status.together.ai/#active2</guid>
        <link>https://status.together.ai/</link>
        <title>Service Y went down</title>
        <pubDate>Mon, 06 Apr 2026 12:00:00 GMT</pubDate>
        <description>Down</description>
      </item>
    `
    const result = parseRssIncidents(xml)
    expect(result).toHaveLength(2)
    expect(result[0].status).toBe('resolved')
    expect(result[1].status).toBe('investigating')
    expect(result[1].title).toContain('Service Y')
  })

  it('handles homepage link without trailing slash', () => {
    const xml = `
      <item>
        <guid>https://status.example.com/#inc1</guid>
        <link>https://status.example.com</link>
        <title>API went down</title>
        <pubDate>Sat, 01 Mar 2026 10:00:00 GMT</pubDate>
        <description>Down</description>
      </item>
      <item>
        <guid>https://status.example.com/#inc2</guid>
        <link>https://status.example.com</link>
        <title>DB went down</title>
        <pubDate>Sat, 01 Mar 2026 12:00:00 GMT</pubDate>
        <description>Down</description>
      </item>
    `
    const result = parseRssIncidents(xml)
    expect(result).toHaveLength(2)
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

  // #331: Together's BetterStack RSS carries planned-maintenance announcements
  // with a scheduled title + future pubDate. The old parser rendered these as
  // phantom "Scheduled Network Maintenance — down" incidents. Regression tests:
  describe('scheduled maintenance / future pubDate filter (#331)', () => {
    it('skips entries titled "Scheduled Network Maintenance"', () => {
      const xml = `
        <item>
          <guid>https://status.together.ai/incident/876784#hash</guid>
          <title>Scheduled Network Maintenance</title>
          <pubDate>Sat, 25 Apr 2026 12:00:01 GMT</pubDate>
          <description>We will be performing scheduled network maintenance from April 25...</description>
        </item>
      `
      // Use a `now` past the pubDate so the future-date filter can't short-circuit
      // the test — we want to prove the TITLE filter specifically works.
      const fixedNow = new Date('2026-04-30T00:00:00Z').getTime()
      const result = parseRssIncidents(xml, fixedNow)
      expect(result).toHaveLength(0)
    })

    it('skips entries titled "Scheduled Maintenance" (no "network")', () => {
      const xml = `
        <item>
          <guid>https://status.example.com/m/1#h</guid>
          <title>Scheduled maintenance</title>
          <pubDate>Sat, 01 Mar 2026 10:00:00 GMT</pubDate>
          <description>Routine upgrade</description>
        </item>
      `
      const fixedNow = new Date('2026-03-15T00:00:00Z').getTime()
      expect(parseRssIncidents(xml, fixedNow)).toHaveLength(0)
    })

    it('skips entries with pubDate in the future (> 60s past now)', () => {
      // Future-dated announcement with a NON-matching title (just to prove the
      // future-date filter works independently of the title regex).
      const xml = `
        <item>
          <guid>https://status.example.com/future#1</guid>
          <title>Database Upgrade Window</title>
          <pubDate>Sat, 01 May 2026 10:00:00 GMT</pubDate>
          <description>We'll be rotating the primary DB cluster next week.</description>
        </item>
      `
      const fixedNow = new Date('2026-04-20T00:00:00Z').getTime()
      expect(parseRssIncidents(xml, fixedNow)).toHaveLength(0)
    })

    it('keeps entries with pubDate within the 60s clock-skew buffer', () => {
      // pubDate is 30s in the future — within the clock-skew tolerance, so it
      // should still render. Prevents false positives from minor NTP drift.
      const pubDate = new Date('2026-03-01T10:00:30Z').toUTCString()
      const xml = `
        <item>
          <guid>https://status.example.com/skew#1</guid>
          <title>Service X went down</title>
          <pubDate>${pubDate}</pubDate>
          <description>Errors</description>
        </item>
      `
      const fixedNow = new Date('2026-03-01T10:00:00Z').getTime()
      expect(parseRssIncidents(xml, fixedNow)).toHaveLength(1)
    })

    it('still processes a normal incident alongside a filtered maintenance entry', () => {
      // Regression guard: a real incident in the same feed must not be affected
      // by a sibling scheduled-maintenance item.
      const xml = `
        <item>
          <guid>https://status.together.ai/incident/876784#hash1</guid>
          <title>Scheduled Network Maintenance</title>
          <pubDate>Sat, 25 Apr 2026 12:00:01 GMT</pubDate>
          <description>We will be performing scheduled network maintenance</description>
        </item>
        <item>
          <guid>https://status.together.ai/incident/999#hash2</guid>
          <title>GPT OSS 120B went down</title>
          <pubDate>Sun, 01 Mar 2026 10:00:00 GMT</pubDate>
          <description>Model unavailable</description>
        </item>
      `
      const fixedNow = new Date('2026-04-30T00:00:00Z').getTime()
      const result = parseRssIncidents(xml, fixedNow)
      expect(result).toHaveLength(1)
      expect(result[0].title).toContain('GPT OSS 120B')
    })

    it('does not falsely match titles that mention "maintenance" without "scheduled"', () => {
      // "Maintenance mode" alone is ambiguous — could be an unexpected degraded
      // state. Only the scheduled+maintenance pair should trigger the skip.
      const xml = `
        <item>
          <guid>https://status.example.com/m2#h</guid>
          <title>Stuck in maintenance mode</title>
          <pubDate>Sat, 01 Mar 2026 10:00:00 GMT</pubDate>
          <description>Deploy pipeline hung.</description>
        </item>
      `
      const fixedNow = new Date('2026-03-15T00:00:00Z').getTime()
      expect(parseRssIncidents(xml, fixedNow)).toHaveLength(1)
    })

    it('defaults `now` to Date.now() when omitted (backwards-compatible signature)', () => {
      // Existing callers pass no arg. Verify the default path still works without
      // regressing to some pathological constant.
      const recentPast = new Date(Date.now() - 3600_000).toUTCString()  // 1h ago
      const xml = `
        <item>
          <guid>https://status.example.com/now#1</guid>
          <title>Service went down</title>
          <pubDate>${recentPast}</pubDate>
          <description>Errors</description>
        </item>
      `
      expect(parseRssIncidents(xml)).toHaveLength(1)
    })

    it('matches the second regex alternation: "Maintenance — scheduled for tonight"', () => {
      // The regex has two alternations; the first matches "scheduled ... maintenance",
      // the second matches "maintenance ... scheduled". Together's current title
      // exercises branch 1. A future provider might use branch 2. Without this test
      // a regex refactor could silently delete that branch.
      const xml = `
        <item>
          <guid>https://status.example.com/m2branch#h</guid>
          <title>Maintenance — scheduled for tonight</title>
          <pubDate>Sat, 01 Mar 2026 10:00:00 GMT</pubDate>
          <description>Planned work</description>
        </item>
      `
      const fixedNow = new Date('2026-03-15T00:00:00Z').getTime()
      expect(parseRssIncidents(xml, fixedNow)).toHaveLength(0)
    })

    it('does NOT skip "Planned maintenance" or "Scheduled upgrade" variants', () => {
      // Explicit negative contract: the regex is narrowly scoped to the
      // scheduled + maintenance pair. Titles like "Planned maintenance window
      // failed" or "Scheduled upgrade broke DB" describe real incidents where
      // the planned event went wrong — we must still surface them. Prevents
      // future over-broadening from swallowing legitimate reports.
      const xml = `
        <item>
          <guid>https://status.example.com/planned#1</guid>
          <title>Planned maintenance window exceeded</title>
          <pubDate>Sat, 01 Mar 2026 10:00:00 GMT</pubDate>
          <description>Still ongoing past the planned end</description>
        </item>
        <item>
          <guid>https://status.example.com/upgrade#1</guid>
          <title>Scheduled upgrade failed to roll forward</title>
          <pubDate>Sat, 01 Mar 2026 11:00:00 GMT</pubDate>
          <description>Rollback initiated</description>
        </item>
      `
      const fixedNow = new Date('2026-03-15T00:00:00Z').getTime()
      const result = parseRssIncidents(xml, fixedNow)
      expect(result).toHaveLength(2)
      // Also assert which incidents survived — a future bug that returned 2
      // different items would slip past the count-only check.
      const titles = result.map(r => r.title)
      expect(titles.some(t => t.includes('Planned maintenance window exceeded'))).toBe(true)
      expect(titles.some(t => t.includes('Scheduled upgrade failed to roll forward'))).toBe(true)
    })

    it('title filter fires before the future-date filter (order-of-checks guard)', () => {
      // Real Together case: title matches AND pubDate is in the future. Current
      // order is title first; if a refactor flipped the order it would still
      // function (same net result) but logs would mis-categorize. Spy on
      // console.debug to confirm the specific skip-reason path.
      // NOTE: test is coupled to the literal log strings "scheduled maintenance"
      // and "future-dated" in parseRssIncidents. Update both sides together if
      // the log wording changes.
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
      const xml = `
        <item>
          <guid>https://status.together.ai/incident/876784#hash</guid>
          <title>Scheduled Network Maintenance</title>
          <pubDate>Sat, 25 Apr 2026 12:00:01 GMT</pubDate>
          <description>Planned</description>
        </item>
      `
      const fixedNow = new Date('2026-04-24T00:00:00Z').getTime()  // before pubDate
      parseRssIncidents(xml, fixedNow)
      const calls = debugSpy.mock.calls.map(c => String(c[0]))
      expect(calls.some(m => m.includes('scheduled maintenance'))).toBe(true)
      expect(calls.some(m => m.includes('future-dated'))).toBe(false)
      debugSpy.mockRestore()
    })
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

  it('returns degraded for "degraded" without resource data', () => {
    expect(parseBetterStackStatus({ data: { attributes: { aggregate_state: 'degraded' } } })).toBe('degraded')
  })

  it('returns operational for "maintenance" without resource data (planned, no real impact)', () => {
    // #349 — pure maintenance with no resource breakdown should not surface as degraded.
    expect(parseBetterStackStatus({ data: { attributes: { aggregate_state: 'maintenance' } } })).toBe('operational')
  })

  it('returns operational for "maintenance" when all non-op resources are also maintenance (#349)', () => {
    // Live Together AI scenario on 2026-04-26: 11/31 resources in `maintenance` state,
    // 0 in `degraded`/`downtime`. Was misclassified as degraded; should be operational.
    const resources = Array.from({ length: 31 }, () => ({
      type: 'status_page_resource', attributes: { status: 'operational' },
    }))
    for (let i = 0; i < 11; i++) resources[i] = { type: 'status_page_resource', attributes: { status: 'maintenance' } }
    expect(parseBetterStackStatus({
      data: { attributes: { aggregate_state: 'maintenance' } },
      included: resources,
    })).toBe('operational')
  })

  it('returns operational for "maintenance" when real issues are below 30% of the non-maintenance fleet', () => {
    // 8 maintenance + 1 downtime + 11 operational = 20 resources.
    // Threshold against non-maintenance peers: realIssues / (20 - 8) = 1/12 = 8.3% < 30%
    // → individual model blip during maintenance, parser stays operational so users don't
    // see a false-positive amber tile.
    const resources: Array<{ type: string; attributes: { status: string } }> = []
    for (let i = 0; i < 8; i++) resources.push({ type: 'status_page_resource', attributes: { status: 'maintenance' } })
    resources.push({ type: 'status_page_resource', attributes: { status: 'downtime' } })
    for (let i = 0; i < 11; i++) resources.push({ type: 'status_page_resource', attributes: { status: 'operational' } })
    expect(parseBetterStackStatus({
      data: { attributes: { aggregate_state: 'maintenance' } },
      included: resources,
    })).toBe('operational')
  })

  it('returns degraded for "maintenance" when ≥30% of NON-maintenance resources are real issues', () => {
    // Maintenance announcement coexisting with widespread real outage. The threshold is
    // applied against non-maintenance peers only — counting against the full fleet would
    // let widespread maintenance dilute the signal of a coexisting real outage.
    // 4 downtime / (10 - 0 maintenance) = 40% → escalate.
    const resources = Array.from({ length: 10 }, () => ({
      type: 'status_page_resource', attributes: { status: 'maintenance' as string },
    }))
    for (let i = 0; i < 4; i++) resources[i] = { type: 'status_page_resource', attributes: { status: 'downtime' } }
    expect(parseBetterStackStatus({
      data: { attributes: { aggregate_state: 'maintenance' } },
      included: resources,
    })).toBe('degraded')
  })

  it('returns degraded when real issues are ≥30% of non-maintenance peers despite being a small fraction overall', () => {
    // Worst-case scenario flagged by review: 25/31 in maintenance, 5/31 in downtime, 1 operational.
    // Naive ratio 5/31 = 16% would underflag the genuine 5-resource outage. Correct ratio uses
    // the non-maintenance denominator: 5/(31-25) = 5/6 = 83% → escalate.
    const resources = Array.from({ length: 31 }, () => ({
      type: 'status_page_resource', attributes: { status: 'maintenance' as string },
    }))
    for (let i = 0; i < 5; i++) resources[i] = { type: 'status_page_resource', attributes: { status: 'downtime' } }
    resources[5] = { type: 'status_page_resource', attributes: { status: 'operational' } }
    expect(parseBetterStackStatus({
      data: { attributes: { aggregate_state: 'maintenance' } },
      included: resources,
    })).toBe('degraded')
  })

  it('returns operational for "degraded" when <30% of resources are non-operational (#162)', () => {
    // Together AI scenario: 7 out of 28 models down (25%) → below 30% threshold
    const resources = Array.from({ length: 28 }, () => ({
      type: 'status_page_resource', attributes: { status: 'operational' },
    }))
    for (let i = 0; i < 7; i++) resources[i] = { type: 'status_page_resource', attributes: { status: 'downtime' } }
    expect(parseBetterStackStatus({
      data: { attributes: { aggregate_state: 'degraded' } },
      included: resources,
    })).toBe('operational')
  })

  it('returns degraded for "degraded" when ≥30% of resources are non-operational', () => {
    // 4 out of 10 down = 40% → genuinely degraded
    const resources = Array.from({ length: 10 }, () => ({
      type: 'status_page_resource', attributes: { status: 'operational' },
    }))
    for (let i = 0; i < 4; i++) resources[i] = { type: 'status_page_resource', attributes: { status: 'downtime' } }
    expect(parseBetterStackStatus({
      data: { attributes: { aggregate_state: 'degraded' } },
      included: resources,
    })).toBe('degraded')
  })

  it('returns operational for "downtime" when <30% of resources are non-operational (#162)', () => {
    // 5 out of 20 down = 25% → below 30% threshold
    const resources = Array.from({ length: 20 }, () => ({
      type: 'status_page_resource', attributes: { status: 'operational' },
    }))
    for (let i = 0; i < 5; i++) resources[i] = { type: 'status_page_resource', attributes: { status: 'downtime' } }
    expect(parseBetterStackStatus({
      data: { attributes: { aggregate_state: 'downtime' } },
      included: resources,
    })).toBe('operational')
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

describe('parseBetterStackPartialCount (#447)', () => {
  const resource = (status: string) => ({ type: 'status_page_resource', attributes: { status } })

  it('counts degraded + downtime resources', () => {
    expect(parseBetterStackPartialCount({
      included: [resource('downtime'), resource('degraded'), resource('downtime'), resource('operational')],
    })).toBe(3)
  })

  it('returns 0 when all resources are operational', () => {
    expect(parseBetterStackPartialCount({
      included: [resource('operational'), resource('operational')],
    })).toBe(0)
  })

  it('excludes maintenance resources (planned, not an outage)', () => {
    expect(parseBetterStackPartialCount({
      included: [resource('maintenance'), resource('maintenance'), resource('downtime')],
    })).toBe(1)
  })

  it('ignores non status_page_resource entries', () => {
    expect(parseBetterStackPartialCount({
      included: [
        { type: 'status_report', attributes: { status: 'downtime' } },
        resource('downtime'),
      ],
    })).toBe(1)
  })

  it('returns 0 for missing / empty included', () => {
    expect(parseBetterStackPartialCount({})).toBe(0)
    expect(parseBetterStackPartialCount({ included: [] })).toBe(0)
  })

  it('reflects the partial-outage gap: status operational (<30%) yet partialCount > 0', () => {
    // 2 downtime out of 10 → parseBetterStackStatus collapses to operational, but the
    // 2 affected resources are still surfaced via partialCount (the #447 perception gap).
    const included = [
      ...Array.from({ length: 8 }, () => resource('operational')),
      resource('downtime'),
      resource('downtime'),
    ]
    const data = { data: { attributes: { aggregate_state: 'downtime' } }, included }
    expect(parseBetterStackStatus(data)).toBe('operational')  // <30% threshold
    expect(parseBetterStackPartialCount(data)).toBe(2)        // but 2 are affected
  })
})
