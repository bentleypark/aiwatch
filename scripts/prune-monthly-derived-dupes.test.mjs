// #1295 — the pure decision layer of the one-time accumulator prune.
//
// This script decides what to DELETE from a permanent record, so the two things under test are: that
// it removes exactly the synthesized rows a feed row already covers, and that it refuses rather than
// guesses when the stored aggregates cannot be re-derived.
//
// It also pins the rule against the worker's copy. `collidesWithFeedRow` is a MIRROR of
// `derivedDayAlreadyBankedFromFeed` (`worker/src/monthly-archive.ts`) — no shared module graph — and a
// mirror that drifts WIDER here deletes rows the worker would have kept.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  collidesWithFeedRow, resourceOfDerived, assertPrunable, planPrune, applyPlan, NAMESPACE_ID,
  ACCUMULATOR_TTL_SECONDS, applyCommands,
} from './prune-monthly-derived-dupes.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RESOURCE = 'Google Gemma 4 31B IT'
// America/Los_Angeles: local day 2026-08-04 runs 07:00Z -> 07:00Z, anchor at 19:00Z. See the worker
// test for why a UTC fixture made every boundary case vacuous.
const ANCHOR = '2026-08-04T19:00:00.000Z'

const feed = (title, startedAt, durationMin = 10) => ({
  id: `#rss-${title}-${startedAt}`, title, startedAt,
  // A resolved row's span must match its own durationMin — a row that resolves at its start instant
  // could not exist, and an impossible fixture is how a real shape stops being tested. `startedAt` is
  // deliberately unparseable in the undecidable-input case, which has no span to derive.
  resolvedAt: Number.isNaN(Date.parse(startedAt))
    ? null : new Date(Date.parse(startedAt) + durationMin * 60_000).toISOString(),
  durationMin, finalStatus: 'resolved', impact: 'minor',
})
const derived = (resource = RESOURCE, startedAt = ANCHOR, day = '2026-08-04', durationMin = 39) => ({
  id: `bs-hist:r-1:${day}`, title: `${resource} — recovered`, startedAt, resolvedAt: startedAt,
  durationMin, finalStatus: 'resolved', impact: 'minor', derived: 'status_history', derivedDay: day,
})

const svcDoc = (entries) => ({
  lastUpdated: '2026-08-31T00:00:00.000Z',
  services: {
    together: {
      count: entries.length,
      totalMinutes: entries.reduce((n, e) => n + e.durationMin, 0),
      longestMinutes: Math.max(0, ...entries.map((e) => e.durationMin)),
      dates: [...new Set(entries.map((e) => e.startedAt.slice(0, 10)))],
      incidentIds: entries.map((e) => e.id),
      durations: Object.fromEntries(entries.map((e) => [e.id, e.durationMin])),
      incidents: entries,
    },
  },
})

test('NAMESPACE_ID matches the binding this script is told to write', () => {
  // Exported and otherwise unasserted: a corrupted id survives the whole battery, and the operator
  // command it builds would read and write the wrong namespace.
  // In its DECLARED form, not as a substring: every realistic corruption of this constant (a dropped
  // leading or trailing character, or an empty string) is itself a substring of the correct id, so
  // `toml.includes(NAMESPACE_ID)` passed on all three — the empty case vacuously.
  const toml = readFileSync(join(ROOT, 'worker/wrangler.toml'), 'utf-8')
  assert.ok(toml.includes(`id = "${NAMESPACE_ID}"`),
    `wrangler.toml does not declare id = "${NAMESPACE_ID}"`)
})

// Every #1295 review round found a defect in the operator procedure — a missing TTL, then a flag that
// does not exist, then a backup filename shared with two other scripts. Each was a fact about an
// external CLI or another script, encoded in a printed string no test could adjudicate. These pin them.
const CMDS = applyCommands('incidents:monthly:2026-08', '/out/incidents-monthly-2026-08.patched.json', '/out')

test('the apply command carries the TTL the worker writes this key with', () => {
  // A bare put makes a 60d-TTL key permanent, and the cron only restores the TTL on a run where the
  // payload changed — never after month rollover.
  const src = readFileSync(join(ROOT, 'worker/src/monthly-archive.ts'), 'utf-8')
  assert.ok(src.includes('expirationTtl: 60 * 86400'),
    'the worker no longer writes incidents:monthly with a 60*86400 TTL — this constant is stale')
  assert.equal(ACCUMULATOR_TTL_SECONDS, 60 * 86400)
  assert.match(CMDS[2], new RegExp(`--ttl ${ACCUMULATOR_TTL_SECONDS}\\b`))
})

test('the apply command uses --ttl, the flag wrangler actually accepts', () => {
  // `--expiration-ttl` reads like the worker's field name and is what a previous round shipped;
  // wrangler runs yargs .strict() and rejects it with "Unknown arguments", so step 3 hard-failed.
  assert.ok(!CMDS.some((c) => c.includes('--expiration-ttl')), 'wrangler has no --expiration-ttl flag')
})

test('the printed wrangler commands target the remote store, never the local Miniflare one', () => {
  // Without --remote the read is empty-and-plausible and the write lands nowhere that matters. Step 2
  // is a local `diff` and touches no KV. Scoped to what is PRINTED — `kvRaw`'s own invocation is a
  // separate call site this scan does not reach.
  const kvCmds = CMDS.filter((c) => c.includes('npx wrangler'))
  assert.equal(kvCmds.length, 3, 'the procedure no longer has three wrangler steps — this scan drifted')
  for (const c of kvCmds) assert.ok(c.includes('--remote'), `missing --remote: ${c}`)
})

test('the apply command writes the FILE, not the filename', () => {
  // `wrangler kv key put <key> [value]` takes a positional value, so dropping `--path` does not fail —
  // it succeeds and writes the literal path string into the key, destroying the month's only copy
  // silently. Worse than a rejected flag, which at least stops at the operator's terminal.
  assert.match(CMDS[2], /kv key put incidents:monthly:2026-08 --path \/out\/incidents-monthly-2026-08\.patched\.json /)
  // The namespace and config must be PRESENT in the command, not merely correct as constants.
  assert.ok(CMDS[2].includes(`--namespace-id ${NAMESPACE_ID}`))
  assert.ok(CMDS[2].includes('--config worker/wrangler.toml'))
  // Step 4 verifies against the patched document, not the backup.
  assert.ok(CMDS[3].endsWith('| diff - /out/incidents-monthly-2026-08.patched.json && echo OK'))
})

test('the backup filename cannot collide with the other ops scripts', () => {
  // All three default to the same directory; the #1210 pair already own `archive-before.json`, and
  // this key — unlike theirs — has no second copy.
  assert.ok(CMDS[0].endsWith('/out/incidents-monthly-2026-08-before.json'))
  assert.ok(!CMDS.some((c) => c.includes('archive-before.json')))
})

// EXECUTE the shipped script, the discipline #1238 / #1254 use. Two rounds of #1295 review shipped a
// main-module guard that exited 0 printing nothing — first for a path with a space, then through a
// symlinked parent — and both were invisible to a suite that only imports the module. A silent exit-0
// here reads as "nothing to prune" while leaving a stale patched document for the operator to apply.
test('running the script through a SYMLINKED path still runs main', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiwatch-1295-'))
  try {
    symlinkSync(ROOT, join(dir, 'link'))
    const r = spawnSync(process.execPath, [join(dir, 'link', 'scripts/prune-monthly-derived-dupes.mjs')],
      { encoding: 'utf-8', cwd: ROOT })
    // No `--period`: main() prints usage and exits 2. A guard that did not fire exits 0, silently.
    assert.equal(r.status, 2, `expected the usage exit, got ${r.status}: ${r.stderr || r.stdout}`)
    assert.match(r.stderr, /usage: node scripts\/prune-monthly-derived-dupes\.mjs/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resourceOfDerived reads the resource off a synthesized title', () => {
  assert.equal(resourceOfDerived(derived()), RESOURCE)
  assert.equal(resourceOfDerived(feed(`${RESOURCE} — down`, ANCHOR)), null)
})

test('collision: the real production shape', () => {
  const list = [feed(`${RESOURCE} — down`, '2026-08-04T13:11:00.000Z'), derived()]
  assert.equal(collidesWithFeedRow(list, list[1], RESOURCE), true)
})

test('no collision: different resource, same day', () => {
  const list = [feed('Qwen3.5 9B — down', '2026-08-04T13:00:00.000Z'), derived()]
  assert.equal(collidesWithFeedRow(list, list[1], RESOURCE), false)
})

test('no collision: same resource, adjacent local day', () => {
  const list = [feed(`${RESOURCE} — down`, '2026-08-04T06:00:00.000Z'), derived()]
  assert.equal(collidesWithFeedRow(list, list[1], RESOURCE), false)
})

test('a feed row opening before the local day and ending inside it still counts', () => {
  const straddling = feed(`${RESOURCE} — down`, '2026-08-04T06:14:36.000Z')
  straddling.resolvedAt = '2026-08-04T07:26:37.000Z'
  const d = derived(RESOURCE, ANCHOR, '2026-08-04')
  assert.equal(collidesWithFeedRow([straddling, d], d, RESOURCE), true)
})

test('the LAST hour of the local day counts; the next day opening does not', () => {
  const d = derived(RESOURCE, ANCHOR, '2026-08-04')
  const late = feed(`${RESOURCE} — down`, '2026-08-05T06:30:00.000Z')
  late.resolvedAt = '2026-08-05T06:50:00.000Z'
  assert.equal(collidesWithFeedRow([late, d], d, RESOURCE), true)
  const next = feed(`${RESOURCE} — down`, '2026-08-05T07:00:00.000Z')
  next.resolvedAt = '2026-08-05T07:10:00.000Z'
  assert.equal(collidesWithFeedRow([next, d], d, RESOURCE), false)
})

test('a LONGER resource name does not delete the shorter one it contains', () => {
  // The nesting case (`helicone.ai` inside `eu.api.helicone.ai`). This half DELETES, so a match wider
  // than the worker's guard destroys a row the worker would have kept.
  const banked = feed('eu.api.helicone.ai — down', '2026-08-04T13:00:00.000Z')
  const shorter = derived('helicone.ai', ANCHOR, '2026-08-04')
  assert.equal(collidesWithFeedRow([banked, shorter], shorter, 'helicone.ai'), false)
  // ...while the resource the feed actually named is still matched. `resource` is supplied by the
  // caller (`resourceOfDerived`), so this is the row whose own name the feed row carries.
  const longer = derived('eu.api.helicone.ai', ANCHOR, '2026-08-04')
  assert.equal(collidesWithFeedRow([banked, longer], longer, 'eu.api.helicone.ai'), true)
})

test('a PREFIX-nested resource name does not delete the shorter one', () => {
  // A prefix-nested pair, which is what the ` — ` separator exists for. This half DELETES, so
  // dropping the separator would destroy the shorter resource's real downtime day.
  const banked = feed('Inkling Small — down', '2026-08-04T13:00:00.000Z')
  const shorter = derived('Inkling', ANCHOR, '2026-08-04')
  assert.equal(collidesWithFeedRow([banked, shorter], shorter, 'Inkling'), false)
  const exact = derived('Inkling Small', ANCHOR, '2026-08-04')
  assert.equal(collidesWithFeedRow([banked, exact], exact, 'Inkling Small'), true)
})

test('a synthesized row is not evidence for another synthesized row', () => {
  const other = derived(RESOURCE, ANCHOR, '2026-08-04')
  other.id = 'bs-hist:r-2:2026-08-04'
  const list = [other, derived()]
  assert.equal(collidesWithFeedRow(list, list[1], RESOURCE), false)
})

test('assertPrunable refuses a truncated service rather than guessing', () => {
  const doc = svcDoc([feed(`${RESOURCE} — down`, '2026-08-04T13:00:00.000Z'), derived()])
  const svc = doc.services.together
  svc.incidents = svc.incidents.slice(1) // the 200-row cap dropped the oldest
  assert.match(assertPrunable('together', svc), /row cap truncated/)
})

test('assertPrunable refuses when the aggregates do not reproduce', () => {
  const doc = svcDoc([feed(`${RESOURCE} — down`, '2026-08-04T13:00:00.000Z'), derived()])
  doc.services.together.totalMinutes = 999
  assert.match(assertPrunable('together', doc.services.together), /totalMinutes/)
})

// I1 — the refusal must be wired into planPrune, not merely correct as a pure function. Deleting the
// `assertPrunable` call, its `continue`, or its count check all left both suites green.
test('planPrune REFUSES a truncated service instead of planning a deletion', () => {
  const doc = svcDoc([feed(`${RESOURCE} — down`, '2026-08-04T13:11:00.000Z'), derived()])
  doc.services.together.incidents = doc.services.together.incidents.slice(0) // keep the collision
  doc.services.together.incidentIds.push('#evicted-by-the-200-row-cap')      // detail shorter than ids
  const { changes, refusals } = planPrune(doc)
  assert.equal(changes.length, 0, 'a refused service must not be planned for deletion')
  assert.equal(refusals.length, 1)
  assert.match(refusals[0], /row cap truncated/)
})

test('planPrune REFUSES a service whose aggregates do not reproduce', () => {
  const doc = svcDoc([feed(`${RESOURCE} — down`, '2026-08-04T13:11:00.000Z'), derived()])
  doc.services.together.count = 99
  const { changes, refusals } = planPrune(doc)
  assert.equal(changes.length, 0)
  assert.match(refusals[0], /count/)
})

// I4 — undecidable inputs, on the half that DELETES. Each of these guards, removed, widens toward
// deletion: a garbage timestamp makes every window comparison false, so the row would match on title.
test('undecidable input keeps the row rather than planning a deletion', () => {
  const d = derived(RESOURCE, ANCHOR, '2026-08-04')
  const banked = feed(`${RESOURCE} — down`, '2026-08-04T13:00:00.000Z')
  assert.equal(collidesWithFeedRow([banked, d], d, null), false, 'no resource name')
  assert.equal(collidesWithFeedRow([banked, d], d, ''), false, 'empty resource name')
  const badAnchor = { ...d, startedAt: 'not-a-date' }
  assert.equal(collidesWithFeedRow([banked, badAnchor], badAnchor, RESOURCE), false, 'unparseable anchor')
  const badRow = feed(`${RESOURCE} — down`, 'not-a-date')
  assert.equal(collidesWithFeedRow([badRow, d], d, RESOURCE), false, 'unparseable banked timestamp')
})

// I2 — the unresolved-row branch added when the guard moved to interval testing. Neither fixture
// helper could produce it, so `until = to` (NaN) survived: every window comparison goes false and an
// unresolved row of the same resource matches EVERY derived day in the month.
test('an UNRESOLVED banked row collapses to its start instant', () => {
  const d = derived(RESOURCE, ANCHOR, '2026-08-04')
  const open = feed(`${RESOURCE} — down`, '2026-08-04T13:00:00.000Z')
  open.resolvedAt = null
  assert.equal(collidesWithFeedRow([open, d], d, RESOURCE), true, 'starts inside the day')
  const openElsewhere = feed(`${RESOURCE} — down`, '2026-08-01T13:00:00.000Z')
  openElsewhere.resolvedAt = null
  assert.equal(collidesWithFeedRow([openElsewhere, d], d, RESOURCE), false, 'starts on another day')
})

test('planPrune removes only the synthesized side and re-derives the aggregates', () => {
  const doc = svcDoc([feed(`${RESOURCE} — down`, '2026-08-04T13:11:00.000Z'), derived()])
  const { changes, refusals } = planPrune(doc)
  assert.equal(refusals.length, 0)
  assert.equal(changes.length, 1)
  assert.deepEqual(changes[0].removed, ['bs-hist:r-1:2026-08-04'])
  assert.deepEqual(changes[0].before, { count: 2, totalMinutes: 49, longestMinutes: 39 })
  assert.deepEqual(changes[0].after, { count: 1, totalMinutes: 10, longestMinutes: 10 })
})

test('planPrune leaves a synthesized day the feed never covered', () => {
  const doc = svcDoc([feed(`${RESOURCE} — down`, '2026-08-01T03:00:00.000Z'), derived()])
  assert.equal(planPrune(doc).changes.length, 0)
})

test('applyPlan rewrites every dependent field, not just the list', () => {
  const doc = svcDoc([feed(`${RESOURCE} — down`, '2026-08-04T13:11:00.000Z'), derived()])
  const { changes } = planPrune(doc)
  const out = applyPlan(doc, changes).services.together
  assert.equal(out.count, 1)
  assert.equal(out.totalMinutes, 10)
  assert.equal(out.longestMinutes, 10)
  assert.equal(out.incidents.length, 1)
  assert.equal(out.incidentIds.length, 1)
  assert.equal(Object.keys(out.durations).length, 1)
  // The stale id must not survive anywhere — `incidentIds` is the dedup state a later accumulation
  // reads, so a leftover there would silently refuse to re-bank a row that legitimately returns.
  assert.equal(JSON.stringify(out).includes('bs-hist:r-1'), false)
})

test('the mirrored rule matches the worker copy on the facts that decide a deletion', () => {
  // Not a text comparison — the two are different languages. What is pinned is that the worker's rule
  // still keys on the same things this one does: the derived tag, a +/-12h window off the anchor,
  // the row's interval rather than its start, and an ANCHORED resource-name match. A worker rule
  // that stopped doing any of these would make this script delete rows the worker would keep.
  const src = readFileSync(join(ROOT, 'worker/src/monthly-archive.ts'), 'utf-8')
  const fn = src.slice(src.indexOf('export function derivedDayAlreadyBankedFromFeed'))
  assert.ok(fn.includes('HALF_DAY_MS'), 'worker rule no longer uses a half-day window')
  assert.ok(/if \(e\.derived\) return false/.test(fn), 'worker rule no longer ignores synthesized rows')
  assert.ok(/until < dayStart \|\| from >= dayEnd/.test(fn), 'worker rule no longer tests the row INTERVAL')
  assert.ok(/toLowerCase\(\)\.startsWith\(needle\)/.test(fn), 'worker rule no longer matches by ANCHORED resource name')
  assert.ok(/resource\.toLowerCase\(\) \+ ' — '/.test(fn), 'worker rule dropped the separator that anchors the match')
})
