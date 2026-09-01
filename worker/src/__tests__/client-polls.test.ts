import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  readExtPolls,
  readPluginPolls,
  readStatuslinePolls,
  clientMinutesFromPolls,
  formatClientTime,
  EXT_POLL_PERIOD_MINUTES,
  PLUGIN_POLL_PERIOD_SECONDS,
} from '../api-traffic'

// #1293 — the retention counters (Chrome extension, Claude Code plugin monitor, statusline) and the
// polls→running-time conversion that makes them readable. The sibling `feedPolls` primitives are
// covered in api-traffic.test.ts; these are the ones added when the counters stopped being discarded.

describe('readExtPolls (#1293)', () => {
  it('keeps a genuine zero as a VALUE, under the verdict that says it is ambiguous', () => {
    // Two things at once. The value survives (`0`, not `null`) because the read DID succeed — storing
    // `null` would lose the distinction #1273 was opened to remove. But the verdict is `zero`, not
    // `ok`, because a window nobody polled and a recorder that wrote nothing produce the same `0`.
    // While the operator's own client was in the count a non-zero value doubled as proof the recorder
    // was alive; they disabled it to measure external usage, and that canary went with it.
    expect(readExtPolls(0)).toEqual({ verdict: 'zero', polls: 0 })
  })

  it('carries a real count through with its verdict', () => {
    expect(readExtPolls(2010)).toEqual({ verdict: 'ok', polls: 2010 })
  })

  it.each([
    ['null (query failed / unconfigured / empty result set)', null],
    ['undefined', undefined],
    ['NaN from an unparseable body', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a negative count, which no counter can produce', -1],
  ])('reports %s as failed, with no value beside it', (_label, input) => {
    expect(readExtPolls(input as number | null | undefined)).toEqual({ verdict: 'failed', polls: null })
  })

  it('never returns a value on a failed verdict, so a caller cannot store one story and log another', () => {
    // The invariant is value-iff-not-failed, NOT value-iff-ok: `zero` carries a real `0`.
    for (const input of [null, undefined, Number.NaN, -5, 0, 7]) {
      const read = readExtPolls(input as number | null | undefined)
      expect(read.verdict === 'failed' ? read.polls === null : read.polls !== null).toBe(true)
    }
  })
})

describe('readPluginPolls (#1293)', () => {
  it('flags an all-zero window as `zero` while keeping the counts', () => {
    expect(readPluginPolls({ monitor: 0, brief: 0 })).toEqual({ verdict: 'zero', counts: { monitor: 0, brief: 0 } })
  })

  it('keys the verdict on `monitor` alone — briefings cannot certify a monitor zero', () => {
    // This asserted the opposite until round 7. `monitor` is the background-poll volume the counter
    // exists to measure and the one the operator disabled; requiring BOTH to be zero let three
    // on-demand `/aiwatch` runs from anywhere file a monitor zero as unambiguous. It is also the
    // aggregation `growth-series.ts` forbids: the two indexes stay separate because summing them makes
    // a burst of briefings look like installs.
    expect(readPluginPolls({ monitor: 0, brief: 3 })).toEqual({ verdict: 'zero', counts: { monitor: 0, brief: 3 } })
    expect(readPluginPolls({ monitor: 5, brief: 0 })).toEqual({ verdict: 'ok', counts: { monitor: 5, brief: 0 } })
  })

  it('keeps monitor and brief SEPARATE — summing them would read briefings as installs', () => {
    const read = readPluginPolls({ monitor: 1044, brief: 3 })
    expect(read).toEqual({ verdict: 'ok', counts: { monitor: 1044, brief: 3 } })
  })

  it('reports a null read as failed', () => {
    expect(readPluginPolls(null)).toEqual({ verdict: 'failed', counts: null })
    expect(readPluginPolls(undefined)).toEqual({ verdict: 'failed', counts: null })
  })

  it('rejects a half-valid shape rather than storing it in a no-TTL row', () => {
    // `parsePluginTrafficResponse` is `unknown`-tolerant by design; this is the last gate before a
    // permanent row, so a field that is not a finite non-negative number fails the whole read rather
    // than being written as a partial measurement.
    for (const bad of [
      { monitor: Number.NaN, brief: 3 },
      { monitor: 5, brief: Number.NaN },
      { monitor: -1, brief: 0 },
      { monitor: 5, brief: '3' },
      { monitor: undefined, brief: 0 },
    ]) {
      expect(readPluginPolls(bad as never)).toEqual({ verdict: 'failed', counts: null })
    }
  })

  it('returns a fresh object, so a later mutation of the source cannot rewrite a stored row', () => {
    const source = { monitor: 10, brief: 2 }
    const read = readPluginPolls(source)
    source.monitor = 999
    expect(read).toEqual({ verdict: 'ok', counts: { monitor: 10, brief: 2 } })
  })
})

describe('clientMinutesFromPolls (#1293)', () => {
  it('converts a poll total into observed running time at the extension interval', () => {
    // Each poll marks one 2-minute interval the browser was alive. 2010 × 2 = 4020 min = 67h — the
    // 2026-08-21 production reading, which the audit had to convert by hand because this did not exist.
    expect(clientMinutesFromPolls(2010, EXT_POLL_PERIOD_MINUTES)).toBe(4020)
    expect(clientMinutesFromPolls(720, EXT_POLL_PERIOD_MINUTES)).toBe(1440) // exactly 24h
  })

  it('converts at the plugin monitor interval', () => {
    expect(clientMinutesFromPolls(1440, PLUGIN_POLL_PERIOD_SECONDS / 60)).toBe(1440)
    expect(clientMinutesFromPolls(1044, PLUGIN_POLL_PERIOD_SECONDS / 60)).toBe(1044) // 17.4h
  })

  it('keeps small totals distinguishable — the range the exclusion window put us in', () => {
    // The client-day form rounded all of these to the same `<0.1`. With the operator's own client
    // excluded these are the EXPECTED readings, and 1 poll vs 40 polls are different findings.
    expect(clientMinutesFromPolls(1, EXT_POLL_PERIOD_MINUTES)).toBe(2)
    expect(clientMinutesFromPolls(10, EXT_POLL_PERIOD_MINUTES)).toBe(20)
    expect(clientMinutesFromPolls(40, EXT_POLL_PERIOD_MINUTES)).toBe(80)
  })

  it('maps zero polls to zero minutes rather than to null', () => {
    expect(clientMinutesFromPolls(0, EXT_POLL_PERIOD_MINUTES)).toBe(0)
  })

  it('returns null for a non-positive interval instead of a bogus number', () => {
    expect(clientMinutesFromPolls(2010, 0)).toBeNull()
    expect(clientMinutesFromPolls(2010, -2)).toBeNull()
    expect(clientMinutesFromPolls(2010, Number.NaN)).toBeNull()
  })

  it('returns null when the PRODUCT overflows, not just on bad inputs', () => {
    // Two finite numbers multiply to Infinity; the docstring promises `null` rather than a bogus
    // number, and without this the guard is unpinned.
    expect(clientMinutesFromPolls(1e308, 1e308)).toBeNull()
  })

  it('returns null for an invalid poll total', () => {
    expect(clientMinutesFromPolls(Number.NaN, EXT_POLL_PERIOD_MINUTES)).toBeNull()
    expect(clientMinutesFromPolls(-1, EXT_POLL_PERIOD_MINUTES)).toBeNull()
  })
})

describe('formatClientTime (#1293)', () => {
  it('renders hours at or above an hour', () => {
    expect(formatClientTime(4020, 'browser')).toBe('67h of browser time')
    expect(formatClientTime(1440, 'session')).toBe('24h of session time')
    expect(formatClientTime(1044, 'session')).toBe('17h of session time')
  })

  it('renders minutes below an hour, so small readings stay distinct', () => {
    expect(formatClientTime(2, 'browser')).toBe('2 min of browser time')
    expect(formatClientTime(20, 'browser')).toBe('20 min of browser time')
    expect(formatClientTime(59, 'session')).toBe('59 min of session time')
  })

  it('renders an exact zero as 0 min — no traffic is a real reading', () => {
    expect(formatClientTime(0, 'browser')).toBe('0 min of browser time')
  })

  it('switches unit exactly at 60 minutes', () => {
    // Nothing pinned the boundary: moving the threshold to 120 survived the whole suite, because no
    // test called with 60…119.
    expect(formatClientTime(59, 'browser')).toBe('59 min of browser time')
    expect(formatClientTime(60, 'browser')).toBe('1h of browser time')
    expect(formatClientTime(119, 'browser')).toBe('2h of browser time')
  })

  it('rounds hours to nearest, not down', () => {
    // `Math.floor` survived every existing case because 4020, 1440 and 1044 all have a fractional part
    // below 0.5. 90 min is the discriminating input: nearest gives 2h, floor gives 1h.
    expect(formatClientTime(90, 'session')).toBe('2h of session time')
    expect(formatClientTime(89, 'session')).toBe('1h of session time')
  })

  it('rounds BEFORE choosing the unit, so 59.6 is an hour and never "60 min"', () => {
    // Comparing the raw value let 59.6 round to 60 and print "60 min" — the exact string the unit
    // switch exists to make unreachable.
    expect(formatClientTime(59.6, 'browser')).toBe('1h of browser time')
  })

  it('floors a non-zero sub-minute reading at <1 min rather than printing 0', () => {
    // Unreachable while both intervals are whole minutes, but `PLUGIN_POLL_PERIOD_SECONDS` is the
    // user-settable one: a sub-minute interval would make a single poll render as "0 min", the same
    // defect the deleted `<0.1` floor existed to prevent.
    expect(formatClientTime(0.4, 'session')).toBe('<1 min of session time')
    expect(formatClientTime(0, 'session')).toBe('0 min of session time')
  })

  it('is integers only — no fractional objects, no decimals to parse', () => {
    for (const m of [0, 1, 59, 60, 1044, 4020, 100000]) {
      expect(formatClientTime(m, 'browser')).toMatch(/^\d+( min|h) of browser time$/)
    }
  })

  it('lets a total exceed 24h — it is the SUM across concurrent clients', () => {
    // Not an error state: more than 24h inside a 24h window is what concurrent clients produce. Uses a
    // sub-hour remainder so this is a distinct input rather than a restatement of the 4020 case above.
    expect(formatClientTime(2010, 'browser')).toBe('34h of browser time')
  })
})

describe('readStatuslinePolls (#1293 Part F)', () => {
  const counts = { serverRenderTotal: 165, legacyProxy: 3, total: 168 }

  it('carries the counts with an ok verdict', () => {
    expect(readStatuslinePolls(counts)).toEqual({ verdict: 'ok', counts })
  })

  it('flags a wholly quiet window as `zero` while keeping the counts', () => {
    // The reading the operator's own statusline used to make impossible. They disabled it to measure
    // external usage, so this is now the expected shape — and it must stay distinguishable from a dead
    // recorder, which produces the identical row.
    const quiet = { serverRenderTotal: 0, legacyProxy: 0, total: 0 }
    expect(readStatuslinePolls(quiet)).toEqual({ verdict: 'zero', counts: quiet })
  })

  it('keys `zero` on serverRenderTotal, not on total — a legacy cohort cannot certify it', () => {
    // `total` folds in `legacyProxy`, the pre-#918 jq-snippet cohort the operator never disabled. Keying
    // on it would let a still-ticking legacy cohort file a `serverRenderTotal` of zero as unambiguous —
    // and that is the one number the operator-exclusion window exists to read. Legal under the sum
    // invariant, so this fixture is reachable.
    const legacyOnly = { serverRenderTotal: 0, legacyProxy: 9888, total: 9888 }
    expect(readStatuslinePolls(legacyOnly)).toEqual({ verdict: 'zero', counts: legacyOnly })
  })

  it('reports an unreadable read as failed', () => {
    expect(readStatuslinePolls(null)).toEqual({ verdict: 'failed', counts: null })
    expect(readStatuslinePolls(undefined)).toEqual({ verdict: 'failed', counts: null })
  })

  it('rejects a corrupt shape rather than storing it in a no-TTL row', () => {
    for (const bad of [
      { serverRenderTotal: Number.NaN, legacyProxy: 0, total: 0 },
      { serverRenderTotal: -1, legacyProxy: 0, total: 0 },
      { serverRenderTotal: 5, legacyProxy: 0, total: 0 },   // total disagrees with its components
      { legacyProxy: 0, total: 0 },                          // a field missing entirely
    ]) {
      expect(readStatuslinePolls(bad as never)).toEqual({ verdict: 'failed', counts: null })
    }
  })

  it('drops the rendered `delta` AND the per-preset breakdown — only the totals are stored', () => {
    // Two things must not reach a permanent, no-TTL, whole-value-rewrite key. `delta` is a presentation
    // value derived from yesterday's snapshot. `byPreset` is worse: its keys are WAE `index1` values,
    // and the legacy `?src=` path writes that index straight from a caller-supplied query parameter
    // with no allowlist, so the key space is unbounded and externally controlled. A wide enough map
    // pushes the month's value past the per-value cap, the put fails, and the whole series stops.
    const wide: Record<string, number> = {}
    for (let i = 0; i < 500; i++) wide[`statusline-junk${i}`] = 1
    const hostile = { ...counts, byPreset: wide, delta: { serverRender: 5, legacyProxy: null } }
    const read = readStatuslinePolls(hostile as never)
    expect(read.counts).toEqual({ serverRenderTotal: 165, legacyProxy: 3, total: 168 })
    expect(read.counts).not.toHaveProperty('byPreset')
    expect(read.counts).not.toHaveProperty('delta')
    // The stored value's size must not scale with attacker-controlled input.
    expect(JSON.stringify(read.counts).length).toBeLessThan(100)
  })

  it('returns a fresh object so a later mutation cannot rewrite a stored row', () => {
    const src = { serverRenderTotal: 1, legacyProxy: 0, total: 1 }
    const read = readStatuslinePolls(src)
    src.total = 999
    src.serverRenderTotal = 999
    expect(read.counts).toEqual({ serverRenderTotal: 1, legacyProxy: 0, total: 1 })
  })

  it('does NOT derive a client count — a statusline has no poll interval', () => {
    // The extension and plugin monitor poll on a timer, so their totals divide by a known rate. A
    // statusline renders on Claude Code events, so no divisor exists and none may be invented.
    expect(readStatuslinePolls(counts)).not.toHaveProperty('clients')
  })
})

// The Worker cannot import the extension bundle or the monitor shell script, so both poll periods are
// duplicated as constants. That duplication is only safe while something fails when it drifts — the
// same lockstep treatment `feed-slug-sync` gives its own copied list. Without this, changing the
// extension's alarm silently turns every RENDERED running-time figure into a wrong number (the row
// stores raw counts, so the stored record is unaffected), and nothing would say so.
describe('poll-period lockstep with the shipped clients (#1293)', () => {
  const repoRoot = join(__dirname, '..', '..', '..')

  it('EXT_POLL_PERIOD_MINUTES matches extension/config.js', () => {
    const src = readFileSync(join(repoRoot, 'extension', 'config.js'), 'utf8')
    const m = src.match(/export\s+const\s+POLL_PERIOD_MINUTES\s*=\s*(\d+(?:\.\d+)?)/)
    expect(m, 'POLL_PERIOD_MINUTES not found in extension/config.js — the constant moved or was renamed').not.toBeNull()
    expect(Number(m![1])).toBe(EXT_POLL_PERIOD_MINUTES)
  })

  it('PLUGIN_POLL_PERIOD_SECONDS matches the aiwatch-monitor.sh default', () => {
    const src = readFileSync(join(repoRoot, 'plugin', 'aiwatch', 'bin', 'aiwatch-monitor.sh'), 'utf8')
    const m = src.match(/INTERVAL="\$\{AIWATCH_POLL_SECONDS:-(\d+)\}"/)
    expect(m, 'the AIWATCH_POLL_SECONDS default was not found in aiwatch-monitor.sh').not.toBeNull()
    expect(Number(m![1])).toBe(PLUGIN_POLL_PERIOD_SECONDS)
  })
})
