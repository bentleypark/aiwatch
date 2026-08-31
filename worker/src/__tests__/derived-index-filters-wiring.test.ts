import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * #1292 — `worker/src/index.ts` carries five `derived` guards (four literal, one forwarding) and had NO test of any kind.
 *
 * The consumer registry's grep was satisfied by the two doc COMMENTS beside them (round 12's finding),
 * and `derived-tag-sync` reaches this file only through the projection. Deleting any one filter —
 * including the `/feed` one whose own comment says the KV read below it FAILS OPEN, and would emit a
 * burst of backdated recoveries to every subscriber — left the whole suite green.
 *
 * Source-scan, matching the established pattern in this directory (`cache-reseed-wiring`,
 * `growth-outage-axis-wiring`, `feed-poll-instrumentation-wiring`): these live inside the request and
 * cron handlers, which no unit test drives. It pins that the guards EXIST at their call sites; what
 * each one does is behaviour tested where the callee is testable (`rss.ts`, `recovery-mark.ts`).
 */
const SRC = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8')
// Comments stripped: the whole point is that prose was standing in for code.
const CODE = SRC.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')

describe('#1292 — index.ts routes every derived-incident path through a guard', () => {
  it('skips the permanently-absent KV probes on both /feed loops', () => {
    // A synthesized incident never had an `ai:analysis:` or an `alerted:new:` key, so these reads are
    // guaranteed misses. The second loop's read fails OPEN, so without the guard a service whose feed
    // died would emit up to 30 backdated "resolved" items at once.
    const feedGuards = CODE.match(/\.filter\(\(i\) => i\.status [^)]*i\.derived !== 'status_history'\)/g) ?? []
    expect(feedGuards.length, 'both /feed loops must skip derived incidents').toBe(2)
  })

  it('skips the guaranteed-miss recovered: probe on both status paths', () => {
    // `/api/status` and `/api/status/cached`. A full-day bucket "resolves" at the next day's local
    // anchor, so it enters the 3h recently-recovered window for ~3h every day, per bucket.
    const probeGuards = CODE.match(/i\.derived !== 'status_history' && i\.resolvedAt/g) ?? []
    expect(probeGuards.length, 'both status paths must skip the probe').toBe(2)
  })

  it('forwards BOTH halves of the pair on the public /api/v1/status/:id projection', () => {
    // The one public projection. Forwarding the tag without the day publishes the anchor's date.
    expect(CODE).toMatch(/derived: i\.derived, derivedDay: i\.derivedDay/)
  })

  it('the scan is not vacuous — it finds the tag in CODE, not only in prose', () => {
    // Exactly four literal comparisons: the two /feed loops and the two status-path probes. The fifth
    // guard is the projection, which forwards `i.derived` without naming the literal. Pinned rather
    // than floored, because the failure this file exists for is the scan going quiet. (The doc
    // comments beside these guards write the tag in backticks, so they never match this pattern —
    // it is the REGISTRY's looser grep that they satisfied.)
    const inCode = (CODE.match(/'status_history'/g) ?? []).length
    expect(inCode, 'index.ts must branch on the tag in executable code').toBe(4)
  })
})
