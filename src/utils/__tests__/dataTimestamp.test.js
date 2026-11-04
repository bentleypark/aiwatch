import { describe, it, expect } from 'vitest'
import { dataTimestamp, followUpPollDelay } from '../dataTimestamp'

const NOW = new Date('2026-11-04T12:00:00Z')

describe('dataTimestamp', () => {
  it.each([
    ['the snapshot time of a cached response', { lastUpdated: '2026-11-04T11:58:15.000Z', cached: true }, '2026-11-04T11:58:15.000Z'],
    ['no lastUpdated', {}, NOW.toISOString()],
    ['an unparseable lastUpdated', { lastUpdated: 'soon' }, NOW.toISOString()],
    ['a non-string lastUpdated', { lastUpdated: 12 }, NOW.toISOString()],
    ['no body', null, NOW.toISOString()],
  ])('%s', (_name, data, expected) => {
    expect(dataTimestamp(data, NOW).toISOString()).toBe(expected)
  })
})

describe('followUpPollDelay', () => {
  it.each([
    ['a snapshot just read', 0, null],
    ['a snapshot at the stale threshold', 60_000, null],
    ['a snapshot past the stale threshold', 60_001, 20_000],
    ['a snapshot from minutes ago', 300_000, 20_000],
    ['a snapshot dated ahead of the clock', -5_000, null],
  ])('%s', (_name, ageMs, expected) => {
    expect(followUpPollDelay(new Date(NOW.getTime() - ageMs), NOW.getTime())).toBe(expected)
  })
})
