import { describe, it, expect } from 'vitest'
import { SERVICES } from '../services'
import { FEED_TARGET_IDS, feedSlug } from '../rss'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { feedTarget, FEED_ALL_TARGET, FEED_UNKNOWN_TARGET } from '../api-traffic'

// #1273 — the seams around the feed-poll dimensions that a pure-function test cannot reach.
//
// ALREADY COVERED WITHOUT THIS FILE, and deliberately not re-asserted:
//   - Dropping an argument at the record call site, or dropping `feedPolls` from the growth row
//     inputs, is a TYPE error: `recordFeedTraffic`'s `slugToId`/`userAgent` and
//     `GrowthDailyInputs.feedPolls` are REQUIRED, so `tsc` names the call site rather than the
//     dimension silently going empty (#970).
//   - Passing the WHOLE URL where the path belongs is now also a type error: `recordFeedTraffic`
//     takes a `URL`. As a `string` pathname it was not — `request.url` type-checked, satisfied every
//     assertion in this file, and passed 4615 tests while pinning blob1 to `feed-service` and blob2
//     to `__unknown__` forever. A guard tsc can hold does not belong in a source scan.
//   - Which verdict `readFeedPolls` returns, and what it stores alongside, is a pure function
//     unit-tested in api-traffic.test.ts. What it is CALLED WITH is not — see the source scan below.
//   - The null-vs-map-vs-absent serialization is asserted at the `kv.put` boundary in
//     growth-series.test.ts; the render path in daily-summary.test.ts.
//
// WHAT IS LEFT is two things a type cannot see, and the second is why the source scan is back.
//
// 1. `FEED_TARGET_IDS` is a module-level Map, and `recordFeedTraffic`'s required-parameter design
//    cannot see whether the map it received has any CONTENTS.
// 2. Required parameters catch an OMITTED argument; they cannot catch a typed-but-inert one. Passing
//    `new Map()`, or `null` for the user-agent, or writing `feedPolls: null` outright, all type-check
//    and all leave the whole dimension permanently empty — and an empty result is indistinguishable
//    from "no subscribers", so nothing downstream can notice either. #1117's axis has the same shape
//    and guards it the same way (`growth-outage-axis-wiring.test.ts`); this follows that precedent
//    rather than inventing a second one.
//
// KNOWN LIMIT, restated from #1117: a source scan cannot tell a correct source from a plausible wrong
// one. It pins that the wiring exists, not that it is right. That is what the issue's `verify-after`
// against the real `growth:daily` row is for.
const SRC = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')
// Strip comments so a mutation cannot hide behind a mention of the token it removed (#1117's lesson).
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .map((l) => l.replace(/\s\/\/.*$/, ''))
  .join('\n')

describe('#1273 feed-poll call-site wiring', () => {
  it('records every poll with the target map and the REQUEST user-agent', () => {
    // Bounded, not slice-to-EOF: an unbounded window is satisfied by any later occurrence in the
    // file, so the assertions would go vacuous with no signal. Same shape as the #1117 precedent.
    const start = CODE.indexOf('recordFeedTraffic(')
    const call = CODE.slice(start, CODE.indexOf('\n', start))
    expect(call).toContain('FEED_TARGET_IDS')
    expect(call).toMatch(/request\.headers\.get\(\s*['"]user-agent['"]\s*\)/i)
  })

  it('judges the read AFTER the query runs, not before it', () => {
    // ORDER is the property, so order is what gets asserted. The previous version of this test
    // scanned for the presence of `readFeedPolls(feedTraffic)` — copying the spelling of the
    // assertion below, which is immune for a reason that does not transfer: that call sits welded
    // inside the `buildGrowthDailyRow({ … })` literal, so hoisting it necessarily rewrites the text.
    // A free-standing `const` carries no such anchor, and moving it above the query left every
    // character intact: the whole suite and tsc passed while every day logged "read FAILED" forever
    // and the two live verdicts became dead code. Restructuring does not help either — any shape
    // that keeps a `const` here is hoistable without changing a byte a scan can see.
    const query = CODE.indexOf('feedTraffic = await queryFeedTraffic')
    const judge = CODE.indexOf('readFeedPolls(feedTraffic)')
    expect(query, 'no queryFeedTraffic call').toBeGreaterThan(-1)
    expect(judge, 'no readFeedPolls call').toBeGreaterThan(-1)
    expect(judge, 'readFeedPolls runs before the query it judges').toBeGreaterThan(query)
  })

  it('stores the judged value, and gives each verdict its own message', () => {
    // `feedPolls: { verdict: 'ok', polls: {} }` type-checks and leaves the permanent series empty
    // forever; so does feeding it a different read.
    expect(CODE).toMatch(/feedPolls:\s*feedRead,/)
    // Pairing matters as much as presence: swapping which verdict owns which message names the wrong
    // cause on the wrong day, and a bare `toContain` of each string cannot see that. The window ends
    // at the next branch, or at the closing brace of the chain when there is no later `} else if` in
    // the file — not at the first `}`, since a message that interpolates before its literal would
    // fall outside that.
    for (const [verdict, message] of [
      ['failed', 'feedPolls read FAILED'],
      ['zero', 'feedPolls read 0 polls'],
      ['unclassifiable', 'feedPolls read no servable feed'],
    ] as const) {
      const at = CODE.indexOf(`feedRead.verdict === '${verdict}'`)
      expect(at, `no branch for verdict ${verdict}`).toBeGreaterThan(-1)
      const nextBranch = CODE.indexOf('} else if', at + 1)
      const chainEnd = CODE.indexOf('\n          }', at + 1)
      const end = nextBranch === -1 ? chainEnd : Math.min(nextBranch, chainEnd)
      expect(end, `cannot bound the ${verdict} branch`).toBeGreaterThan(at)
      expect(CODE.slice(at, end), `verdict ${verdict} does not own ${message}`).toContain(message)
    }
  })
})

describe('FEED_TARGET_IDS ↔ the paths the feed handler actually serves (#1273)', () => {
  it('classifies every served per-service feed path to its canonical service id', () => {
    // `resolveFeedService` (rss.ts) accepts BOTH the slug and the raw id, so both must classify —
    // a path the handler SERVES must never be recorded as an unknown target.
    for (const svc of SERVICES) {
      expect(feedTarget(`/feed/${feedSlug(svc.id)}`, FEED_TARGET_IDS)).toBe(svc.id)
      expect(feedTarget(`/feed/${svc.id}`, FEED_TARGET_IDS)).toBe(svc.id)
    }
  })

  it('maps distinct services to distinct ids (no slug↔id collision misattributes a poll)', () => {
    // `new Map(flatMap)` is last-wins: a future IS_DOWN_SLUG_OVERRIDE value equal to another
    // service's id would repoint that key while the handler still serves the original.
    const ids = new Set(SERVICES.map((s) => s.id))
    expect(ids.size).toBe(SERVICES.length)
    for (const [key, id] of FEED_TARGET_IDS) {
      const owner = SERVICES.find((s) => s.id === key || feedSlug(s.id) === key)
      expect(owner, `no service owns feed key ${key}`).toBeDefined()
      expect(id).toBe(owner!.id)
    }
  })

  it('neither sentinel collides with a real service id or slug', () => {
    // Both constants document this; nothing enforced it.
    for (const sentinel of [FEED_ALL_TARGET, FEED_UNKNOWN_TARGET]) {
      expect(FEED_TARGET_IDS.has(sentinel)).toBe(false)
      expect(SERVICES.some((s) => s.id === sentinel || feedSlug(s.id) === sentinel)).toBe(false)
    }
  })
})
