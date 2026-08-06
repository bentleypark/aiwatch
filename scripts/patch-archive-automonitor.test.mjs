// #1210 — tests for the one-time archive patch script's decision layer.
//
// This script overwrites `archive:monthly:{YYYY-MM}`, a PERMANENT no-TTL KV entry: a wrong write is
// unrecoverable from KV alone. The guard is the only thing between a mistake and that write, so the
// cases below are the failure modes it exists to stop, not a smoke test.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { recompute, assertPatchable, planPatch } from './patch-archive-automonitor.mjs'

// The real Kimi 2026-07 shape: 35 hourly auto-monitor entries bulk-closed together + 5 genuine blips.
const AUTO_DURATIONS = [
  2084, 2024, 1964, 1904, 1844, 1784, 1724, 1664, 1604, 1542, 1481, 1421, 1361, 1301, 1241,
  1181, 1121, 1061, 1001, 939, 879, 819, 759, 699, 637, 577, 517, 457, 397, 337, 277, 217, 157, 97, 37,
]
const REAL_DURATIONS = [5, 5, 1, 17, 19] // sum 47, max 19

const auto = (durationMin, i) => ({ id: `auto-${i}`, title: 'Agentic model error alert', durationMin, autoMonitor: true })
const real = (durationMin, i) => ({ id: `real-${i}`, title: 'Elevated search request error rate', durationMin })

const kimiList = [...AUTO_DURATIONS.map(auto), ...REAL_DURATIONS.map(real)]
/** The service exactly as the pre-patch production archive holds it. */
const kimiStored = () => ({
  incidents: 40, incidentList: kimiList,
  totalDowntimeMin: 37156, longestIncidentMin: 2084, avgResolutionMin: 929,
})

describe('recompute', () => {
  test('excludes autoMonitor by default — the Kimi July figures', () => {
    const r = recompute(kimiList)
    assert.equal(r.totalDowntimeMin, 47)
    assert.equal(r.longestIncidentMin, 19)
    assert.equal(r.avgResolutionMin, 9)
    assert.equal(r.counted, 5)
  })

  test('reproduces the stored figures when told not to exclude — this is what the guard compares against', () => {
    const r = recompute(kimiList, { excludeAutoMonitor: false })
    assert.equal(r.totalDowntimeMin, 37156)
    assert.equal(r.longestIncidentMin, 2084)
    assert.equal(r.avgResolutionMin, 929)
    assert.equal(r.counted, 40)
  })

  test('a list of only autoMonitor entries yields nulls, not zeroes', () => {
    const r = recompute(AUTO_DURATIONS.map(auto))
    assert.equal(r.totalDowntimeMin, null)
    assert.equal(r.longestIncidentMin, null)
    assert.equal(r.avgResolutionMin, null)
    assert.equal(r.counted, 0)
  })
})

describe('assertPatchable', () => {
  test('passes the real pre-patch Kimi service', () => {
    assert.equal(assertPatchable('kimi', kimiStored()), null)
  })

  test('REFUSES a truncated list — the stored aggregates came from the accumulator, not this list', () => {
    // >200-entry cap: the archived list is a capped subset, so recomputing from it would DEFLATE a
    // permanent record. The predicate is the same one aggregateIncidentDurations branches on.
    const v = assertPatchable('flappy', { ...kimiStored(), incidents: 260 })
    assert.equal(v.kind, 'refuse')
    assert.match(v.msg, /TRUNCATED/)
  })

  test('REFUSES when the stored triple is not reproducible from the unfiltered list (#1021 advisory fired)', () => {
    // A quota advisory the worker excluded from downtime: stored total is 47, but the unfiltered list
    // sums to 4367. The script cannot reproduce the advisory rule without duplicating the classifier.
    const list = [...REAL_DURATIONS.map(real), auto(300, 90), { id: 'adv', title: 'Usage Limits Depleting Faster Than Expected', durationMin: 4320 }]
    const v = assertPatchable('codex', { incidents: 7, incidentList: list, totalDowntimeMin: 47, longestIncidentMin: 19, avgResolutionMin: 9 })
    assert.equal(v.kind, 'refuse')
    assert.match(v.msg, /not reproducible/)
  })

  test('the rounding collision that defeated the previous inferential guard is now REFUSED', () => {
    // Stored total 1 over 2 counted entries; the old guard compared round(1/3)===round(1/2) → 0===0 and
    // passed, letting the excluded advisory be re-added. The exact triple comparison catches it.
    const list = [real(1, 0), auto(5, 1), { id: 'adv', title: 'Usage limits increased for all tiers', durationMin: 900 }]
    const v = assertPatchable('tiny', { incidents: 3, incidentList: list, totalDowntimeMin: 1, longestIncidentMin: 1, avgResolutionMin: 1 })
    assert.equal(v.kind, 'refuse')
  })

  test('SKIPS an already-patched service instead of misreporting it as an advisory refusal', () => {
    // A verification re-run reads the same untouched incidentList. Reporting "the advisory filter fired"
    // here would be a false diagnosis, and exiting 1 would make an idempotent re-run look like a failure.
    const v = assertPatchable('kimi', { incidents: 40, incidentList: kimiList, totalDowntimeMin: 47, longestIncidentMin: 19, avgResolutionMin: 9 })
    assert.equal(v.kind, 'skip')
    assert.match(v.msg, /already patched/)
  })

  test('a skip and a refusal are different kinds — an empty list is benign, never a refusal', () => {
    const v = assertPatchable('quiet', { incidents: 0, incidentList: [] })
    assert.equal(v.kind, 'skip')
  })

  test('REFUSES a non-numeric incidents — the population count is the primary guard, so it fails CLOSED', () => {
    for (const incidents of [undefined, null, '40']) {
      const v = assertPatchable('weird', { ...kimiStored(), incidents })
      assert.equal(v.kind, 'refuse', `incidents=${JSON.stringify(incidents)} must refuse`)
      assert.match(v.msg, /not a number/)
    }
  })

  test('REFUSES a zero-duration EXCLUDED entry — it moves neither total nor longest, so it is invisible', () => {
    // 39 counted entries summing 600m + one still-open (durationMin 0) autoMonitor entry. Stored
    // round(600/40)=15 and filtered round(600/39)=15 agree, and total/longest agree by construction —
    // so without this guard the service reports "already patched", which is a false statement, and its
    // divisor is never corrected. `durationMin: 0` is the documented shape of an unresolved entry.
    // Every COUNTED entry has a positive duration — otherwise the inverted predicate would fire too and
    // the test would pass for the wrong reason (it did, on the first attempt).
    const counted = [real(562, 0), ...Array.from({ length: 38 }, (_, i) => real(1, i + 1))] // 39 entries, 600m
    const list = [...counted, { id: 'open', title: 'Agentic model error alert', durationMin: 0, autoMonitor: true }]
    const v = assertPatchable('svc', { incidents: 40, incidentList: list, totalDowntimeMin: 600, longestIncidentMin: 562, avgResolutionMin: 15 })
    assert.equal(v.kind, 'refuse')
    assert.match(v.msg, /zero\/absent durationMin/)
  })
})

describe('planPatch', () => {
  test('touches only services carrying a flagged entry', () => {
    const archive = { services: {
      kimi: kimiStored(),
      claude: { incidents: 2, incidentList: [real(30, 0), real(20, 1)], totalDowntimeMin: 50, longestIncidentMin: 30, avgResolutionMin: 25 },
    } }
    const { changes, refusals } = planPatch(archive)
    assert.equal(refusals.length, 0)
    assert.deepEqual(changes.map(c => c.id), ['kimi'])
    assert.deepEqual(changes[0].after, { totalDowntimeMin: 47, longestIncidentMin: 19, avgResolutionMin: 9, counted: 5 })
    assert.deepEqual(changes[0].before, { totalDowntimeMin: 37156, longestIncidentMin: 2084, avgResolutionMin: 929, countedIncidents: undefined })
  })

  test('an archive with no flagged entries anywhere plans nothing', () => {
    const archive = { services: { claude: { incidents: 1, incidentList: [real(30, 0)], totalDowntimeMin: 30, longestIncidentMin: 30, avgResolutionMin: 30 } } }
    const { changes, skips, refusals } = planPatch(archive)
    assert.deepEqual([changes.length, skips.length, refusals.length], [0, 0, 0])
  })

  test('a refusal is reported separately from a change, so the caller can stop the whole run', () => {
    const archive = { services: {
      kimi: kimiStored(),
      flappy: { ...kimiStored(), incidents: 260 },
    } }
    const { changes, refusals } = planPatch(archive)
    assert.equal(changes.length, 1)
    assert.equal(refusals.length, 1)
  })

  test('a missing services object is not a crash', () => {
    assert.deepEqual(planPatch({}).changes, [])
  })
})
