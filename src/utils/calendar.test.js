// Force a known east-of-UTC timezone so a UTC-evening impact provably falls on the NEXT local day.
// Set before importing the module under test so Date methods read it. (#693 follow-up)
const ORIG_TZ = process.env.TZ
process.env.TZ = 'Asia/Seoul' // UTC+9

import { describe, it, expect, afterAll } from 'vitest'
import { buildCalendarFromIncidents } from './calendar'

// Restore TZ so this file's global side effect can't leak into other date-sensitive test files
// sharing the same vitest worker.
afterAll(() => {
  if (ORIG_TZ === undefined) delete process.env.TZ
  else process.env.TZ = ORIG_TZ
})

// Map the status array (oldest→newest) back to { localDateKey: status } using the same
// today-relative formula the builder uses, so assertions are date-keyed and not index-fragile.
function calMap(arr, days) {
  const today = new Date()
  const m = {}
  arr.forEach((status, i) => {
    const d = new Date(today.getTime() - (days - 1 - i) * 86_400_000)
    m[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`] = status
  })
  return m
}

const localKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

describe('buildCalendarFromIncidents — dailyImpact key bucketing (#693 follow-up)', () => {
  it('an incident.io ISO key in the UTC evening buckets to the NEXT local day (KST), not the UTC day', () => {
    const now = new Date()
    // 3 days ago at 18:05 UTC → 03:05 next day in KST.
    const utcEvening = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3, 18, 5, 0))
    const iso = utcEvening.toISOString()
    const utcDay = iso.slice(0, 10)
    const localDay = localKey(utcEvening)
    expect(localDay).not.toBe(utcDay) // sanity: TZ stub took effect (+9 shifts the day)

    const m = calMap(buildCalendarFromIncidents([], { [iso]: 'minor' }, 30, 'operational'), 30)
    expect(m[localDay]).toBe('minor') // bucketed to the real local day…
    expect(m[utcDay]).toBe('operational') // …NOT the UTC day (the off-by-one this fix removes)
  })

  it('a bare UTC date key (statuspage/betterstack) stays on that day via the noon anchor', () => {
    const now = new Date()
    const dateKey = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3)).toISOString().slice(0, 10)
    const m = calMap(buildCalendarFromIncidents([], { [dateKey]: 'major' }, 30, 'operational'), 30)
    expect(m[dateKey]).toBe('major')
  })
})
