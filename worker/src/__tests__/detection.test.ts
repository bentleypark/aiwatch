import { describe, it, expect } from 'vitest'
import {
  parseDetectionEntry,
  resolveDetectionUpdate,
  serializeDetectionEntry,
  getDetectionTimestamp,
  isProbeEarlier,
} from '../detection'

describe('parseDetectionEntry', () => {
  it('parses JSON format', () => {
    const raw = JSON.stringify({ t: '2026-04-09T10:00:00Z', incId: 'inc-1' })
    expect(parseDetectionEntry(raw)).toEqual({ t: '2026-04-09T10:00:00Z', incId: 'inc-1' })
  })

  it('parses JSON with null incId', () => {
    const raw = JSON.stringify({ t: '2026-04-09T10:00:00Z', incId: null })
    expect(parseDetectionEntry(raw)).toEqual({ t: '2026-04-09T10:00:00Z', incId: null })
  })

  it('parses JSON with missing incId as null', () => {
    const raw = JSON.stringify({ t: '2026-04-09T10:00:00Z' })
    expect(parseDetectionEntry(raw)).toEqual({ t: '2026-04-09T10:00:00Z', incId: null })
  })

  it('parses legacy plain ISO string', () => {
    expect(parseDetectionEntry('2026-04-09T10:00:00Z')).toEqual({ t: '2026-04-09T10:00:00Z', incId: null })
  })

  it('returns null for null input', () => {
    expect(parseDetectionEntry(null)).toBeNull()
  })

  it('returns null for unexpected JSON shape', () => {
    expect(parseDetectionEntry(JSON.stringify({ foo: 'bar' }))).toBeNull()
  })
})

describe('resolveDetectionUpdate', () => {
  const NOW = '2026-04-09T12:00:00Z'

  it('creates new entry when no existing', () => {
    const result = resolveDetectionUpdate(null, 'inc-1', NOW)
    expect(result).toEqual({ entry: { t: NOW, incId: 'inc-1' }, reason: 'new' })
  })

  it('resets when incident ID changes', () => {
    const existing = { t: '2026-04-09T10:00:00Z', incId: 'inc-1' }
    const result = resolveDetectionUpdate(existing, 'inc-2', NOW)
    expect(result).toEqual({ entry: { t: NOW, incId: 'inc-2' }, reason: 'incident-changed' })
  })

  it('returns null when same incident ID (no change)', () => {
    const existing = { t: '2026-04-09T10:00:00Z', incId: 'inc-1' }
    expect(resolveDetectionUpdate(existing, 'inc-1', NOW)).toBeNull()
  })

  it('backfills incId when probe-only detection gets real incident', () => {
    const existing = { t: '2026-04-09T10:00:00Z', incId: null }
    const result = resolveDetectionUpdate(existing, 'inc-1', NOW)
    expect(result).toEqual({ entry: { t: '2026-04-09T10:00:00Z', incId: 'inc-1' }, reason: 'backfill' })
    // Preserves original timestamp (probe detection time)
  })

  it('returns null when both incId are null (no change)', () => {
    const existing = { t: '2026-04-09T10:00:00Z', incId: null }
    expect(resolveDetectionUpdate(existing, null, NOW)).toBeNull()
  })

  it('returns null when existing has incId but active is null', () => {
    const existing = { t: '2026-04-09T10:00:00Z', incId: 'inc-1' }
    expect(resolveDetectionUpdate(existing, null, NOW)).toBeNull()
  })
})

describe('getDetectionTimestamp', () => {
  it('extracts timestamp from JSON format', () => {
    expect(getDetectionTimestamp(JSON.stringify({ t: '2026-04-09T10:00:00Z', incId: 'x' }))).toBe('2026-04-09T10:00:00Z')
  })

  it('extracts timestamp from legacy format', () => {
    expect(getDetectionTimestamp('2026-04-09T10:00:00Z')).toBe('2026-04-09T10:00:00Z')
  })

  it('returns null for null input', () => {
    expect(getDetectionTimestamp(null)).toBeNull()
  })
})

describe('isProbeEarlier', () => {
  it('returns true when no existing detection', () => {
    expect(isProbeEarlier(null, '2026-04-09T10:00:00Z')).toBe(true)
  })

  it('returns true when spike is earlier', () => {
    const existing = JSON.stringify({ t: '2026-04-09T11:00:00Z', incId: null })
    expect(isProbeEarlier(existing, '2026-04-09T10:00:00Z')).toBe(true)
  })

  it('returns false when spike is later', () => {
    const existing = JSON.stringify({ t: '2026-04-09T09:00:00Z', incId: null })
    expect(isProbeEarlier(existing, '2026-04-09T10:00:00Z')).toBe(false)
  })

  it('handles legacy format', () => {
    expect(isProbeEarlier('2026-04-09T11:00:00Z', '2026-04-09T10:00:00Z')).toBe(true)
  })

  it('returns true when existing is corrupt', () => {
    expect(isProbeEarlier('corrupt', '2026-04-09T10:00:00Z')).toBe(true)
  })

  it('returns false when spike time is invalid', () => {
    const existing = JSON.stringify({ t: '2026-04-09T10:00:00Z', incId: null })
    expect(isProbeEarlier(existing, 'invalid')).toBe(false)
  })
})

describe('serializeDetectionEntry', () => {
  it('serializes to JSON', () => {
    const entry = { t: '2026-04-09T10:00:00Z', incId: 'inc-1' }
    const result = serializeDetectionEntry(entry)
    expect(JSON.parse(result)).toEqual(entry)
  })
})
