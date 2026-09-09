import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  REPORT_GUARD_PREFIX,
  reportGuardKey,
  reportGuardDay,
  hasReportedToday,
  markReportedToday,
} from '../reportGuard'
import { makeLocalStorage, makeThrowingLocalStorage } from './localStorageStub'

// #1369 — the guard used to be `!!localStorage.getItem(key)` over a stored `'1'`, which localStorage
// never expires: one report locked that service on that browser forever, while the server rolled over
// daily and the copy said "today". The direction that was missing is the OPEN one — a report made on
// an earlier day, and the legacy `'1'`, must NOT gate. Both are asserted below.

// The timezone is pinned, not inherited. Every UTC-vs-local assertion below is VACUOUS on a UTC
// runner — and CI is UTC (`ubuntu-latest`, no `TZ` set in any workflow), so the one drift this file
// exists to catch would have passed there while failing on a Seoul laptop. Node re-reads `process.env.TZ`
// on assignment, so setting it here binds the whole file regardless of where it runs.
process.env.TZ = 'Asia/Seoul'

const T = (iso) => Date.parse(iso)

describe('reportGuard (#1369)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorage())
    vi.useFakeTimers()
    vi.setSystemTime(T('2026-09-09T12:00:00Z'))
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('keys one entry per service, reused across days', () => {
    expect(reportGuardKey('claude')).toBe(`${REPORT_GUARD_PREFIX}claude`)
    expect(reportGuardKey('claude')).toBe('aiwatch-reported-claude')
  })

  it('stamps the UTC date, matching the server reportDateKey expression', () => {
    // 23:30 in UTC+9 (KST) is still the PREVIOUS UTC day — the server counts it as such, so the
    // client must too, or the two disagree for 9 hours out of every 24 in Seoul.
    expect(reportGuardDay(T('2026-09-09T23:30:00Z'))).toBe('2026-09-09')
    expect(reportGuardDay(T('2026-09-10T00:10:00Z'))).toBe('2026-09-10')
  })

  it('gates a report made TODAY (closed direction)', () => {
    markReportedToday('claude')
    expect(localStorage.getItem('aiwatch-reported-claude')).toBe('2026-09-09')
    expect(hasReportedToday('claude')).toBe(true)
  })

  it('does NOT gate once the UTC day rolls over (the bug)', () => {
    markReportedToday('claude')
    expect(hasReportedToday('claude')).toBe(true)
    vi.setSystemTime(T('2026-09-10T00:00:01Z'))
    expect(hasReportedToday('claude')).toBe(false)
  })

  it('does NOT gate on the legacy permanent value — everyone locked out self-heals', () => {
    localStorage.setItem('aiwatch-reported-claude', '1')
    expect(hasReportedToday('claude')).toBe(false)
  })

  it('does NOT gate on an absent, empty, garbage or future-dated value (fails OPEN)', () => {
    expect(hasReportedToday('claude')).toBe(false)
    for (const v of ['', 'true', '2026-09-08', '2099-01-01', '{}']) {
      localStorage.setItem('aiwatch-reported-claude', v)
      expect(hasReportedToday('claude')).toBe(false)
    }
  })

  it('is per service — reporting one does not gate another', () => {
    markReportedToday('claude')
    expect(hasReportedToday('openai')).toBe(false)
  })

  it('degrades to open when localStorage throws (private mode)', () => {
    vi.stubGlobal('localStorage', makeThrowingLocalStorage())
    expect(hasReportedToday('claude')).toBe(false)
    expect(() => markReportedToday('claude')).not.toThrow()
  })
})
