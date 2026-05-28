import { describe, it, expect } from 'vitest'
import { normalizeAlertCondition } from '../useSettings'

describe('normalizeAlertCondition (#470 — Alert Conditions migration)', () => {
  it("migrates the removed 'degraded' value to 'all' (preserves alert-on-every-change behavior)", () => {
    expect(normalizeAlertCondition('degraded', 'down')).toBe('all')
  })

  it('passes through the supported values', () => {
    expect(normalizeAlertCondition('down', 'all')).toBe('down')
    expect(normalizeAlertCondition('all', 'down')).toBe('all')
  })

  it('falls back for unknown/undefined values', () => {
    expect(normalizeAlertCondition(undefined, 'down')).toBe('down')
    expect(normalizeAlertCondition('bogus', 'all')).toBe('all')
  })
})
