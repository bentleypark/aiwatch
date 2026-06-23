import { describe, it, expect } from 'vitest'
import { parseAwsRssIncidents, parseAwsHealthEvents, parseAwsRegionHealth, decodeAwsHealthJson, awsHealthImpact, deriveAwsStatus } from '../aws'

/** Encode a string to an ArrayBuffer in the given encoding with a BOM, to exercise decodeAwsHealthJson
 *  the way the live AWS endpoint serves it (utf-16 + BOM). */
function toBuf(str: string, enc: 'utf-16le' | 'utf-16be' | 'utf-8'): ArrayBuffer {
  if (enc === 'utf-8') return Uint8Array.from(new TextEncoder().encode(str)).buffer
  const bom = enc === 'utf-16le' ? [0xFF, 0xFE] : [0xFE, 0xFF]
  const bytes: number[] = [...bom]
  for (const ch of str) {
    const code = ch.charCodeAt(0)
    if (enc === 'utf-16le') bytes.push(code & 0xFF, code >> 8)
    else bytes.push(code >> 8, code & 0xFF)
  }
  return new Uint8Array(bytes).buffer
}

// Real shape from health.aws.amazon.com/public/events (verified live, #677). The 2026-06 Bedrock
// "Fable 5 and Mythos 5 Access" incident: startTime/endTime are epoch-ms, EVENT_LOG timestamps sec.
const BEDROCK_EVENT = {
  service: 'BEDROCK',
  region: 'us-east-1',
  typeCode: 'AWS_BEDROCK_OPERATIONAL_ISSUE',
  startTime: 1781314018000, // 2026-06-13T01:26:58Z
  endTime: 1781547203000,   // 2026-06-15T18:13:23Z → 64h47m (3887 min)
  lastUpdatedTime: 1781547203532,
  metadata: {
    EVENT_LOG: JSON.stringify([
      { summary: 'Fable 5 and Mythos 5 Access', message: 'Anthropic has asked us to revoke access to <a href="x">Claude Fable 5</a>.', status: 1, timestamp: 1781314018 },
      { summary: '[RESOLVED] Fable 5 and Mythos 5 Access', message: 'Models remain unavailable. Resolving this Health event.', status: 1, timestamp: 1781547203 },
    ]),
  },
}

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
    expect(result[0].duration).toBe('1m') // same start/end
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

describe('decodeAwsHealthJson (#677 — utf-16 BOM decode; the live-bug path)', () => {
  // The live bug: the Worker's response charset was unreliable, so a content-type-based decode read
  // utf-16 bytes as utf-8 → garbage → JSON.parse threw. Detecting the BOM bytes is the fix.
  it('decodes utf-16LE (BOM FF FE) — the real AWS endpoint shape', () => {
    const buf = toBuf('[{"service":"BEDROCK","startTime":1781314018000}]', 'utf-16le')
    expect(decodeAwsHealthJson(buf, 'application/json;charset=utf-16')).toEqual([{ service: 'BEDROCK', startTime: 1781314018000 }])
  })

  it('decodes utf-16BE (BOM FE FF)', () => {
    const buf = toBuf('[{"x":1}]', 'utf-16be')
    expect(decodeAwsHealthJson(buf, null)).toEqual([{ x: 1 }])
  })

  it('decodes plain utf-8 (no BOM)', () => {
    const buf = toBuf('{"ok":true}', 'utf-8')
    expect(decodeAwsHealthJson(buf, 'application/json')).toEqual({ ok: true })
  })

  it('falls back to utf-16le when content-type says utf-16 but bytes lack a BOM', () => {
    // build utf-16le bytes WITHOUT the BOM prefix
    const s = '[1,2]'
    const bytes: number[] = []
    for (const ch of s) { const c = ch.charCodeAt(0); bytes.push(c & 0xFF, c >> 8) }
    expect(decodeAwsHealthJson(new Uint8Array(bytes).buffer, 'text/json; charset=UTF-16')).toEqual([1, 2])
  })

  it('THROWS on an undecodable/unparseable body (caller treats it as a fetch failure)', () => {
    const garbage = new Uint8Array([0xFF, 0xFE, 0x01, 0x00, 0x02, 0x00]).buffer // utf-16le BOM + non-JSON
    expect(() => decodeAwsHealthJson(garbage, 'application/json;charset=utf-16')).toThrow()
  })
})

describe('awsHealthImpact (#677)', () => {
  it('maps an operational issue to major (service-impacting, conservative non-down)', () => {
    expect(awsHealthImpact('AWS_BEDROCK_OPERATIONAL_ISSUE')).toBe('major')
  })
  it('maps informational/notification to minor', () => {
    expect(awsHealthImpact('AWS_BEDROCK_INFORMATIONAL_NOTIFICATION')).toBe('minor')
  })
  it('returns null for an unrecognized typeCode', () => {
    expect(awsHealthImpact('AWS_SOMETHING_ELSE')).toBeNull()
  })

  // #707 — text-aware down-classification: a non-reliability advisory (compliance / access revocation /
  // deprecation) carries the SAME generic OPERATIONAL_ISSUE typeCode as a real outage; only the
  // EVENT_LOG text distinguishes them. The real "Fable 5 and Mythos 5 Access" event motivated this.
  it('#707: down-classifies a compliance / access-revocation advisory (no outage signal) to null', () => {
    const text =
      'To support compliance with the US Government export control directive, Anthropic has asked us to ' +
      'revoke access to Claude Fable 5 and Claude Mythos 5. All other models are not affected.'
    expect(awsHealthImpact('AWS_BEDROCK_OPERATIONAL_ISSUE', text)).toBeNull()
  })
  it('#707: a deprecation/retirement advisory is also null', () => {
    expect(awsHealthImpact('AWS_BEDROCK_OPERATIONAL_ISSUE', 'This model version is being deprecated and will be retired.')).toBeNull()
  })
  it('#707: keeps a genuine operational issue as major when an outage signal is present (outage wins)', () => {
    // advisory word ("compliance") co-occurs with an outage signal → NOT down-classified
    expect(awsHealthImpact('AWS_BEDROCK_OPERATIONAL_ISSUE', 'Elevated error rates invoking models; a compliance review is ongoing.')).toBe('major')
  })
  it('#707: an operational issue with no EVENT_LOG text stays major (typeCode fallback + 1-arg back-compat)', () => {
    expect(awsHealthImpact('AWS_BEDROCK_OPERATIONAL_ISSUE', '')).toBe('major')
    expect(awsHealthImpact('AWS_BEDROCK_OPERATIONAL_ISSUE')).toBe('major')
  })
})

describe('parseAwsHealthEvents (#677 — AWS Health public events JSON)', () => {
  it('derives the TRUE duration of a resolved event from startTime/endTime (no 1m floor)', () => {
    const [inc] = parseAwsHealthEvents([BEDROCK_EVENT], 'BEDROCK')
    expect(inc.status).toBe('resolved')
    expect(inc.startedAt).toBe('2026-06-13T01:26:58.000Z')
    expect(inc.resolvedAt).toBe('2026-06-15T18:13:23.000Z')
    expect(inc.duration).toBe('64h 47m') // the real span — was '1m' under the RSS parser
    expect(inc.impact).toBeNull() // #707 — compliance/access-revocation advisory ("revoke access"), NOT a reliability outage
    expect(inc.title).toBe('Fable 5 and Mythos 5 Access') // first EVENT_LOG summary
  })

  it('produces ONE record per incident (no active/resolved double-count)', () => {
    // The whole #677 win: the RSS split this into 2 records (phantom-ongoing + 1m-resolved).
    expect(parseAwsHealthEvents([BEDROCK_EVENT], 'BEDROCK')).toHaveLength(1)
  })

  it('uses a stable id from service + region + startTime', () => {
    const [inc] = parseAwsHealthEvents([BEDROCK_EVENT], 'BEDROCK')
    expect(inc.id).toBe('aws:bedrock:us-east-1:1781314018000')
    expect(inc.componentNames).toEqual(['us-east-1'])
  })

  it('builds a timeline from EVENT_LOG (seconds→ISO, HTML stripped, [RESOLVED] stage)', () => {
    const [inc] = parseAwsHealthEvents([BEDROCK_EVENT], 'BEDROCK')
    expect(inc.timeline).toHaveLength(2)
    expect(inc.timeline[0].at).toBe('2026-06-13T01:26:58.000Z')
    expect(inc.timeline[0].text).toBe('Anthropic has asked us to revoke access to Claude Fable 5.') // <a> stripped
    // The onset entry must NOT inherit the overall 'resolved' status — only the [RESOLVED] entry resolves.
    expect(inc.timeline[0].stage).toBe('investigating')
    expect(inc.timeline[1].stage).toBe('resolved') // summary has [RESOLVED]
  })

  it('#707: a Health event with outage text classifies as major through the parse (control case)', () => {
    // Same generic typeCode, but the EVENT_LOG describes a real fault → stays major (not down-classified).
    const outage = {
      ...BEDROCK_EVENT,
      metadata: { EVENT_LOG: JSON.stringify([
        { summary: 'Increased error rates', message: 'Elevated error rates invoking Bedrock models in us-east-1.', timestamp: 1781314018 },
      ]) },
    }
    const [inc] = parseAwsHealthEvents([outage], 'BEDROCK')
    expect(inc.impact).toBe('major')
  })

  it('treats an event without endTime as active (resolvedAt null, no duration)', () => {
    const active = { ...BEDROCK_EVENT, endTime: null }
    const [inc] = parseAwsHealthEvents([active], 'BEDROCK')
    expect(inc.status).toBe('investigating')
    expect(inc.resolvedAt).toBeNull()
    expect(inc.duration).toBeNull()
  })

  it('filters to the requested service only', () => {
    const events = [BEDROCK_EVENT, { ...BEDROCK_EVENT, service: 'EC2', region: 'us-west-2' }]
    const out = parseAwsHealthEvents(events, 'BEDROCK')
    expect(out).toHaveLength(1)
    expect(out[0].componentNames).toEqual(['us-east-1'])
  })

  it('returns [] for non-array / malformed input', () => {
    expect(parseAwsHealthEvents(null, 'BEDROCK')).toEqual([])
    expect(parseAwsHealthEvents({}, 'BEDROCK')).toEqual([])
    expect(parseAwsHealthEvents('nope', 'BEDROCK')).toEqual([])
  })

  it('skips an event with no startTime', () => {
    expect(parseAwsHealthEvents([{ service: 'BEDROCK', region: 'us-east-1' }], 'BEDROCK')).toEqual([])
  })

  it('tolerates a malformed EVENT_LOG (falls back to a single timeline entry)', () => {
    const ev = { ...BEDROCK_EVENT, metadata: { EVENT_LOG: 'not json' } }
    const [inc] = parseAwsHealthEvents([ev], 'BEDROCK')
    expect(inc.timeline).toHaveLength(1)
    expect(inc.title).toBe('AWS_BEDROCK_OPERATIONAL_ISSUE') // fell back to typeCode (no EVENT_LOG summary)
  })

  it('caps at 20 incidents', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ ...BEDROCK_EVENT, startTime: 1781314018000 + i * 1000 }))
    expect(parseAwsHealthEvents(many, 'BEDROCK')).toHaveLength(20)
  })
})

// #574 — currently-degraded AWS regions from the public-events JSON (all AWS services), for the
// supply-chain banner. Reuses awsHealthImpact (so a #707 non-reliability advisory → excluded).
describe('parseAwsRegionHealth (#574)', () => {
  const ev = (o: Record<string, unknown>) => ({
    service: 'EC2', region: 'us-east-1', typeCode: 'AWS_EC2_OPERATIONAL_ISSUE', startTime: 1781314018000,
    metadata: { EVENT_LOG: JSON.stringify([{ summary: 'Increased API error rates in us-east-1', message: 'investigating', timestamp: 1781314018 }]) },
    ...o,
  })

  it('maps an ACTIVE operational issue to a degraded region (+summary)', () => {
    expect(parseAwsRegionHealth([ev({})])).toEqual({ 'us-east-1': { level: 'degraded', summary: 'Increased API error rates in us-east-1' } })
  })

  it('excludes RESOLVED events (endTime set)', () => {
    expect(parseAwsRegionHealth([ev({ endTime: 1781317618000 })])).toEqual({})
  })

  it('excludes a non-reliability advisory (#707 — impact null) and unknown/missing regions', () => {
    const advisory = ev({ region: 'eu-west-1', metadata: { EVENT_LOG: JSON.stringify([{ summary: 'Scheduled deprecation: access will be revoked for compliance', message: 'export-control policy update' }]) } })
    expect(parseAwsRegionHealth([advisory])).toEqual({})
    expect(parseAwsRegionHealth([ev({ region: undefined })])).toEqual({})
  })

  it('aggregates multiple events per region (worst-of) across DIFFERENT AWS services', () => {
    const out = parseAwsRegionHealth([ev({ service: 'EC2' }), ev({ service: 'S3' }), ev({ region: 'us-west-2', service: 'LAMBDA' })])
    expect(Object.keys(out).sort()).toEqual(['us-east-1', 'us-west-2'])
    expect(out['us-east-1'].level).toBe('degraded')
  })

  it('EXCLUDES BEDROCK events (an AI service we track separately — avoids the circular #574 signal)', () => {
    const bedrockEv = ev({ service: 'BEDROCK', region: 'us-east-1' })
    expect(parseAwsRegionHealth([bedrockEv])).toEqual({}) // bedrock-only → no infra region signal
    // but a real INFRA event in the same feed still registers
    expect(Object.keys(parseAwsRegionHealth([bedrockEv, ev({ service: 'EC2', region: 'us-east-1' })]))).toEqual(['us-east-1'])
  })

  it('returns {} for non-array / empty input', () => {
    expect(parseAwsRegionHealth(null)).toEqual({})
    expect(parseAwsRegionHealth([])).toEqual({})
  })
})
