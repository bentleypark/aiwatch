import { describe, it, expect, vi } from 'vitest'
import { normalizeStatus, parseIncidents, parseUptimeData } from '../statuspage'

describe('normalizeStatus', () => {
  it('maps none/operational to operational', () => {
    expect(normalizeStatus('none')).toBe('operational')
    expect(normalizeStatus('operational')).toBe('operational')
  })

  it('maps minor/degraded_performance/partial_outage to degraded', () => {
    expect(normalizeStatus('minor')).toBe('degraded')
    expect(normalizeStatus('degraded_performance')).toBe('degraded')
    expect(normalizeStatus('partial_outage')).toBe('degraded')
  })

  it('maps major/critical/major_outage to down', () => {
    expect(normalizeStatus('major')).toBe('down')
    expect(normalizeStatus('critical')).toBe('down')
    expect(normalizeStatus('major_outage')).toBe('down')
  })

  it('defaults unknown to operational', () => {
    expect(normalizeStatus('unknown')).toBe('operational')
  })
})

describe('parseIncidents', () => {
  it('parses incidents from Statuspage response', () => {
    const data = {
      status: { indicator: 'none', description: 'All Systems Operational' },
      incidents: [
        {
          id: 'inc1',
          name: 'API Errors',
          status: 'resolved',
          impact: 'major',
          created_at: '2026-03-01T10:00:00Z',
          resolved_at: '2026-03-01T12:00:00Z',
          incident_updates: [
            { status: 'resolved', body: 'Fixed', created_at: '2026-03-01T12:00:00Z' },
            { status: 'investigating', body: 'Looking into it', created_at: '2026-03-01T10:00:00Z' },
          ],
        },
      ],
    }

    const result = parseIncidents(data)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('inc1')
    expect(result[0].title).toBe('API Errors')
    expect(result[0].status).toBe('resolved')
    expect(result[0].impact).toBe('major')
    expect(result[0].duration).toBe('2h 0m')
    expect(result[0].resolvedAt).toBe('2026-03-01T12:00:00Z')
    expect(result[0].timeline).toHaveLength(2)
    // Timeline reversed to oldest first: investigating → resolved
    expect(result[0].timeline[0].stage).toBe('investigating')
    expect(result[0].timeline[1].stage).toBe('resolved')
  })

  it('returns empty array when no incidents', () => {
    const data = { status: { indicator: 'none', description: '' } }
    expect(parseIncidents(data)).toEqual([])
  })

  it('deduplicates timeline entries by stage+time', () => {
    const data = {
      status: { indicator: 'none', description: '' },
      incidents: [{
        id: 'inc2',
        name: 'Dup test',
        status: 'resolved',
        impact: 'minor',
        created_at: '2026-03-01T10:00:00Z',
        resolved_at: '2026-03-01T11:00:00Z',
        incident_updates: [
          { status: 'investigating', body: 'First', created_at: '2026-03-01T10:00:00Z' },
          { status: 'investigating', body: 'Duplicate', created_at: '2026-03-01T10:00:00Z' },
          { status: 'resolved', body: 'Done', created_at: '2026-03-01T11:00:00Z' },
        ],
      }],
    }
    const result = parseIncidents(data)
    expect(result[0].timeline).toHaveLength(2) // deduped from 3
  })
})

describe('parseUptimeData', () => {
  const makeHtml = (uptimeData: object) =>
    `<script>var uptimeData = ${JSON.stringify(uptimeData)}</script>`

  it('parses uptime% with 30% partial weight', () => {
    const html = makeHtml({
      comp1: {
        days: [
          { date: '2026-03-01', outages: { p: 1000, m: 0 } },
          { date: '2026-03-02', outages: { p: 0, m: 0 } },
          { date: '2026-03-03', outages: {} },
        ],
      },
    })
    const result = parseUptimeData(html, 'comp1')
    expect(result.uptimePercent).not.toBeNull()
    // 3 valid days, weighted outage = 0 + 300 (1000*0.3) = 300
    // uptime = (1 - 300 / (3 * 86400)) * 100
    const expected = Math.floor((1 - 300 / (3 * 86400)) * 10000) / 100
    expect(result.uptimePercent).toBe(expected)
  })

  it('uses floor to avoid overstating uptime (tiny outage should not round to 100%)', () => {
    // #1006 — the window is the trailing 30 days of the ~90 the page embeds, so the outage has to sit
    // INSIDE it (here: the most recent day). A 302s partial outage → weighted = 90.6s
    // round: (1 - 90.6 / 2592000) * 10000 = 9999.65... → round = 10000 → 100.00% (wrong)
    // floor: 9999.65... → floor = 9999 → 99.99% (correct)
    const days = Array.from({ length: 90 }, (_, i) => ({
      date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      outages: i === 89 ? { p: 302, m: 0 } : { p: 0, m: 0 },
    }))
    const html = makeHtml({ comp1: { days } })
    const result = parseUptimeData(html, 'comp1')
    expect(result.uptimePercent).toBe(99.99)
    expect(result.uptimePercent).toBeLessThan(100)
  })

  it('sets dailyImpact correctly — critical when m > p', () => {
    const html = makeHtml({
      comp1: {
        days: [
          { date: '2026-03-01', outages: { p: 100, m: 200 } },
          { date: '2026-03-02', outages: { p: 300, m: 100 } },
        ],
      },
    })
    const result = parseUptimeData(html, 'comp1')
    expect(result.dailyImpact['2026-03-01']).toBe('critical') // m > p
    expect(result.dailyImpact['2026-03-02']).toBe('major')    // p >= m
    // Lock the combined-impact uptime% formula: MAJOR_WEIGHT(1.0) × m + MINOR_WEIGHT(0.3) × p
    // Day 1: 1.0×200 + 0.3×100 = 230s ; Day 2: 1.0×100 + 0.3×300 = 190s ; total = 420s over 2 days
    const expected = Math.floor((1 - 420 / (2 * 86400)) * 10000) / 100
    expect(result.uptimePercent).toBe(expected)
  })

  it('returns empty when component not found', () => {
    const html = makeHtml({ other: { days: [] } })
    const result = parseUptimeData(html, 'missing')
    expect(result.dailyImpact).toEqual({})
    expect(result.uptimePercent).toBeNull()
  })

  it('returns empty when no uptimeData in HTML', () => {
    const result = parseUptimeData('<html></html>', 'comp1')
    expect(result.dailyImpact).toEqual({})
    expect(result.uptimePercent).toBeNull()
  })

  // #1006 core coverage — the trailing-window + worst-of paths the rewrite hinges on.
  it('a clean window is exactly 100.00 (not null — a tracked, incident-free component)', () => {
    const days = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
      outages: { p: 0, m: 0 },
    }))
    const result = parseUptimeData(makeHtml({ comp1: { days } }), 'comp1')
    expect(result.uptimePercent).toBe(100)
  })

  it('an outage OUTSIDE the trailing 30-day window is dropped by slice(-windowDays)', () => {
    // 90 days; the ONLY outage sits on the oldest day (index 0) → outside the trailing 30 → 100%.
    const days = Array.from({ length: 90 }, (_, i) => ({
      date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      outages: i === 0 ? { p: 0, m: 86_400 } : { p: 0, m: 0 },
    }))
    const result = parseUptimeData(makeHtml({ comp1: { days } }), 'comp1')
    expect(result.uptimePercent).toBe(100)
  })

  it('a LIST of ids is a worst-of across the badge scope (LangSmith-class multi-component)', () => {
    const clean = Array.from({ length: 30 }, (_, i) => ({ date: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`, outages: { p: 0, m: 0 } }))
    const withOutage = clean.map((d, i) => (i === 29 ? { ...d, outages: { p: 0, m: 86_400 } } : d)) // 1 full day down
    const html = makeHtml({ compA: { days: clean }, compB: { days: withOutage } })
    const result = parseUptimeData(html, ['compA', 'compB'])
    // worst-of → compB's 1-day-of-30 outage governs, not compA's clean 100%.
    expect(result.uptimePercent).toBe(parseUptimeData(html, 'compB').uptimePercent)
    expect(result.uptimePercent).toBeLessThan(100)
  })

  it('WARNS when a configured badge id no longer resolves — a rotated id must not silently shrink the worst-of', () => {
    const days = Array.from({ length: 30 }, (_, i) => ({ date: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`, outages: { p: 0, m: 0 } }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = parseUptimeData(makeHtml({ compA: { days } }), ['compA', 'rotated-gone'])
    expect(result.uptimePercent).toBe(100) // still resolves compA
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain('1/2 configured components absent')
    warn.mockRestore()
  })

  it('#989 — WARNS when a SINGLE configured badge id is absent (the #956/#958 silent-null trap)', () => {
    const days = Array.from({ length: 30 }, (_, i) => ({ date: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`, outages: { p: 0, m: 0 } }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A single statusComponentId that isn't present in a NON-empty uptimeData → null uptime + a warn.
    const result = parseUptimeData(makeHtml({ compA: { days } }), 'typoed-id')
    expect(result.uptimePercent).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain("'typoed-id' absent from window.uptimeData")
    warn.mockRestore()
  })

  it('#989 — does NOT warn when window.uptimeData is genuinely empty (no false alarm)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    parseUptimeData(makeHtml({}), 'compA') // empty uptimeData object → quiet
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
