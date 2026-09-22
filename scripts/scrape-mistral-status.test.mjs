import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withRetry, buildUptimeEntry, envPositiveInt, readComponentRow } from './scrape-mistral-status.mjs'

// #1381 — `withRetry` is the only pure thing in the scraper, and it is the part that decides whether a
// lost read becomes a missing incident. Reads from this page are lossy under rate limiting, so a
// regression here does not throw — it quietly under-reports, which downstream reads as a quieter month.

test('returns the first success without waiting', async () => {
  const slept = []
  const out = await withRetry(async () => 'ok', { sleep: async (ms) => slept.push(ms) })
  assert.equal(out, 'ok')
  assert.deepEqual(slept, [], 'a first-try success must not sleep')
})

test('retries a transient failure and returns the eventual success', async () => {
  let calls = 0
  const slept = []
  const out = await withRetry(async () => {
    calls++
    if (calls < 3) throw new Error('flaky')
    return 'ok'
  }, { sleep: async (ms) => slept.push(ms) })
  assert.equal(out, 'ok')
  assert.equal(calls, 3)
  assert.deepEqual(slept, [300, 600], 'backoff is linear in the attempt number')
})

test('throws the LAST error once attempts are exhausted, so the caller can count the loss', async () => {
  let calls = 0
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error(`fail-${calls}`) }, { sleep: async () => {} }),
    /fail-4$/,
  )
  assert.equal(calls, 4, 'default is four attempts')
})

test('does not sleep after the final attempt', async () => {
  const slept = []
  await assert.rejects(withRetry(async () => { throw new Error('nope') }, {
    attempts: 3, sleep: async (ms) => slept.push(ms),
  }))
  assert.equal(slept.length, 2, 'three attempts means two waits, not three')
})

test('a falsy-but-valid result is returned rather than retried', async () => {
  // The failure mode a truthiness check would introduce: an empty update list is a real answer.
  let calls = 0
  const out = await withRetry(async () => { calls++; return '' }, { sleep: async () => {} })
  assert.equal(out, '')
  assert.equal(calls, 1)
})

test('backs off an ORDER OF MAGNITUDE further on a 429 than on a generic failure', async () => {
  // A 429 is the server asking for a slower rate, so the backoff a timeout deserves is the wrong
  // answer — it spends the next slot on another rejection. Measured: a full run (93 tooltips plus
  // incident pages) earns 429s, and those losses are what made the Worker withhold uptime entirely.
  const slept = []
  await assert.rejects(withRetry(async () => { throw new Error('HTTP 429') }, {
    attempts: 3, delayMs: 300, rateLimitMs: 5000, sleep: async (ms) => slept.push(ms),
  }))
  assert.deepEqual(slept, [5000, 10000])
})

test('a non-429 failure keeps the short backoff — the two paths must not collapse', async () => {
  const slept = []
  await assert.rejects(withRetry(async () => { throw new Error('net::ERR_TIMED_OUT') }, {
    attempts: 3, delayMs: 300, rateLimitMs: 5000, sleep: async (ms) => slept.push(ms),
  }))
  assert.deepEqual(slept, [300, 600])
})

test('429 is matched as a status token, not as any occurrence of the digits', async () => {
  // "1429ms" or a body containing 429 must not trigger the long wait; only the status does.
  const slept = []
  await assert.rejects(withRetry(async () => { throw new Error('timeout after 1429ms') }, {
    attempts: 2, delayMs: 300, rateLimitMs: 5000, sleep: async (ms) => slept.push(ms),
  }))
  assert.deepEqual(slept, [300])
})

// ── the pushed payload's SHAPE ──────────────────────────────────────────────────────────────────
// This block exists because of a defect it would have caught: `unreadBars` was added to the
// browser-side derivation and to the Worker's reader, with a unit test on the Worker half, and was
// never added to the object the scraper pushes. Both halves were green for a full round while
// production sent a payload missing the field.
//
// The first version of this guard parsed `RootlyUptimeComponent`'s field names out of the Worker's
// source with a regex. It was deleted rather than extended: review showed it missed a nested rename
// (`coverage.fetched`), a member modifier (`readonly`), a sibling interface, and every type change —
// a hand-written parser of an unbounded input, which this repo has a standing rule against. The
// contract is enforced where it is consumed instead: `isStorableRootlyFeed` shape-checks every
// uptime entry and REFUSES the push, so a producer that drops or mistypes a field fails in
// production, not only in CI. The round-trip assertion — that the gate accepts what this function
// emits — lives in `worker/src/parsers/__tests__/rootly.test.ts`, because node's test runner cannot
// resolve the Worker's TS imports. What is left here is the producer's side of that contract.
test('buildUptimeEntry carries the values through, not just the keys', () => {
  // A key present but always zero/empty would satisfy a presence check while losing the reading.
  const entry = buildUptimeEntry(
    { componentId: 'c1', barCount: 91, unreadBars: 2, impacted: [3, 7] },
    [{ date: 'Sep 5, 2026', label: 'x', segments: [] }],
    1,
  )
  assert.strictEqual(entry.componentId, 'c1')
  assert.strictEqual(entry.barCount, 91)
  assert.strictEqual(entry.unreadBars, 2)
  assert.deepStrictEqual(entry.coverage, { impacted: 2, fetched: 1 })  // impacted = the ARRAY's length
  assert.strictEqual(entry.days.length, 1)
})

test('buildUptimeEntry passes unreadBars through instead of defaulting it', () => {
  // A real zero survives as a zero...
  assert.strictEqual(
    buildUptimeEntry({ componentId: 'c1', barCount: 91, unreadBars: 0, impacted: [] }, [], 0).unreadBars,
    0,
  )
  // ...and an ABSENT one stays absent, so the gate is the single place that decides. The earlier
  // version of this test asserted `?? 0` here and called it correct, while its own comment said
  // omission should be refused — the assertion certified the bug the comment described.
  assert.strictEqual(
    'unreadBars' in buildUptimeEntry({ componentId: 'c1', barCount: 91, impacted: [] }, [], 0)
      ? buildUptimeEntry({ componentId: 'c1', barCount: 91, impacted: [] }, [], 0).unreadBars
      : 'MISSING',
    undefined,
    'a field the derivation did not produce must not be invented here',
  )
})

// ── env overrides ───────────────────────────────────────────────────────────────────────────────
// `Number(process.env.X || DEFAULT)` read `MAX_INCIDENTS=0` as 0 — the string is truthy, so the
// default never applied — and any non-numeric value as NaN. Either made `slice(0, n)` return
// nothing, so the run read ZERO incidents and reported `{listed: 0, fetched: 0}`: indistinguishable
// from a genuinely quiet page, and storable as a complete reading.
test('envPositiveInt falls back only when the variable is absent or empty', () => {
  assert.strictEqual(envPositiveInt('X', 80, {}), 80)
  assert.strictEqual(envPositiveInt('X', 80, { X: '' }), 80)
  assert.strictEqual(envPositiveInt('X', 80, { X: '30' }), 30)
})

// KNOWN LIMIT, stated rather than papered over: these two tests cover the FUNCTION, not the fact
// that `main()` calls it. `main()` drives a real browser, so nothing here executes the call site —
// reverting the `maxIncidents` assignment to `Number(process.env.MAX_INCIDENTS || …)` leaves this
// file green. Verified by
// reading (`grep -n "Number(process.env" scripts/scrape-mistral-status.mjs` returns nothing). A
// source-text scanner would close it, and that is exactly the guard shape review retired earlier in
// this PR for missing renames, modifiers and types; it is not worth re-introducing for two lines.
test('envPositiveInt REFUSES the values that used to read as "scrape nothing"', () => {
  for (const bad of ['0', '-1', 'eighty', 'NaN', '  ']) {
    assert.throws(
      () => envPositiveInt('MAX_INCIDENTS', 80, { MAX_INCIDENTS: bad }),
      /MAX_INCIDENTS must be a positive number/,
      `${JSON.stringify(bad)} must stop the run, not scrape zero incidents`,
    )
  }
})

// ── component rows (#1476) ───────────────────────────────────────────────────────────
// Both strings were READ off status.mistral.ai in a headed browser on 2026-09-22T01:11Z, while the
// OCR component was the one affected.
const LIVE_AFFECTED = 'OCR API Affected 90 days ago 99.31% Today'
const LIVE_OPERATIONAL = 'Agents API Operational 90 days ago 100.0% Today'

test('reads the word an affected component renders', () => {
  assert.deepEqual(readComponentRow(LIVE_AFFECTED), { name: 'OCR API', status: 'Affected' })
})

test('reads the word an operational component renders', () => {
  assert.deepEqual(readComponentRow(LIVE_OPERATIONAL), { name: 'Agents API', status: 'Operational' })
})

// Coercing an unknown word to a status here would publish a state we did not read.
test('an unknown status word reads null, not a guess', () => {
  assert.deepEqual(readComponentRow('OCR API Wobbly 90 days ago 99.31% Today'),
    { name: null, status: null })
  assert.deepEqual(readComponentRow(''), { name: null, status: null })
})

// The name is whatever precedes the status word, so the status word decides where the name ends.
test('the name stops at the status word, with the markup whitespace collapsed', () => {
  assert.deepEqual(readComponentRow('  AI Registry\n  Prompts API   Operational  90 days ago '),
    { name: 'AI Registry Prompts API', status: 'Operational' })
})
