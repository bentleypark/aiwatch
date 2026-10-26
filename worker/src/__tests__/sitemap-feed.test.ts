import { describe, it, expect } from 'vitest'
import { buildSitemapFeed, isSitemapRequest, lastChangedAt } from '../sitemap-feed'

const stage = (at: string) => ({ stage: 'monitoring' as const, text: null, at })
const NOW = Date.parse('2026-10-26T00:00:00.000Z')

describe('lastChangedAt (#887)', () => {
  it('is null for no incidents', () => {
    expect(lastChangedAt([], NOW)).toBeNull()
    expect(lastChangedAt(undefined, NOW)).toBeNull()
  })

  it('takes the latest of start, resolution and timeline updates across incidents', () => {
    expect(lastChangedAt([
      { startedAt: '2026-10-20T08:00:00.000Z', resolvedAt: '2026-10-20T09:30:00.000Z', timeline: [] },
      { startedAt: '2026-10-24T10:00:00.000Z', resolvedAt: null, timeline: [stage('2026-10-24T10:45:00.000Z')] },
      { startedAt: '2026-10-22T00:00:00.000Z', resolvedAt: '2026-10-23T00:00:00.000Z', timeline: [] },
    ], NOW)).toBe('2026-10-24T10:45:00.000Z')
  })

  it('moves with an update posted to an ongoing incident', () => {
    const before = { startedAt: '2026-10-24T10:00:00.000Z', resolvedAt: null, timeline: [stage('2026-10-24T10:10:00.000Z')] }
    const after = { ...before, timeline: [...before.timeline, stage('2026-10-24T11:20:00.000Z')] }
    expect(lastChangedAt([before], NOW)).toBe('2026-10-24T10:10:00.000Z')
    expect(lastChangedAt([after], NOW)).toBe('2026-10-24T11:20:00.000Z')
  })

  it('moves when an incident resolves after its last update', () => {
    expect(lastChangedAt([
      { startedAt: '2026-10-24T10:00:00.000Z', resolvedAt: '2026-10-24T12:00:00.000Z', timeline: [stage('2026-10-24T11:00:00.000Z')] },
    ], NOW)).toBe('2026-10-24T12:00:00.000Z')
  })

  it('ignores unparseable instants instead of emitting them', () => {
    expect(lastChangedAt([
      { startedAt: 'not a date', resolvedAt: null, timeline: [stage('')] },
    ], NOW)).toBeNull()
    expect(lastChangedAt([
      { startedAt: '2026-10-01T00:00:00.000Z', resolvedAt: 'garbage', timeline: [] },
    ], NOW)).toBe('2026-10-01T00:00:00.000Z')
  })
})

describe('lastChangedAt — instants that are not page-change times (#887)', () => {
  it('skips a derived row\'s start and end: they are an anchor inside its day, here still in the future', () => {
    // betterstack.ts anchors a status_history row at local noon; at 08:00 that is hours ahead.
    const morning = Date.parse('2026-10-26T08:00:00.000Z')
    const derived = { startedAt: '2026-10-26T12:00:00.000Z', resolvedAt: '2026-10-26T12:10:00.000Z', timeline: [], derived: 'status_history' as const }
    expect(lastChangedAt([derived], morning)).toBeNull()
    expect(lastChangedAt([derived, { startedAt: '2026-10-25T09:00:00.000Z', resolvedAt: null, timeline: [] }], morning))
      .toBe('2026-10-25T09:00:00.000Z')
    // Also skipped when the anchor is in the past — it is still not the time the row changed.
    expect(lastChangedAt([{ ...derived, startedAt: '2026-10-20T12:00:00.000Z', resolvedAt: '2026-10-20T12:10:00.000Z' }], morning)).toBeNull()
  })

  it('drops an instant later than now', () => {
    expect(lastChangedAt([
      { startedAt: '2026-10-25T00:00:00.000Z', resolvedAt: '2026-10-27T00:00:00.000Z', timeline: [] },
    ], NOW)).toBe('2026-10-25T00:00:00.000Z')
  })
})

describe('buildSitemapFeed (#887)', () => {
  it('emits one entry per service with its own instant', () => {
    const feed = buildSitemapFeed([
      { id: 'claude', incidents: [{ startedAt: '2026-10-25T01:00:00.000Z', resolvedAt: null, timeline: [] }] },
      { id: 'groq', incidents: [] },
    ] as unknown as Parameters<typeof buildSitemapFeed>[0], NOW)
    expect(feed).toEqual({
      services: [
        { id: 'claude', lastChangedAt: '2026-10-25T01:00:00.000Z' },
        { id: 'groq', lastChangedAt: null },
      ],
    })
  })
})

describe('isSitemapRequest', () => {
  it('matches only src=sitemap', () => {
    expect(isSitemapRequest(new URLSearchParams('src=sitemap'))).toBe(true)
    expect(isSitemapRequest(new URLSearchParams('src=statusline-sitemap'))).toBe(false)
    expect(isSitemapRequest(new URLSearchParams(''))).toBe(false)
  })
})
