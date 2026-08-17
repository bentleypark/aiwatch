import { describe, it, expect } from 'vitest'
import { groupWorstStatus } from '../AnalysisModal'

// #1233 — the modal's group header dot. The original expression was two-valued
// (`some(s => s.status !== 'operational') ? 'degraded' : 'operational'`), so a service whose status
// source AIWatch could not read dragged the whole group to "degraded". Narrowing that test to the
// display-affected predicate fixed the false outage but opened the opposite hole: with no third arm,
// a group where EVERY service is unreadable fell through to 'operational' and rendered a green dot.
// Both failures are the same mistake — collapsing three states into two — so both directions are
// pinned here.
describe('groupWorstStatus (#1233)', () => {
  const s = (status, extra = {}) => ({ id: status, status, ...extra })

  it('an all-unreadable group is neither an outage nor an all-clear', () => {
    expect(groupWorstStatus([s('unknown'), s('unknown')])).toBe('unknown')
  })

  it('an unreadable source does not drag a healthy group to degraded', () => {
    expect(groupWorstStatus([s('operational'), s('unknown')])).toBe('unknown')
  })

  it('a CONFIRMED outage still wins over an unreadable sibling', () => {
    expect(groupWorstStatus([s('unknown'), s('down')])).toBe('down')
    expect(groupWorstStatus([s('unknown'), s('degraded')])).toBe('degraded')
  })

  it('controls: the ordinary groups are unchanged', () => {
    expect(groupWorstStatus([s('operational'), s('operational')])).toBe('operational')
    expect(groupWorstStatus([s('degraded'), s('down')])).toBe('down')
  })

  it('reads the DISPLAY state, so a legacy unreadable payload is not called an outage', () => {
    // `degraded` + `sourceUnknown` is what a payload cached before #1233 carries.
    expect(groupWorstStatus([s('degraded', { sourceUnknown: true })])).toBe('unknown')
    // ...unless our own probe corroborates it, in which case the outage is real.
    expect(groupWorstStatus([s('degraded', { sourceUnknown: true, probeContradicted: true })])).toBe('degraded')
  })
})
