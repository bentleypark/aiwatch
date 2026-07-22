import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #1117 — source-scan wiring guard, in the repo's sync-test idiom (ai-usage-wiring / api-tier-sync /
// feed-slug-sync).
//
// WHAT THIS IS NOT: proof that the axis is correct in production. Nothing in this repo invokes the
// cron `scheduled` handler, so the daily-summary path has no behavioural harness — which is why this
// issue ships with a `verify-after` against the real KV row. The counting and backfill folds
// themselves (`countIncidentsInWindow` / `fillOutageWindows` / `previousPeriod` /
// `periodsCoveringWindow`) are behaviourally tested in growth-series.test.ts.
//
// WHAT THIS IS: a guard on the WIRING between those folds and the one call site, which is the half a
// pure-function test cannot see. The bug being fixed was ITSELF a wiring bug — the fold was fine, the
// call site handed it a 9-hour-old counter — so the regressions worth guarding are all at this seam:
//
//   1. The window axis silently stops being written (the `outage:` input dropped from the row build),
//      leaving the series back on the 00:00–09:00 counter with every test still green.
//   2. The backfill closure is dropped or made unreachable, so older rows never fill and the
//      retroactive half of the fix quietly does nothing.
//   3. Only the current month is read, or the previous one is derived with `Date`-mutating arithmetic
//      (`setUTCMonth(-1)` overflows on the 29th–31st and yields the current month back). Either way the
//      first row of a month undercounts against a key that was never read.
//   4. Coverage stops being tracked, so an absent month key counts as zero incidents and a fabricated
//      quiet day is frozen into a permanent row.
//   5. The suppression list stops being read fail-CLOSED, so a KV blip bakes pre-suppression counts
//      into a record documented as post-suppression.
//   6. The live window stops being anchored on the run instant, silently re-misaligning the outage
//      axis from the `audience*` fields it exists to be comparable with.
//   7. A month value is credited as covered without a shape check — `JSON.parse` succeeds on `null` /
//      `[]` / `{}` and every layer below tolerates them, so a truncated write reads as a quiet month.
//   8. The two month reads share one try, so a corrupt PREVIOUS month (never repaired — only the
//      current month is re-accumulated) disables the axis for every remaining day of the month.
//   9. A failure is left unreported, in a dataset with no reader to notice it — the axis then goes
//      absent for a whole month and those rows become unfillable at the rollover.
//
// KNOWN LIMIT of a source scan: it cannot tell a correct source from a plausible wrong one. Repointing
// the axis at `alertCounts.incidents` would satisfy every assertion here — that is exactly the #1055
// mistake, and only the issue's `verify-after` against the real KV row can catch it.
//
// Guards default to passing, so every assertion below was mutation-verified in BOTH directions —
// each one was made to fail by editing index.ts, then restored (the mutations are listed in the PR).
// Assertions are made against `BLOCK` with line comments stripped, so a token surviving only inside a
// `//` comment — or elsewhere in index.ts — cannot satisfy them.

const INDEX = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')

/** The growth-series write block: the #1117 outage-window read through the recordGrowthDaily call. */
const BLOCK = (() => {
  const start = INDEX.indexOf('let outageWindow')
  const end = INDEX.indexOf("console.warn('[growth-series] append failed:", start)
  expect(start, 'the #1117 outage-window block must exist in index.ts').toBeGreaterThan(-1)
  expect(end, 'the growth-series write must follow the outage-window block').toBeGreaterThan(start)
  return INDEX.slice(start, end)
})()

/**
 * Code only — a claim that survives solely as prose is not wiring. Strips BLOCK comments first, then
 * whole-line and trailing line comments: each of those three spellings was shown to hide a mutation
 * from a `toContain` during review (`/* if (…) return null *\/` was the one that survived longest).
 * The leading-whitespace requirement on the line-comment strip keeps `https://`-style tokens intact.
 */
const CODE = BLOCK.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .map((l) => l.replace(/\s\/\/.*$/, ''))
  .join('\n')

describe('#1117 growth outage-axis wiring', () => {
  it('feeds the counted window into the row build', () => {
    expect(CODE).toContain('countIncidentsInWindow(')
    expect(CODE).toMatch(/outage:\s*outageWindow,/)
  })

  // Not just "the token appears": the closure must be the actual argument of the write call, so a
  // `false && outageSources ? … : undefined` short-circuit cannot pass.
  it('passes the backfill pass to recordGrowthDaily so older rows fill retroactively', () => {
    const call = CODE.slice(CODE.indexOf('recordGrowthDaily('))
    expect(call).toContain('fillOutageWindows(')
    expect(call).toContain('nominalWindowEnd(')
    expect(call).toMatch(/\}\),\s*backfillSources\s*\n/)
  })

  // A window on the 1st of a month reaches into the previous month's key — and the arithmetic must be
  // the string helper, never `setUTCMonth`, which overflows on the 29th–31st.
  it('reads BOTH month keys, with overflow-safe period arithmetic', () => {
    expect(CODE).toContain('previousPeriod(today.slice(0, 7))')
    expect(CODE).toContain('incidents:monthly:${period}')
    expect(CODE).not.toMatch(/setUTCMonth/)
  })

  // `kv.get` returns null for an absent key WITHOUT throwing, so the catch cannot see it.
  it('tracks which months actually parsed and refuses to count an uncovered window', () => {
    expect(CODE).toContain('covered.add(period)')
    expect(CODE).toContain('periodsCoveringWindow(windowEnd)')
  })

  // `JSON.parse` succeeds on `null` / `[]` / `{}`, and every layer below tolerates those — so the cast
  // alone would let a truncated write be credited as a covered, empty (i.e. quiet) month.
  it('shape-checks a parsed month AND short-circuits before crediting coverage', () => {
    const credit = CODE.slice(0, CODE.indexOf('covered.add(period)'))
    expect(credit).toContain('const parsed: unknown = JSON.parse(raw)')
    expect(credit).toMatch(/typeof \(parsed as MonthlyIncidents\)\.services !== 'object'/)
    // Deleting just the `continue` is type-valid and would let a shapeless month be credited as a
    // covered, empty (i.e. quiet) month — so bind the bail-out to the shape branch, not its existence.
    expect(credit).toMatch(/month left UNCOVERED[^\n]*\)\s*\n\s*parsedMonths\.push\(null\)\s*\n\s*continue/)
  })

  // A corrupt PREVIOUS-month key is never repaired (only the current month is re-accumulated), so a
  // shared try would disable the axis for the rest of the month and freeze those rows at rollover.
  it('gives each month its own try so one bad key cannot disable the axis', () => {
    const loop = CODE.slice(CODE.indexOf('for (const period of periods)'), CODE.indexOf('outageSources = parsedMonths'))
    expect(loop).toMatch(/try \{/)
    expect(loop).toMatch(/catch \(err\)/)
    expect(loop).toContain('month left UNCOVERED')
  })

  // Both paths decide coverage with the SAME predicate, spelled the same way — `[].every()` is true,
  // so the length check is what stops an unparseable window from counting as covered.
  it('gates the live path and the backfill on the same coverage predicate', () => {
    expect(CODE).toMatch(/livePeriods\.length && livePeriods\.every\(\(p\) => covered\.has\(p\)\)/)
    expect(CODE).toMatch(/if \(!periods\.length \|\| !periods\.every\(\(p\) => covered\.has\(p\)\)\) return null/)
  })

  // The axis has no reader yet, so an unreported failure would surface only after the month rolled
  // over and the rows became unfillable.
  it('says so, every day, when the axis could not be counted', () => {
    expect(CODE).toContain('outage axis ABSENT for')
    expect(CODE).toMatch(/if \(!wrote\) console\.error/)
  })

  // Parity with the reports — and fail-CLOSED, because the value is persisted and never recomputed.
  it('reads the suppression list fail-closed and always filters with it', () => {
    expect(CODE).toContain('readSuppressionsFreshOrNull(')
    expect(CODE).not.toContain('readSuppressionsFresh(env.STATUS_CACHE)')
    expect(CODE).toMatch(/if \(suppressions === null\) throw/)
    // The line that pushes a PARSED month (not the `push(null)` for an absent key) must route it
    // through the filter — asserting the token merely appears somewhere would pass on a commented-out
    // call or a filter applied to something else.
    const pushes = CODE.split('\n').filter((l) => l.includes('parsedMonths.push(') && !l.includes('push(null)'))
    expect(pushes, 'exactly one push of a parsed month is expected').toHaveLength(1)
    expect(pushes[0]).toContain('filterSuppressedFromMonthly(')
  })

  // The premise of the fix: this axis and the audience fields describe the same 24h span.
  it('anchors the live window on the run instant', () => {
    expect(CODE).toMatch(/const windowEnd = new Date\(\)\.toISOString\(\)/)
  })

  // A throw must cost the axis, never the Discord report or the rest of the row.
  it('isolates its own failure', () => {
    expect(CODE).toContain("console.warn('[growth-series] outage window read failed:")
  })

  // The old counter stays — a narrower true fact. Silently repointing a field at a new source under
  // its old name is the #1055 `direct`-bucket mistake.
  it('keeps the legacy alert counter in the row alongside the new axis', () => {
    expect(CODE).toMatch(/^\s*alertCounts,$/m)
  })
})
