import { describe, it, expect } from 'vitest'
import { resolveStatusDisplay } from '../statusDisplay'

// #722 — the intermediate "Partial" display state. Pure mapping; the StatusPill + the is-down
// SSR both render from this decision. Locks in that it's DISPLAY-only (operational stays the
// underlying status; this only changes the rendered pill).
describe('resolveStatusDisplay (#722)', () => {
  it('maps operational + partialCount>0 → partial', () => {
    expect(resolveStatusDisplay('operational', 1)).toBe('partial')
    expect(resolveStatusDisplay('operational', 5)).toBe('partial')
  })

  it('keeps plain operational when nothing is affected', () => {
    expect(resolveStatusDisplay('operational', 0)).toBe('operational')
    expect(resolveStatusDisplay('operational')).toBe('operational')
  })

  it('never downgrades a real degraded/down to partial', () => {
    // partialCount is only meaningful when the badge reads operational; a real outage wins.
    expect(resolveStatusDisplay('degraded', 3)).toBe('degraded')
    expect(resolveStatusDisplay('down', 3)).toBe('down')
  })

  it('sourceDead → unknown, and partialCount is ignored (counts untrustworthy, #689)', () => {
    expect(resolveStatusDisplay('operational', 2, true)).toBe('unknown')
    expect(resolveStatusDisplay('operational', 0, true)).toBe('unknown')
    expect(resolveStatusDisplay('degraded', 0, true)).toBe('unknown')
  })

  it('defaults gracefully', () => {
    expect(resolveStatusDisplay()).toBe('operational')
  })
})
