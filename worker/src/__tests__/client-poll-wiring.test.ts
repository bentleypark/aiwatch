import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #1293 — the `index.ts` seam for the three client poll counters, in the idiom
// `feed-poll-instrumentation-wiring.test.ts` established for the identical #1273 seam.
//
// ALREADY COVERED WITHOUT THIS FILE, and deliberately not re-asserted:
//   - Dropping `extPolls`/`pluginPolls` from the growth-row inputs is a TYPE error:
//     `GrowthDailyInputs` declares both REQUIRED, so `tsc` names the call site rather than the
//     dimension silently going absent (#970).
//   - Which verdict `readExtPolls`/`readPluginPolls` return, and what they store alongside, are pure
//     functions unit-tested in client-polls.test.ts. What they are CALLED WITH is not.
//
// WHY THE ORDER ASSERTION EXISTS, in the words of the #1273 file that learned it: a free-standing
// `const` "carries no such anchor, and moving it above the query left every character intact: the
// whole suite and tsc passed while every day logged 'read FAILED' forever and the two live verdicts
// became dead code." #1293 adds three more consts of exactly that shape, writing into the same
// permanent, no-TTL, un-backfillable key. A hoist here is silent, green, and unrecoverable.
//
// KNOWN LIMIT, restated: a source scan pins that the wiring EXISTS, not that it is right. That is
// what the issue's `verify-after` against the real `growth:daily` row is for.
const SRC = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')
// Strip comments so a mutation cannot hide behind a mention of the token it removed.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .map((l) => l.replace(/\s\/\/.*$/, ''))
  .join('\n')

describe('#1293 client-poll call-site wiring', () => {
  it('judges the ext read AFTER its query runs, not before it', () => {
    const query = CODE.indexOf('extPolls = await queryExtTraffic')
    const judge = CODE.indexOf('readExtPolls(extPolls)')
    expect(query, 'no queryExtTraffic assignment').toBeGreaterThan(-1)
    expect(judge, 'no readExtPolls(extPolls) call').toBeGreaterThan(-1)
    expect(judge, 'readExtPolls runs before the query it judges').toBeGreaterThan(query)
  })

  it('judges the plugin read AFTER its query runs, not before it', () => {
    const query = CODE.indexOf('pluginTraffic = await queryPluginTraffic')
    const judge = CODE.indexOf('readPluginPolls(pluginTraffic)')
    expect(query, 'no queryPluginTraffic assignment').toBeGreaterThan(-1)
    expect(judge, 'no readPluginPolls(pluginTraffic) call').toBeGreaterThan(-1)
    expect(judge, 'readPluginPolls runs before the query it judges').toBeGreaterThan(query)
  })

  it('judges the statusline read AFTER its query runs, not before it', () => {
    const query = CODE.indexOf('queryStatuslineTraffic(')
    const judge = CODE.indexOf('readStatuslinePolls(statuslineCounts)')
    expect(query, 'no queryStatuslineTraffic call').toBeGreaterThan(-1)
    expect(judge, 'no readStatuslinePolls(statuslineCounts) call').toBeGreaterThan(-1)
    expect(judge, 'readStatuslinePolls runs before the query it judges').toBeGreaterThan(query)
  })

  it('emits a ZERO line for every counter, not only a FAILED one', () => {
    // Deleting the whole loop, or just one counter's entry, was green. Its own comment says that
    // without it the verdict exists only in a row nothing reads yet — and inside the operator-exclusion
    // window, where zero is the expected reading, that means no daily signal at all.
    expect(CODE).toContain('read ZERO for')
    for (const name of ['extPolls', 'pluginPolls', 'statuslinePolls']) {
      expect(CODE, `${name} is missing from the zero-warn loop`).toContain(`['${name}',`)
    }
  })

  it('captures the pure statusline counts from the query result', () => {
    // An extra hop nothing else pins: `statuslineCounts` is assigned FROM the query result, whereas
    // `extPolls`/`pluginTraffic` ARE the query assignments, so the ordering assertions have nothing to
    // bite on here. Deleting this one line type-checks (the local is `T | null = null` and simply never
    // reassigned) and leaves every other assertion in this file green, while writing `failed`/`null`
    // forever into a key with no backfill.
    expect(CODE).toMatch(/statuslineCounts\s*=\s*counts/)
  })

  it('stores the statusline COUNTS, not the render local that carries a delta', () => {
    // `statuslineTraffic` is `{...counts, delta}`. Passing it would put a presentation value into a
    // permanent row; `statuslineCounts` is the same read without it.
    expect(CODE).toContain('readStatuslinePolls(statuslineCounts)')
    expect(CODE).not.toContain('readStatuslinePolls(statuslineTraffic)')
  })

  it('stores the judged reads, not a fresh literal', () => {
    // `extPolls: { verdict: 'failed', polls: null }` type-checks and writes a permanent null forever.
    expect(CODE).toMatch(/extPolls:\s*extRead,/)
    expect(CODE).toMatch(/pluginPolls:\s*pluginRead,/)
    expect(CODE).toMatch(/statuslinePolls:\s*statuslineRead,/)
  })

  it('judges each counter from its OWN local', () => {
    // `readExtPolls(pluginTraffic?.monitor)` type-checks and would file the plugin's volume as the
    // extension's, in a key nothing can repair.
    expect(CODE).toContain('readExtPolls(extPolls)')
    expect(CODE).toContain('readPluginPolls(pluginTraffic)')
  })

  it('writes the WAE tags from the shared constants, never a re-inlined literal', () => {
    // The three tags are exported constants so a rename is a compile error rather than a silent kill
    // of the counter. That only holds while the write sites use the imports: re-inlining
    // `indexes: ['ext-claude']` type-checks and passes every other test, and silently decouples the
    // reader from the writer again — which is the drift the extraction was done to end.
    for (const literal of ["'ext-claude'", "'aiwatch-monitor'", "'aiwatch-brief'"]) {
      expect(
        CODE.includes(`indexes: [${literal}]`) || CODE.includes(`blobs: [${literal}]`),
        `a WAE tag is written as the bare literal ${literal} instead of the shared constant`,
      ).toBe(false)
    }
    expect(CODE).toContain('indexes: [EXT_INDEX]')
    expect(CODE).toContain('indexes: [PLUGIN_MONITOR_INDEX]')
    expect(CODE).toContain('indexes: [PLUGIN_BRIEF_INDEX]')
  })

  it('names the right client in each failure warning', () => {
    // Swapping the two messages reports the wrong client on the wrong day, and the log is the only
    // signal this series has until it grows a reader.
    //
    // POSITION, not a sliced "branch body". Slicing to the next `}` looks right and is not: the first
    // `}` after the branch opens belongs to the `${today}` interpolation inside the message, so the
    // window is bounded by an accident of where the date sits in the sentence. It happens to work
    // today; rewording either message to lead with the date would fail on correct code, and the
    // obvious repair — widening the window — would swallow BOTH messages and make the swap it exists
    // to catch pass silently. So assert the ordering directly instead.
    const extWarn = CODE.indexOf("extRead.verdict === 'failed'")
    const pluginWarn = CODE.indexOf("pluginRead.verdict === 'failed'")
    expect(extWarn, 'no ext failure branch').toBeGreaterThan(-1)
    expect(pluginWarn, 'no plugin failure branch').toBeGreaterThan(-1)
    // Each branch's FIRST FOLLOWING message must be its own. Relative to each branch, not to the file:
    // pinning `extWarn < pluginWarn` would also fail if someone swapped the two `if` blocks, which is a
    // semantically neutral edit — a test that reddens on a correct change teaches people to widen it.
    // `indexOf` returns -1 for "not found", which compares as SMALLER than any real index and would
    // redden a correct file. `after()` maps a miss to +infinity, which is what "this branch never
    // reaches the other counter's message" actually means. Both directions need it — guarding only one
    // is what made the earlier version still fail on a neutral if-block swap.
    const after = (needle: string, from: number): number => {
      const i = CODE.indexOf(needle, from)
      return i === -1 ? Number.MAX_SAFE_INTEGER : i
    }
    expect(
      after('extPolls read FAILED', extWarn),
      'the ext branch does not reach its own message first',
    ).toBeLessThan(after('pluginPolls read FAILED', extWarn))
    expect(
      after('pluginPolls read FAILED', pluginWarn),
      'the plugin branch does not reach its own message first',
    ).toBeLessThan(after('extPolls read FAILED', pluginWarn))
    // The third counter's warn, added with Part F. Swapping its message with either of the others
    // would name the wrong client on the wrong day, and nothing else in the suite would notice.
    const slWarn = CODE.indexOf("statuslineRead.verdict === 'failed'")
    expect(slWarn, 'no statusline failure branch').toBeGreaterThan(-1)
    expect(
      after('statuslinePolls read FAILED', slWarn),
      'the statusline branch does not reach its own message first',
    ).toBeLessThan(Math.min(after('extPolls read FAILED', slWarn), after('pluginPolls read FAILED', slWarn)))
  })
})
