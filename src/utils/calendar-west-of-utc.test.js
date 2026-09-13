// Separate file from calendar.test.js because TZ must be set once, before importing the module
// under test, and calendar.test.js already fixes it to Asia/Seoul (east of UTC) — this file needs a
// timezone WEST of UTC to reproduce the #1400 clamp case, so it needs its own process.
const ORIG_TZ = process.env.TZ
process.env.TZ = 'America/New_York' // UTC-4/-5

import { describe, it, expect, afterAll, vi } from 'vitest'
import { buildCalendarFromIncidents } from './calendar'

afterAll(() => {
  if (ORIG_TZ === undefined) delete process.env.TZ
  else process.env.TZ = ORIG_TZ
})

const localKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

describe('buildCalendarFromIncidents — a bare-UTC-date entry ahead of the viewer local day clamps to today (#1400)', () => {
  it('an incident\'s own precise local day naturally lands within the window, west of UTC (needs no clamp)', () => {
    // Frozen "now": 2026-09-13T02:30:00Z = 2026-09-12 22:30 America/New_York (local "today" = 09-12).
    // The incident's OWN instant (01:00Z) converts to 2026-09-12 21:00 local — already local "today",
    // not the future — because a real past instant can never be later than "now" in ANY timezone.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-13T02:30:00Z'))
    try {
      const now = new Date()
      expect(localKey(now)).toBe('2026-09-12') // sanity: local "today" is behind the UTC day below

      const dailyImpact = { '2026-09-13': 'major' }
      const incidents = [{ startedAt: '2026-09-13T01:00:00.000Z', impact: 'major', resolvedAt: '2026-09-13T02:00:00.000Z' }]
      const cal = buildCalendarFromIncidents(incidents, dailyImpact, 14, 'operational')

      expect(cal[cal.length - 1]).toBe('major') // local "today"
    } finally {
      vi.useRealTimers()
    }
  })

  it('a dailyImpact day with NO matching incident falls back to the noon-UTC guess, clamped so it cannot vanish outside the window', () => {
    // Same frozen "now" (local "today" = 09-12), but this time NOTHING in the incidents list starts
    // on 2026-09-13 — there is no precise instant to defer to, so Phase 1 must use its noon-UTC
    // guess for that bare date, which (noon UTC on 09-13, in EDT) converts to a LOCAL day (09-13)
    // still in this viewer's future. Without the clamp this would fall outside the 14-day window
    // and the day would silently vanish from the rendered calendar.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-13T02:30:00Z'))
    try {
      const now = new Date()
      expect(localKey(now)).toBe('2026-09-12')

      const dailyImpact = { '2026-09-13': 'major' }
      const cal = buildCalendarFromIncidents([], dailyImpact, 14, 'operational')

      expect(cal[cal.length - 1]).toBe('major') // clamped onto local "today", not vanished
    } finally {
      vi.useRealTimers()
    }
  })
})
