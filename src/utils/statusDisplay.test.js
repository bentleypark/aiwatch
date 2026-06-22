import { describe, it, expect } from 'vitest'
import { resolveStatusDisplay } from './statusDisplay'

// #722/#744 — the shared badge/stripe display-status resolver. Drives the StatusPill, the Overview
// card left stripe, and (mirrored) the is-down header dot. Pure; never mutates the raw `status`.
describe('resolveStatusDisplay', () => {
  it('operational + partialCount>0 → partial (the #744 case the Overview stripe was missing)', () => {
    expect(resolveStatusDisplay('operational', 1)).toBe('partial')
    expect(resolveStatusDisplay('operational', 5)).toBe('partial')
  })

  it('operational + no partial → operational', () => {
    expect(resolveStatusDisplay('operational', 0)).toBe('operational')
    expect(resolveStatusDisplay('operational')).toBe('operational')
  })

  it('sourceDead → unknown, overriding any partialCount (component counts untrustworthy then)', () => {
    expect(resolveStatusDisplay('operational', 3, true)).toBe('unknown')
    expect(resolveStatusDisplay('operational', 0, true)).toBe('unknown')
  })

  it('degraded / down pass through unchanged (partialCount only applies to operational)', () => {
    expect(resolveStatusDisplay('degraded', 4)).toBe('degraded')
    expect(resolveStatusDisplay('down', 4)).toBe('down')
  })
})
