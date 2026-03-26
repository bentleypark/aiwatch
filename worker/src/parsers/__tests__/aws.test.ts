import { describe, it, expect } from 'vitest'
import { parseAwsRssIncidents, deriveAwsStatus } from '../aws'

describe('parseAwsRssIncidents', () => {
  it('returns empty for RSS with no items (operational)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>Amazon Bedrock (N. Virginia) Service Status</title>
          <link>http://status.aws.amazon.com/</link>
          <description>Service is operating normally</description>
        </channel>
      </rss>`
    expect(parseAwsRssIncidents(xml)).toEqual([])
  })

  it('returns empty for empty string', () => {
    expect(parseAwsRssIncidents('')).toEqual([])
  })

  it('parses active incident from RSS item', () => {
    const xml = `
      <item>
        <title>Increased API Error Rates</title>
        <guid>arn:aws:health:us-east-1::event/BEDROCK/issue/abc123</guid>
        <pubDate>Mon, 24 Mar 2026 14:00:00 GMT</pubDate>
        <description>We are investigating increased error rates for Amazon Bedrock in the US-EAST-1 Region.</description>
      </item>`
    const result = parseAwsRssIncidents(xml)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('arn:aws:health:us-east-1::event/BEDROCK/issue/abc123')
    expect(result[0].title).toBe('Increased API Error Rates')
    expect(result[0].status).toBe('investigating')
    expect(result[0].impact).toBe('major')
    expect(result[0].duration).toBeNull()
    expect(result[0].resolvedAt).toBeNull() // ongoing
    expect(result[0].startedAt).toBe('2026-03-24T14:00:00.000Z')
    expect(result[0].timeline).toHaveLength(1)
    expect(result[0].timeline[0].stage).toBe('investigating')
    expect(result[0].timeline[0].text).toContain('investigating increased error rates')
  })

  it('parses resolved incident', () => {
    const xml = `
      <item>
        <title>[RESOLVED] Increased API Error Rates</title>
        <guid>arn:aws:health:us-east-1::event/BEDROCK/issue/abc123</guid>
        <pubDate>Mon, 24 Mar 2026 16:00:00 GMT</pubDate>
        <description>The issue has been resolved.</description>
      </item>`
    const result = parseAwsRssIncidents(xml)
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('resolved')
    expect(result[0].resolvedAt).toBe(result[0].startedAt) // AWS RSS: single timestamp
    expect(result[0].duration).toBe('<1m') // same start/end
  })

  it('classifies disruption/outage as critical impact', () => {
    const xml = `
      <item>
        <title>Service disruption for Amazon Bedrock</title>
        <guid>arn:aws:health:us-east-1::event/BEDROCK/issue/xyz789</guid>
        <pubDate>Mon, 24 Mar 2026 10:00:00 GMT</pubDate>
        <description>We are investigating a service disruption.</description>
      </item>`
    const result = parseAwsRssIncidents(xml)
    expect(result).toHaveLength(1)
    expect(result[0].impact).toBe('critical')
  })

  it('classifies informational as minor impact', () => {
    const xml = `
      <item>
        <title>Informational message: Scheduled maintenance</title>
        <guid>arn:aws:health:us-east-1::event/BEDROCK/issue/maint1</guid>
        <pubDate>Mon, 24 Mar 2026 08:00:00 GMT</pubDate>
        <description>Scheduled maintenance window.</description>
      </item>`
    const result = parseAwsRssIncidents(xml)
    expect(result).toHaveLength(1)
    expect(result[0].impact).toBe('minor')
  })

  it('parses monitoring status', () => {
    const xml = `
      <item>
        <title>[MONITORING] Elevated error rates for Amazon Bedrock</title>
        <guid>arn:aws:health:us-east-1::event/BEDROCK/issue/mon1</guid>
        <pubDate>Mon, 24 Mar 2026 12:00:00 GMT</pubDate>
        <description>We are monitoring the situation.</description>
      </item>`
    const result = parseAwsRssIncidents(xml)
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('monitoring')
  })

  it('parses identified status', () => {
    const xml = `
      <item>
        <title>[IDENTIFIED] Degraded performance for Amazon Bedrock</title>
        <guid>arn:aws:health:us-east-1::event/BEDROCK/issue/id1</guid>
        <pubDate>Mon, 24 Mar 2026 11:00:00 GMT</pubDate>
        <description>We have identified the root cause.</description>
      </item>`
    const result = parseAwsRssIncidents(xml)
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('identified')
    expect(result[0].impact).toBe('major')
  })

  it('handles multiple incidents', () => {
    const xml = `
      <item>
        <title>Increased API Error Rates</title>
        <guid>arn:aws:health:us-east-1::event/BEDROCK/issue/1</guid>
        <pubDate>Mon, 24 Mar 2026 14:00:00 GMT</pubDate>
        <description>Investigating.</description>
      </item>
      <item>
        <title>[RESOLVED] Service disruption</title>
        <guid>arn:aws:health:us-east-1::event/BEDROCK/issue/2</guid>
        <pubDate>Mon, 24 Mar 2026 10:00:00 GMT</pubDate>
        <description>Resolved.</description>
      </item>`
    const result = parseAwsRssIncidents(xml)
    expect(result).toHaveLength(2)
    expect(result[0].status).toBe('investigating')
    expect(result[1].status).toBe('resolved')
  })

  it('skips items with invalid dates', () => {
    const xml = `
      <item>
        <title>Some issue</title>
        <guid>test-guid</guid>
        <pubDate>not-a-date</pubDate>
        <description>Bad date.</description>
      </item>`
    expect(parseAwsRssIncidents(xml)).toEqual([])
  })

  it('generates fallback ID when guid is missing', () => {
    const xml = `
      <item>
        <title>Some issue</title>
        <pubDate>Mon, 24 Mar 2026 14:00:00 GMT</pubDate>
        <description>No guid here.</description>
      </item>`
    const result = parseAwsRssIncidents(xml)
    expect(result).toHaveLength(1)
    expect(result[0].id).toMatch(/^aws-\d+$/)
  })

  it('limits to 20 incidents', () => {
    const items = Array.from({ length: 25 }, (_, i) => `
      <item>
        <title>Issue ${i}</title>
        <guid>aws-guid-${i}</guid>
        <pubDate>Mon, 24 Mar 2026 ${String(i).padStart(2, '0')}:00:00 GMT</pubDate>
        <description>Desc ${i}</description>
      </item>
    `).join('')
    const result = parseAwsRssIncidents(`<rss>${items}</rss>`)
    expect(result).toHaveLength(20)
  })

  it('decodes XML entities in title and description', () => {
    const xml = `
      <item>
        <title>Error rates &gt; 5% for Bedrock &amp; related services</title>
        <guid>aws-entities</guid>
        <pubDate>Mon, 24 Mar 2026 14:00:00 GMT</pubDate>
        <description>Rates &gt; threshold &amp; rising</description>
      </item>`
    const result = parseAwsRssIncidents(xml)
    expect(result[0].title).toBe('Error rates > 5% for Bedrock & related services')
    expect(result[0].timeline[0].text).toBe('Rates > threshold & rising')
  })

  it('handles CDATA-wrapped description', () => {
    const xml = `
      <item>
        <title>API latency issues</title>
        <guid>aws-cdata</guid>
        <pubDate>Mon, 24 Mar 2026 14:00:00 GMT</pubDate>
        <description><![CDATA[Multi-line
description with <b>HTML</b> tags]]></description>
      </item>`
    const result = parseAwsRssIncidents(xml)
    expect(result).toHaveLength(1)
    expect(result[0].timeline[0].text).toBe('Multi-line\ndescription with HTML tags')
  })

  it('returns null impact for unrecognized title keywords', () => {
    const xml = `
      <item>
        <title>API latency issues for Amazon Bedrock</title>
        <guid>aws-null-impact</guid>
        <pubDate>Mon, 24 Mar 2026 14:00:00 GMT</pubDate>
        <description>We are investigating latency issues.</description>
      </item>`
    const result = parseAwsRssIncidents(xml)
    expect(result).toHaveLength(1)
    expect(result[0].impact).toBeNull()
  })

  it('handles partial/malformed XML gracefully', () => {
    expect(parseAwsRssIncidents('<rss><channel>')).toEqual([])
    expect(parseAwsRssIncidents('<item><title>No closing')).toEqual([])
    expect(parseAwsRssIncidents('not xml at all')).toEqual([])
  })

  it('strips HTML tags from description', () => {
    const xml = `
      <item>
        <title>Issue</title>
        <guid>aws-html</guid>
        <pubDate>Mon, 24 Mar 2026 14:00:00 GMT</pubDate>
        <description>Error in &lt;b&gt;us-east-1&lt;/b&gt; region. See &lt;a href="https://aws.amazon.com"&gt;details&lt;/a&gt;.</description>
      </item>`
    const result = parseAwsRssIncidents(xml)
    expect(result[0].timeline[0].text).toBe('Error in us-east-1 region. See details.')
  })

  it('uses title as timeline text when description is empty', () => {
    const xml = `
      <item>
        <title>Service disruption</title>
        <guid>aws-no-desc</guid>
        <pubDate>Mon, 24 Mar 2026 14:00:00 GMT</pubDate>
        <description></description>
      </item>`
    const result = parseAwsRssIncidents(xml)
    expect(result[0].timeline[0].text).toBe('Service disruption')
  })
})

describe('deriveAwsStatus — multi-region scenarios', () => {
  it('returns operational when incidents from multiple regions are all resolved', () => {
    const incidents = [
      { id: 'r1', title: '[RESOLVED] Issue', status: 'resolved' as const, impact: 'major' as const, componentNames: ['us-east-1'], startedAt: '2026-03-24T14:00:00Z', duration: '1h 0m', timeline: [] },
      { id: 'r2', title: '[RESOLVED] Issue', status: 'resolved' as const, impact: 'critical' as const, componentNames: ['eu-west-1'], startedAt: '2026-03-24T12:00:00Z', duration: '2h 0m', timeline: [] },
    ]
    expect(deriveAwsStatus(incidents)).toBe('operational')
  })

  it('returns down when any region has critical active incident', () => {
    const incidents = [
      { id: 'r1', title: 'Minor issue', status: 'investigating' as const, impact: 'minor' as const, componentNames: ['us-east-1'], startedAt: '2026-03-24T14:00:00Z', duration: null, timeline: [] },
      { id: 'r2', title: 'Service outage', status: 'investigating' as const, impact: 'critical' as const, componentNames: ['ap-northeast-1'], startedAt: '2026-03-24T15:00:00Z', duration: null, timeline: [] },
    ]
    expect(deriveAwsStatus(incidents)).toBe('down')
  })

  it('returns degraded when one region has active non-critical, others resolved', () => {
    const incidents = [
      { id: 'r1', title: 'Elevated errors', status: 'monitoring' as const, impact: 'major' as const, componentNames: ['us-west-2'], startedAt: '2026-03-24T14:00:00Z', duration: null, timeline: [] },
      { id: 'r2', title: '[RESOLVED] Old issue', status: 'resolved' as const, impact: 'critical' as const, componentNames: ['us-east-1'], startedAt: '2026-03-24T10:00:00Z', duration: '1h 0m', timeline: [] },
    ]
    expect(deriveAwsStatus(incidents)).toBe('degraded')
  })
})

describe('multi-region deduplication', () => {
  it('same incident ID from multiple regions should deduplicate and merge componentNames', () => {
    // Simulates the dedup+merge logic from services.ts
    const region1 = parseAwsRssIncidents(`
      <item>
        <title>Global outage</title>
        <guid>arn:aws:health:global::event/BEDROCK/issue/global1</guid>
        <pubDate>Mon, 24 Mar 2026 14:00:00 GMT</pubDate>
        <description>Global impact.</description>
      </item>`)
    const region2 = parseAwsRssIncidents(`
      <item>
        <title>Global outage</title>
        <guid>arn:aws:health:global::event/BEDROCK/issue/global1</guid>
        <pubDate>Mon, 24 Mar 2026 14:00:00 GMT</pubDate>
        <description>Global impact.</description>
      </item>`)

    region1.forEach(inc => { inc.componentNames = ['us-east-1'] })
    region2.forEach(inc => { inc.componentNames = ['eu-west-1'] })

    // Dedup + merge componentNames (same logic as services.ts)
    const seenMap = new Map<string, typeof region1[0]>()
    const merged: typeof region1 = []
    for (const inc of [...region1, ...region2]) {
      const existing = seenMap.get(inc.id)
      if (existing) {
        const regions = new Set(existing.componentNames ?? [])
        for (const name of inc.componentNames ?? []) regions.add(name)
        existing.componentNames = [...regions]
      } else {
        seenMap.set(inc.id, inc)
        merged.push(inc)
      }
    }

    expect(merged).toHaveLength(1)
    expect(merged[0].componentNames).toEqual(['us-east-1', 'eu-west-1'])
  })

  it('different incidents from different regions are kept', () => {
    const region1 = parseAwsRssIncidents(`
      <item>
        <title>Increased errors</title>
        <guid>arn:aws:health:us-east-1::event/BEDROCK/issue/inc1</guid>
        <pubDate>Mon, 24 Mar 2026 14:00:00 GMT</pubDate>
        <description>US East issue.</description>
      </item>`)
    const region2 = parseAwsRssIncidents(`
      <item>
        <title>Elevated latency</title>
        <guid>arn:aws:health:eu-west-1::event/BEDROCK/issue/inc2</guid>
        <pubDate>Mon, 24 Mar 2026 15:00:00 GMT</pubDate>
        <description>EU West issue.</description>
      </item>`)

    region1.forEach(inc => { inc.componentNames = ['us-east-1'] })
    region2.forEach(inc => { inc.componentNames = ['eu-west-1'] })

    const seen = new Set<string>()
    const merged = [...region1, ...region2].filter(inc => {
      if (seen.has(inc.id)) return false
      seen.add(inc.id)
      return true
    })

    expect(merged).toHaveLength(2)
    expect(merged[0].componentNames).toEqual(['us-east-1'])
    expect(merged[1].componentNames).toEqual(['eu-west-1'])
  })
})

describe('deriveAwsStatus', () => {
  it('returns operational when no incidents', () => {
    expect(deriveAwsStatus([])).toBe('operational')
  })

  it('returns operational when all incidents are resolved', () => {
    const incidents = [
      { id: '1', title: '[RESOLVED] Issue', status: 'resolved' as const, impact: 'critical' as const, startedAt: '2026-03-24T14:00:00Z', duration: '2h 0m', timeline: [] },
    ]
    expect(deriveAwsStatus(incidents)).toBe('operational')
  })

  it('returns down when active incident has critical impact', () => {
    const incidents = [
      { id: '1', title: 'Service disruption', status: 'investigating' as const, impact: 'critical' as const, startedAt: '2026-03-24T14:00:00Z', duration: null, timeline: [] },
    ]
    expect(deriveAwsStatus(incidents)).toBe('down')
  })

  it('returns degraded when active incident has non-critical impact', () => {
    const incidents = [
      { id: '1', title: 'Increased errors', status: 'investigating' as const, impact: 'major' as const, startedAt: '2026-03-24T14:00:00Z', duration: null, timeline: [] },
    ]
    expect(deriveAwsStatus(incidents)).toBe('degraded')
  })

  it('returns degraded when active incident has null impact', () => {
    const incidents = [
      { id: '1', title: 'Some issue', status: 'monitoring' as const, impact: null, startedAt: '2026-03-24T14:00:00Z', duration: null, timeline: [] },
    ]
    expect(deriveAwsStatus(incidents)).toBe('degraded')
  })

  it('returns down if any active incident is critical (mixed)', () => {
    const incidents = [
      { id: '1', title: 'Minor issue', status: 'investigating' as const, impact: 'minor' as const, startedAt: '2026-03-24T14:00:00Z', duration: null, timeline: [] },
      { id: '2', title: 'Service outage', status: 'investigating' as const, impact: 'critical' as const, startedAt: '2026-03-24T15:00:00Z', duration: null, timeline: [] },
      { id: '3', title: '[RESOLVED] Old issue', status: 'resolved' as const, impact: 'critical' as const, startedAt: '2026-03-24T10:00:00Z', duration: '1h 0m', timeline: [] },
    ]
    expect(deriveAwsStatus(incidents)).toBe('down')
  })
})
