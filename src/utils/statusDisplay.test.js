import { describe, it, expect } from 'vitest'
import { resolveStatusDisplay, sourceFlagsOf, displayStatusOf, isDisplayAffected } from './statusDisplay'

// #722/#744 — the shared badge/stripe display-status resolver. Drives the StatusPill, the Overview
// card left stripe, the sidebar dot, and (mirrored) the is-down header. Pure; never mutates the raw
// `status`.
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

  // #1004 — `sourceUnknown` + `degraded` is not a verdict about the service: it is the worker's
  // 3-consecutive-fetch-failure fallback (throw / 5xx, #714). JetBrains moved Junie's status page and
  // 301'd the old host to the new site root, so our fetch got HTML where it wanted JSON — and Junie
  // rendered a false amber `degraded` badge while JetBrains reported all-green.
  it('sourceUnknown + degraded → unknown (the fetch-failure fallback is not an outage)', () => {
    expect(resolveStatusDisplay('degraded', 0, false, true)).toBe('unknown')
  })

  it('sourceUnknown + operational → operational (under the 3-strike threshold: no news is not bad news)', () => {
    expect(resolveStatusDisplay('operational', 0, false, true)).toBe('operational')
  })

  it('sourceUnknown never masks a real down', () => {
    // Unreachable by construction — both `sourceUnknown` return paths yield operational|degraded — but
    // pinned so a future producer can't quietly make "down" disappear behind a neutral badge.
    expect(resolveStatusDisplay('down', 0, false, true)).toBe('down')
  })

  it('sourceDead wins when both flags are somehow set (ServiceDetails relies on that precedence)', () => {
    expect(resolveStatusDisplay('degraded', 0, true, true)).toBe('unknown')
  })
})

// #1004 — the guards that decide WHETHER a service's source flags count. Derived once, so the pill,
// the stripe, the sidebar and the action banner can never disagree.
describe('sourceFlagsOf', () => {
  it('a healthy probe cancels sourceDead (#689 — the page died but the API answers)', () => {
    expect(sourceFlagsOf({ sourceDead: true })).toEqual([true, false])
    expect(sourceFlagsOf({ sourceDead: true, probeConfirmed: true })).toEqual([false, false])
  })

  it('a FAILING probe cancels sourceUnknown — the outage is corroborated, keep it amber', () => {
    // The real-outage shape: provider goes down → its status page 5xx's → our fetch throws → 3 strikes
    // → degraded + sourceUnknown, while our direct probe independently confirms the service is broken.
    // Neutralising that to "we can't tell" would be a false reassurance backed by nothing.
    expect(sourceFlagsOf({ sourceUnknown: true })).toEqual([false, true])
    expect(sourceFlagsOf({ sourceUnknown: true, probeContradicted: true })).toEqual([false, false])
    expect(displayStatusOf({ status: 'degraded', sourceUnknown: true, probeContradicted: true })).toBe('degraded')
    expect(displayStatusOf({ status: 'degraded', sourceUnknown: true })).toBe('unknown')
  })
})

// #1004 — the action banner, the fallback recommendations and the sidebar issue count all filtered on
// the RAW status, so an unreadable-source service still showed "Degraded — try X instead": AIWatch
// recommending users abandon a service it had just admitted it could not read.
describe('isDisplayAffected', () => {
  it('excludes a service whose status source we cannot read', () => {
    expect(isDisplayAffected({ status: 'degraded', sourceUnknown: true })).toBe(false)
    expect(isDisplayAffected({ status: 'operational', sourceDead: true })).toBe(false)
  })

  it('still includes real outages, including a probe-corroborated one', () => {
    expect(isDisplayAffected({ status: 'degraded' })).toBe(true)
    expect(isDisplayAffected({ status: 'down' })).toBe(true)
    expect(isDisplayAffected({ status: 'degraded', sourceUnknown: true, probeContradicted: true })).toBe(true)
  })

  it('does not count a sub-threshold partial as an outage (#722 — the service is up overall)', () => {
    expect(isDisplayAffected({ status: 'operational', partialCount: 2 })).toBe(false)
  })
})
