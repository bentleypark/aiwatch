import { describe, it, expect } from 'vitest'
import { mapBetterStackImpact, parseRssIncidents, parseXaiRssIncidents } from '../parsers/betterstack'

describe('mapBetterStackImpact (#564)', () => {
  it('maps ONLY explicit broad-outage wording to major', () => {
    expect(mapBetterStackImpact('Partial outage of the API')).toBe('major')
    expect(mapBetterStackImpact('Dashboard unavailable')).toBe('major')
    expect(mapBetterStackImpact('Region offline')).toBe('major')
  })

  it('maps BetterStack generic "went down" monitor flaps to minor (not major) — the #564 calibration', () => {
    // "down" is BetterStack's default phrasing for ANY failed monitor check, not a declared outage,
    // so it must NOT inflate to major (would over-penalize Together/Fireworks's 20/20 "went down").
    expect(mapBetterStackImpact('Whisper Large V3 went down')).toBe('minor')
    expect(mapBetterStackImpact('Web endpoints, Volumes, and 2 other services are down')).toBe('minor')
    expect(mapBetterStackImpact('us-west input plane down')).toBe('minor')
  })

  it('maps degraded / everything else to minor (and never null — that was the bug)', () => {
    expect(mapBetterStackImpact('H200 Scheduling is degraded')).toBe('minor')
    expect(mapBetterStackImpact('Elevated latency on inference')).toBe('minor')
    expect(mapBetterStackImpact('Internal data stores are failing')).toBe('minor')
    expect(mapBetterStackImpact('')).toBe('minor')
  })
})

describe('parseRssIncidents impact mapping (#564)', () => {
  const NOW = Date.parse('2026-06-02T00:00:00Z')
  const item = (title, desc, incId) =>
    `<item><title>${title}</title><link>https://status.modal.com/incident/${incId}</link>` +
    `<pubDate>Mon, 01 Jun 2026 10:00:00 -0000</pubDate>` +
    `<guid>https://status.modal.com/incident/${incId}#a</guid><description>${desc}</description></item>`

  it('maps a "went down" RSS incident to minor (non-null; the #564 calibration — was null before)', () => {
    const xml = `<rss><channel>${item('Web endpoints and Volumes are down', 'Volumes went down.', '1001')}</channel></rss>`
    const incidents = parseRssIncidents(xml, NOW)
    expect(incidents).toHaveLength(1)
    expect(incidents[0].impact).toBe('minor')
  })

  it('maps an explicit "outage" RSS incident to major', () => {
    const xml = `<rss><channel>${item('Major outage across all regions', 'Full service outage', '1005')}</channel></rss>`
    const incidents = parseRssIncidents(xml, NOW)
    expect(incidents[0].impact).toBe('major')
  })

  it('maps a "degraded" RSS incident to minor', () => {
    const xml = `<rss><channel>${item('H200 Scheduling is degraded', 'Investigating elevated latency', '1002')}</channel></rss>`
    const incidents = parseRssIncidents(xml, NOW)
    expect(incidents).toHaveLength(1)
    expect(incidents[0].impact).toBe('minor')
  })

  it('derives severity from the RAW title, not the normalized "— down" display title', () => {
    // The display title is reconstructed as "… — down" for an unresolved incident, but the incident
    // is a *degraded* one — impact must reflect the raw "degraded" wording, not the display word "down".
    const xml = `<rss><channel>${item('Image builds degraded', 'partial degradation', '1003')}</channel></rss>`
    const incidents = parseRssIncidents(xml, NOW)
    expect(incidents[0].title).toContain('— down')   // display title normalizes (unchanged behavior)
    expect(incidents[0].impact).toBe('minor')         // but impact is correctly 'minor'
  })

  it('never emits a null impact for a real incident', () => {
    const xml = `<rss><channel>${item('Internal data stores are failing', 'root cause unknown', '1004')}</channel></rss>`
    expect(parseRssIncidents(xml, NOW)[0].impact).not.toBeNull()
  })

  it('aggregates severity across ALL events in a grouped incident (escalation degraded → outage = major)', () => {
    // Two updates of ONE incident (same /incident/ link). First "degraded", later escalates to "outage".
    // severityText joins all events, so the "outage" wording must win → major (not minor from event 1).
    const ev = (title, desc, date) =>
      `<item><title>${title}</title><link>https://status.modal.com/incident/2001</link>` +
      `<pubDate>${date}</pubDate><guid>https://status.modal.com/incident/2001#${date}</guid>` +
      `<description>${desc}</description></item>`
    const xml = `<rss><channel>` +
      ev('API is degraded', 'investigating elevated errors', 'Mon, 01 Jun 2026 10:00:00 -0000') +
      ev('API recovered', 'full outage resolved', 'Mon, 01 Jun 2026 11:00:00 -0000') +
      `</channel></rss>`
    const incidents = parseRssIncidents(xml, NOW)
    expect(incidents).toHaveLength(1)
    expect(incidents[0].status).toBe('resolved')
    expect(incidents[0].impact).toBe('major') // "outage" in the later event wins over event 1's "degraded"
  })

  it('still drops sub-60s micro-incidents (unchanged by #564)', () => {
    const ev = (title, desc, date) =>
      `<item><title>${title}</title><link>https://status.modal.com/incident/2002</link>` +
      `<pubDate>${date}</pubDate><guid>https://status.modal.com/incident/2002#${date}</guid>` +
      `<description>${desc}</description></item>`
    const xml = `<rss><channel>` +
      ev('Blip went down', 'down', 'Mon, 01 Jun 2026 10:00:00 -0000') +
      ev('Blip recovered', 'recovered', 'Mon, 01 Jun 2026 10:00:30 -0000') + // +30s → micro
      `</channel></rss>`
    expect(parseRssIncidents(xml, NOW)).toHaveLength(0)
  })
})

describe('parseXaiRssIncidents impact mapping (#564)', () => {
  it('maps the xAI incident title to a non-null impact', () => {
    const xml = `<rss><channel><item><title>[API] Elevated error rates</title>` +
      `<guid>xai-1</guid>` +
      `<description><![CDATA[<div><strong>Jun 01, 2026 - 10:00 UTC</strong><h3>Investigating</h3><p>Looking into elevated errors</p></div>]]></description>` +
      `</item></channel></rss>`
    const incidents = parseXaiRssIncidents(xml)
    expect(incidents).toHaveLength(1)
    expect(incidents[0].impact).toBe('minor') // "elevated" → minor; was null before #564
  })

  it('maps an explicit "outage" in the xAI timeline text to major', () => {
    const xml = `<rss><channel><item><title>[API] Service disruption</title>` +
      `<guid>xai-2</guid>` +
      `<description><![CDATA[<div><strong>Jun 01, 2026 - 10:00 UTC</strong><h3>Investigating</h3><p>Complete API outage in us-east</p></div>]]></description>` +
      `</item></channel></rss>`
    expect(parseXaiRssIncidents(xml)[0].impact).toBe('major')
  })

  it('does NOT false-match severity in raw CDATA markup (severity comes from stripped timeline text)', () => {
    // The raw desc contains class="offline-banner" — must NOT make this 'major'; the <p> text is benign.
    const xml = `<rss><channel><item><title>[API] Minor latency</title>` +
      `<guid>xai-3</guid>` +
      `<description><![CDATA[<div class="offline-banner"><strong>Jun 01, 2026 - 10:00 UTC</strong><h3>Investigating</h3><p>Slightly elevated latency</p></div>]]></description>` +
      `</item></channel></rss>`
    expect(parseXaiRssIncidents(xml)[0].impact).toBe('minor') // not major from the "offline" CSS class
  })

  it('skips an xAI maintenance entry (#564 — no upstream maintenance filter on this path)', () => {
    const xml = `<rss><channel><item><title>[API] Scheduled maintenance</title>` +
      `<guid>xai-maint</guid>` +
      `<description><![CDATA[<div><strong>Jun 01, 2026 - 10:00 UTC</strong><h3>Scheduled</h3><p>Planned upgrade window</p></div>]]></description>` +
      `</item></channel></rss>`
    expect(parseXaiRssIncidents(xml)).toHaveLength(0)
  })
})

describe('parseRssIncidents — stale-ongoing guard (#602)', () => {
  const NOW = Date.parse('2026-06-02T00:00:00Z')
  // Single unresolved item (no "recovered/resolved" wording), human-titled like Luma's feed.
  const lone = (title, date, incId) =>
    `<item><title>${title}</title><link>https://status.lumalabs.ai/incident/${incId}</link>` +
    `<pubDate>${date}</pubDate><guid>https://status.lumalabs.ai/incident/${incId}#a</guid>` +
    `<description>${title}</description></item>`

  it('marks a months-old unresolved incident as resolved (Luma ray3 Jan-21 case)', () => {
    // No paired "recovered" + last activity ~4.5 months before NOW → stale → resolved.
    const xml = `<rss><channel>${lone('ray3 service degraded', 'Wed, 21 Jan 2026 14:55:00 -0000', 'r1')}</channel></rss>`
    const incidents = parseRssIncidents(xml, NOW)
    expect(incidents).toHaveLength(1)
    expect(incidents[0].status).toBe('resolved')
    expect(incidents[0].resolvedAt).not.toBeNull()
  })

  it('keeps a recent (<7d) unresolved incident as investigating — a real ongoing outage', () => {
    const xml = `<rss><channel>${lone('Dream Machine is degraded', 'Mon, 01 Jun 2026 10:00:00 -0000', 'r2')}</channel></rss>`
    const incidents = parseRssIncidents(xml, NOW)
    expect(incidents).toHaveLength(1)
    expect(incidents[0].status).toBe('investigating')
    expect(incidents[0].resolvedAt).toBeNull()
  })
})
