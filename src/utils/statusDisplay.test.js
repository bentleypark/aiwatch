import { describe, it, expect } from 'vitest'
import { resolveStatusDisplay, sourceFlagsOf, displayStatusOf, isDisplayAffected, isDisplayOperational } from './statusDisplay'

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

// #1034 — `isDisplayOperational` had NO unit coverage despite #1004 calling it "the single predicate
// behind the stat card, the tab badge AND the tab's list" (they drifted apart when only some moved).
// The Overview filter-tab e2e asserts the tab COUNT and the rendered LIST agree, which catches that
// drift — but both derive from THIS predicate, so a bug inside it breaks them identically and the
// e2e still passes. That blind spot is why the predicate needs its own deterministic test.
describe('isDisplayOperational (#1034 — the predicate the filter e2e cannot catch)', () => {
  it('is true for a plainly operational service', () => {
    expect(isDisplayOperational({ status: 'operational' })).toBe(true)
  })

  it('counts `partial` as operational (#722/#744 — the service IS up overall)', () => {
    // Not a formality: this is why a partial service's is-down SEO answer stays "No".
    expect(isDisplayOperational({ status: 'operational', partialCount: 2 })).toBe(true)
  })

  it('is false for confirmed outages', () => {
    expect(isDisplayOperational({ status: 'degraded' })).toBe(false)
    expect(isDisplayOperational({ status: 'down' })).toBe(false)
  })

  it('is false for an unreadable source — `unknown` is neither healthy nor affected (#1004)', () => {
    // The bucket that makes operational + issues NOT partition the total; the Overview tabs rely on
    // this, so an 'unknown' service must fall out of BOTH tabs rather than pad the operational one.
    expect(isDisplayOperational({ status: 'operational', sourceDead: true })).toBe(false)
    expect(isDisplayOperational({ status: 'degraded', sourceUnknown: true })).toBe(false)
    expect(isDisplayAffected({ status: 'operational', sourceDead: true })).toBe(false)
  })

  it('honours the probe overrides (#689/#1004)', () => {
    // probeConfirmed suppresses sourceDead → we know it's up despite the dead status page.
    expect(isDisplayOperational({ status: 'operational', sourceDead: true, probeConfirmed: true })).toBe(true)
    // probeContradicted suppresses sourceUnknown → the degraded is real, so NOT operational.
    expect(isDisplayOperational({ status: 'degraded', sourceUnknown: true, probeContradicted: true })).toBe(false)
  })

  // #1233 — the raw `unknown` status. Everything above drives the LEGACY encoding (`degraded` +
  // `sourceUnknown`), which is what a payload cached before the change still carries; production now
  // sends `unknown` directly and nothing here asserted it. These cases are what three comments in this
  // change claimed were already pinned — they were not, and `resolveStatusDisplay` could have been
  // mutated to map `unknown` back to `degraded` with the whole suite green.
  describe('raw unknown status (#1233)', () => {
    it('passes straight through the resolver — no mapping needed', () => {
      expect(resolveStatusDisplay('unknown')).toBe('unknown')
      expect(displayStatusOf({ status: 'unknown', sourceUnknown: true })).toBe('unknown')
    })

    it('is neither affected nor operational — the distinction the two-valued reading collapsed', () => {
      expect(isDisplayAffected({ status: 'unknown' })).toBe(false)
      expect(isDisplayOperational({ status: 'unknown' })).toBe(false)
    })

    it('a real outage is still affected, and a healthy service still operational', () => {
      expect(isDisplayAffected({ status: 'down' })).toBe(true)
      expect(isDisplayAffected({ status: 'degraded' })).toBe(true)
      expect(isDisplayOperational({ status: 'operational' })).toBe(true)
    })

    it('agrees with the worker\'s transitional decoder on the legacy pair', () => {
      // `normalizeCachedService` (worker/src/status-verdict.ts) maps `degraded` + `sourceUnknown` →
      // `unknown` unless a probe corroborates. This module hand-copies that rule for the SPA bundle;
      // the two must answer the same, which is the claim the comment in statusDisplay.js makes.
      expect(displayStatusOf({ status: 'degraded', sourceUnknown: true })).toBe('unknown')
      expect(displayStatusOf({ status: 'degraded', sourceUnknown: true, probeContradicted: true })).toBe('degraded')
      expect(displayStatusOf({ status: 'down', sourceUnknown: true })).toBe('down')
    })
  })

  it('never reports a service as both operational and affected (the tabs must not double-count)', () => {
    const cases = [
      { status: 'operational' }, { status: 'operational', partialCount: 2 },
      { status: 'degraded' }, { status: 'down' },
      { status: 'operational', sourceDead: true }, { status: 'degraded', sourceUnknown: true },
      { status: 'operational', sourceDead: true, probeConfirmed: true },
      { status: 'degraded', sourceUnknown: true, probeContradicted: true },
      // #1233 — the raw value the worker now publishes.
      { status: 'unknown' }, { status: 'unknown', sourceUnknown: true },
    ]
    for (const s of cases) {
      expect(isDisplayOperational(s) && isDisplayAffected(s), JSON.stringify(s)).toBe(false)
    }
  })
})
