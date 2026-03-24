import { describe, it, expect } from 'vitest'
import { formatDuration } from '../utils'

describe('formatDuration', () => {
  it('returns <1m for durations under 60 seconds', () => {
    const start = new Date('2026-03-23T10:00:00Z')
    const end = new Date('2026-03-23T10:00:30Z') // 30s
    expect(formatDuration(start, end)).toBe('<1m')
  })

  it('returns <1m for 0 second duration', () => {
    const d = new Date('2026-03-23T10:00:00Z')
    expect(formatDuration(d, d)).toBe('<1m')
  })

  it('returns 1m for exactly 60 seconds', () => {
    const start = new Date('2026-03-23T10:00:00Z')
    const end = new Date('2026-03-23T10:01:00Z')
    expect(formatDuration(start, end)).toBe('1m')
  })

  it('returns minutes for sub-hour durations', () => {
    const start = new Date('2026-03-23T10:00:00Z')
    const end = new Date('2026-03-23T10:45:00Z')
    expect(formatDuration(start, end)).toBe('45m')
  })

  it('returns hours and minutes for longer durations', () => {
    const start = new Date('2026-03-23T10:00:00Z')
    const end = new Date('2026-03-23T12:30:00Z')
    expect(formatDuration(start, end)).toBe('2h 30m')
  })

  it('returns Xh 0m when minutes are exactly zero', () => {
    const start = new Date('2026-03-23T10:00:00Z')
    const end = new Date('2026-03-23T13:00:00Z')
    expect(formatDuration(start, end)).toBe('3h 0m')
  })
})
