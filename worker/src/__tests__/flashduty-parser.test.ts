import { describe, it, expect } from 'vitest'
import { parseFlashdutyFeed, type FlashdutyFeed } from '../parsers/flashduty'
import fixture from './fixtures/deepseek-flashduty.json'

// #618 — Flashduty parser, exercised against a REAL captured DeepSeek payload (2026-06-12, 90-day
// window to match the official status page's displayed uptime, #619): 2 components (API Service /
// Web Chat Service), 15 history incidents, 0 active, 38 impact windows, per-component uptime
// 99.88 (API) / 99.48 (Web Chat).
const feed = fixture as FlashdutyFeed

// #1006 — uptime is COMPUTED over the trailing 30 days from `component_impacts`, not copied from the
// feed's published `component_uptimes` aggregate (whose period is Flashduty's, not ours). The fixture is a
// real capture, so `nowMs` is pinned to its capture date — otherwise "the last 30 days" would drift past
// the captured impacts and every assertion would decay to 100%.
const CAPTURED_AT = Date.parse('2026-06-12T00:00:00Z')

describe('parseFlashdutyFeed (#618)', () => {
  const parsed = parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT })

  it('maps the two page components to breakdown rows, all operational when no active incident', () => {
    // #1171 — names go through cleanComponentName (CJK stripped, English kept) now that a scoped
    // service can actually reach ≥2 components and render this breakdown on ServiceDetails.
    expect(parsed.components.map((c) => c.name)).toEqual([
      'API (API Service)',
      'Web Chat Service',
    ])
    expect(parsed.components.every((c) => c.status === 'operational')).toBe(true)
  })

  it('overall status is operational when active_changes is empty', () => {
    expect(parsed.status).toBe('operational')
  })

  it('parses every history incident with a flashduty: id and a sorted timeline', () => {
    expect(parsed.incidents).toHaveLength(15)
    const first = parsed.incidents[0]
    expect(first.id).toMatch(/^flashduty:\d+$/)
    // newest-first ordering
    for (let i = 1; i < parsed.incidents.length; i++) {
      expect(new Date(parsed.incidents[i - 1].startedAt).getTime())
        .toBeGreaterThanOrEqual(new Date(parsed.incidents[i].startedAt).getTime())
    }
  })

  it('maps a specific resolved incident end-to-end (6551550194287)', () => {
    const inc = parsed.incidents.find((i) => i.id === 'flashduty:6551550194287')!
    expect(inc).toBeDefined()
    expect(inc.status).toBe('resolved')
    expect(inc.resolvedAt).not.toBeNull()
    expect(inc.duration).toBeTruthy()
    expect(inc.componentNames).toContain('网页对话服务 (Web Chat Service)')
    // timeline: identified → resolved, English text extracted from the bilingual description
    expect(inc.timeline.map((t) => t.stage)).toEqual(['identified', 'resolved'])
    expect(inc.timeline[0].text).toMatch(/identified/i)
    expect(inc.timeline[0].text).not.toMatch(/[一-鿿]/) // Chinese half stripped
  })

  it('derives impact severity from component_changes (partial_outage → major)', () => {
    // 6499101276287 = "API Degraded Performance" with a partial_outage component change.
    const inc = parsed.incidents.find((i) => i.id === 'flashduty:6499101276287')!
    expect(inc.impact).toBe('major')
  })

  it('uptime30d = the worst component, computed over the trailing 30 days (#1006)', () => {
    // The feed PUBLISHES 99.88 (API) / 99.48 (Web Chat) over its own ~90-day period. Recomputed over the
    // trailing 30 days with the weights on /methodology: 99.93 / 99.90 — the older outages that drag the
    // published figures down fall outside the window. Worst-of → 99.90.
    expect(parsed.flashdutyUptime?.pct).toBeCloseTo(99.9, 2)
    // …and it is NOT the published aggregate, which is the entire point of #1006.
    expect(parsed.flashdutyUptime?.pct).not.toBeCloseTo(99.48, 2)
  })

  it('builds a dailyImpact map keyed by YYYY-MM-DD with valid levels', () => {
    const days = Object.keys(parsed.dailyImpact)
    expect(days.length).toBeGreaterThan(0)
    expect(days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true)
    expect(Object.values(parsed.dailyImpact).every((v) => ['minor', 'major', 'critical'].includes(v))).toBe(true)
  })

  it('reflects an active incident in status + component rows', () => {
    const withActive: FlashdutyFeed = {
      ...feed,
      active: {
        page: feed.active?.page,
        active_changes: [
          {
            change_id: 999,
            title: 'API outage',
            status: 'investigating',
            start_at_seconds: 1781000000,
            affected_components: [
              { component_id: '01KR3NC9ETZYF436Z8YT1HM047', name: 'API 服务 (API Service)', status: 'full_outage' },
            ],
            updates: [
              { at_seconds: 1781000000, status: 'investigating', description: 'Investigating.', component_changes: [{ component_id: '01KR3NC9ETZYF436Z8YT1HM047', status: 'full_outage' }] },
            ],
          },
        ],
      },
    }
    const p = parseFlashdutyFeed(withActive)
    expect(p.status).toBe('down')
    expect(p.components.find((c) => c.id === '01KR3NC9ETZYF436Z8YT1HM047')!.status).toBe('down')
    expect(p.components.find((c) => c.id === '01KR3NC9ETESRRQ4GABE0TGW53')!.status).toBe('operational')
    // active incident surfaces in the list as non-resolved
    expect(p.incidents.find((i) => i.id === 'flashduty:999')!.status).toBe('investigating')
  })

  it('is defensive against an empty/partial payload', () => {
    const empty = parseFlashdutyFeed({})
    expect(empty.status).toBe('operational')
    expect(empty.incidents).toEqual([])
    expect(empty.flashdutyUptime).toBeNull()
    expect(empty.components).toEqual([])
  })

  describe('option A — scope to the API component only (#618)', () => {
    const API_ID = '01KR3NC9ETZYF436Z8YT1HM047' // API Service (api.deepseek.com)
    const WEBCHAT_ID = '01KR3NC9ETESRRQ4GABE0TGW53' // Web Chat (chat.deepseek.com) — excluded
    const scoped = parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: API_ID })

    it('drops Web-Chat-only incidents (e.g. 6/9 6551550194287 affected only Web Chat)', () => {
      expect(scoped.incidents.find((i) => i.id === 'flashduty:6551550194287')).toBeUndefined()
      // an API-affecting incident stays
      expect(scoped.incidents.find((i) => i.id === 'flashduty:6499101276287')).toBeDefined()
      // strictly fewer than the unscoped 15
      expect(scoped.incidents.length).toBeLessThan(15)
      expect(scoped.incidents.length).toBeGreaterThan(0)
    })

    it('collapses components to just the API surface (so the ≥2 breakdown gate suppresses it)', () => {
      expect(scoped.components.map((c) => c.id)).toEqual([API_ID])
    })

    it('uptime is scoped to the API component alone, not a worst-of with Web Chat', () => {
      // #1006 — computed over 30 days: API 99.93, Web Chat 99.90. Scoping must yield the API figure,
      // so the two must differ for this assertion to prove anything.
      expect(scoped.flashdutyUptime?.pct).toBeCloseTo(99.93, 2)
      expect(scoped.flashdutyUptime?.pct).not.toBeCloseTo(parsed.flashdutyUptime!.pct, 2)
    })

    it('a Web-Chat-only active incident does NOT flip the API badge', () => {
      const webchatActive: FlashdutyFeed = {
        ...feed,
        active: {
          page: feed.active?.page,
          active_changes: [
            {
              change_id: 1001,
              title: 'Web Chat outage',
              status: 'investigating',
              start_at_seconds: 1781000000,
              affected_components: [{ component_id: WEBCHAT_ID, name: 'Web Chat', status: 'full_outage' }],
              updates: [{ at_seconds: 1781000000, status: 'investigating', component_changes: [{ component_id: WEBCHAT_ID, status: 'full_outage' }] }],
            },
          ],
        },
      }
      const p = parseFlashdutyFeed(webchatActive, { primaryComponentId: API_ID })
      expect(p.status).toBe('operational') // API unaffected
      expect(p.incidents.find((i) => i.id === 'flashduty:1001')).toBeUndefined()
    })
  })
})
