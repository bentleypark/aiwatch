// #1006 — tests for the archive uptimeSource patch script's decision layer.
//
// This script overwrites `archive:monthly:{YYYY-MM}`, a PERMANENT no-TTL KV entry, and the thing it
// writes is a PROVENANCE CLAIM — "this uptime came from the provider's own records" vs "from the status
// page platform's monitors". A wrong write here is not a wrong number, it is a published falsehood
// about whose measurement it is. The cases below are the failure modes the guard exists to stop.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { betterStackIdsFrom, planPatch } from './patch-archive-uptimesource.mjs'

/** The real 2026-07 archive's shape, as measured against production.
 *
 *  Note the fireworks row: it carries `uptimeSource` even though the worker source that was HEAD when
 *  the 2026-08-01 cron built the archive (`a70a660`) populated the field at NEITHER call site, so no
 *  code path could have written it. How that one row acquired provenance is NOT established — recorded
 *  here as an observed fact, not explained. It is also why rule 1 is unconditional: the archive holds
 *  provenance this script cannot account for, so overwriting any stored value overwrites evidence.
 *
 *  Fireworks WAS a Better Stack service during July (`48afac8`, the tree at 2026-07-01, lists six
 *  `betterStackUrl` entries) and left via `51068ff` (2026-08-03), so today's roster — five — does not
 *  describe July. Whether its stored `platform_avg` is RIGHT for the month is a separate question this
 *  script does not settle: `51068ff` reports both Better Stack endpoints already 404 on 2026-08-02, so
 *  the figure beside it may be as unaccounted-for as the provenance. Rule 1 preserves both either way. */
const svc = (officialUptime, extra = {}) => ({ officialUptime, uptime: 100, monthlyScore: 80, ...extra })
const julyLike = () => ({
  period: '2026-07',
  services: {
    together: svc(99.78), huggingface: svc(99.85), modal: svc(99.98), helicone: svc(96.24), luma: svc(99.75),
    fireworks: svc(99.9, { uptimeSource: 'platform_avg' }),
    claude: svc(99.11),        // Atlassian, no stored provenance
    azureopenai: svc(null),    // no official uptime at all
  },
})
const BS = ['together', 'huggingface', 'modal', 'helicone', 'luma']

describe('betterStackIdsFrom', () => {
  test('reads ids off the lines that configure betterStackUrl', () => {
    const src = [
      `  { id: 'together', name: 'Together AI', betterStackUrl: 'https://status.together.ai' },`,
      `  { id: 'runway', name: 'Runway', apiUrl: 'https://status.runwayml.com/api/v2/summary.json' },`,
      `  // Luma — Better Stack status page (status.lumalabs.ai) → betterstack.ts parser`,
      `  { id: 'luma', name: 'Luma', betterStackUrl: 'https://status.lumalabs.ai' },`,
    ].join('\n')
    // The comment line MENTIONS Better Stack and sits next to luma's entry; only real config counts.
    assert.deepEqual(betterStackIdsFrom(src), ['together', 'luma'])
  })

  test('a prose mention of betterStackUrl with no id on the line yields nothing', () => {
    assert.deepEqual(betterStackIdsFrom(`  // betterStackUrl drives the platform_avg branch\n`), [])
  })

  test('a COMMENTED-OUT config entry is not read as a live Better Stack service', () => {
    const src = `  // { id: 'retired', name: 'Retired', betterStackUrl: 'https://status.retired.io' },\n`
    assert.deepEqual(betterStackIdsFrom(src), [], 'a disabled entry must not put a service on the roster')
  })
})

describe('planPatch', () => {
  test('adds platform_avg to the Better Stack services that lack provenance', () => {
    const { changes } = planPatch(julyLike(), BS)
    assert.deepEqual(changes.map((c) => c.id).sort(), ['helicone', 'huggingface', 'luma', 'modal', 'together'])
    assert.ok(changes.every((c) => c.after === 'platform_avg'))
  })

  test('rule 1 — never touches a service that already stores a provenance', () => {
    const { changes, skips } = planPatch(julyLike(), BS)
    assert.ok(!changes.some((c) => c.id === 'fireworks'))
    assert.ok(skips.some((s) => s.startsWith('fireworks:')))
  })

  // A "correct it to match today's config" rule would silently rewrite July's history.
  test('rule 1 — a stored value that DISAGREES with today\'s roster stands, and says so', () => {
    const { changes, skips } = planPatch(julyLike(), BS) // BS excludes fireworks, archive says platform_avg
    assert.ok(!changes.some((c) => c.id === 'fireworks'))
    assert.match(skips.find((s) => s.startsWith('fireworks:')), /migration/)
  })

  test('rule 2 — never attaches provenance to a withheld officialUptime', () => {
    const a = julyLike()
    a.services.modal.officialUptime = null
    const { changes, skips } = planPatch(a, BS)
    assert.ok(!changes.some((c) => c.id === 'modal'))
    assert.ok(skips.some((s) => s.startsWith('modal:')))
  })

  test('rule 2 — an ABSENT officialUptime key behaves the same, not just an explicit null', () => {
    const a = julyLike()
    delete a.services.modal.officialUptime
    assert.ok(!planPatch(a, BS).changes.some((c) => c.id === 'modal'))
  })

  // Nothing in this script aborts the run. An earlier draft made the unresolvable cases REFUSALS that
  // killed the whole run — which held four correctly-derivable services hostage to one undecidable one,
  // and (verified against the real archive) left 2026-07 with no invocation that could complete at all
  // had its one anomalous row not existed. Declining to write is always safe: absent provenance is the
  // pre-existing state, so a skip changes nothing.
  test('an undecidable service never blocks the decidable ones', () => {
    const a = julyLike()
    a.services.modal.officialUptime = null          // rule 2, undecidable
    const { changes } = planPatch(a, BS, ['luma'])  // luma drift-touched, also undecidable
    assert.deepEqual(changes.map((c) => c.id).sort(), ['helicone', 'huggingface', 'together'])
  })

  // Both drift directions. Today's roster is silent either way for a service whose config moved, so
  // membership is the one thing that cannot be inferred — it is reported and left alone, never guessed.
  test('drift — a service that LEFT the roster is reported and not patched', () => {
    const a = julyLike()
    delete a.services.fireworks.uptimeSource // the counterfactual: had nothing been stored
    const silent = planPatch(a, BS)                 // no driftIds → invisible
    assert.ok(!silent.skips.some((s) => s.startsWith('fireworks:')))

    const guarded = planPatch(a, BS, ['fireworks'])
    assert.ok(!guarded.changes.some((c) => c.id === 'fireworks'), 'must not GUESS platform_avg')
    assert.match(guarded.skips.find((s) => s.startsWith('fireworks:')), /CHANGED at or after this month/)
  })

  // The defect the first draft of the drift check had: it sat inside the `!bs.has(id)` branch, so a
  // service that JOINED after the month short-circuited into `changes` and got `platform_avg` stamped
  // onto a figure that was never measured that way.
  test('drift — a service that JOINED the roster after the month is also not patched', () => {
    const a = julyLike()
    a.services.newbie = svc(99.5)
    const { changes, skips } = planPatch(a, [...BS, 'newbie'], ['newbie'])
    assert.ok(!changes.some((c) => c.id === 'newbie'), 'must not stamp platform_avg on a post-month joiner')
    assert.match(skips.find((s) => s.startsWith('newbie:')), /CHANGED at or after this month/)
    assert.deepEqual(changes.map((c) => c.id).sort(), ['helicone', 'huggingface', 'luma', 'modal', 'together'])
  })

  test('rule 1 wins over drift — a stored value is reported as stored, not as undecidable', () => {
    const skips = planPatch(julyLike(), BS, ['fireworks']).skips // fireworks HAS a value
    assert.match(skips.find((s) => s.startsWith('fireworks:')), /already has uptimeSource/)
  })

  test('drift does not fire on a service with no archived figure — nothing is due either way', () => {
    const a = julyLike()
    delete a.services.fireworks.uptimeSource
    a.services.fireworks.officialUptime = null
    const { changes, skips } = planPatch(a, BS, ['fireworks'])
    assert.ok(!changes.some((c) => c.id === 'fireworks'))
    assert.ok(!skips.some((s) => s.startsWith('fireworks:')), 'not a Better Stack member today, no figure — rule 3 silence')
  })

  test('rule 1 — a stored value that AGREES with today\'s roster skips quietly, without the migration note', () => {
    const a = julyLike()
    a.services.together.uptimeSource = 'platform_avg' // in BS and stored as platform_avg → agrees
    const s = planPatch(a, BS).skips.find((x) => x.startsWith('together:'))
    assert.ok(s, 'an already-annotated service must still be reported as skipped')
    assert.doesNotMatch(s, /migration/)
  })

  test('rule 3 — leaves a non-Better-Stack service alone rather than backfilling "official"', () => {
    const { changes, skips } = planPatch(julyLike(), BS)
    assert.ok(!changes.some((c) => c.id === 'claude'))
    // Silent, not merely unpatched: most of the roster would otherwise bury the handful of lines the
    // operator actually has to read.
    assert.ok(!skips.some((s) => s.startsWith('claude:')))
    assert.ok(!skips.some((s) => s.startsWith('azureopenai:')))
  })

  test('is idempotent — a second run over its own output plans nothing', () => {
    const a = julyLike()
    for (const c of planPatch(a, BS).changes) a.services[c.id].uptimeSource = c.after
    assert.deepEqual(planPatch(a, BS).changes, [])
  })

  test('touches no field other than uptimeSource', () => {
    const before = julyLike(), after = julyLike()
    for (const c of planPatch(after, BS).changes) after.services[c.id].uptimeSource = c.after
    for (const [id, s] of Object.entries(after.services)) {
      const { uptimeSource: _drop, ...rest } = s
      const { uptimeSource: _drop2, ...origRest } = before.services[id]
      assert.deepEqual(rest, origRest, `${id} changed a field other than uptimeSource`)
    }
  })

  test('an archive with no services object plans nothing rather than throwing', () => {
    assert.deepEqual(planPatch({}, BS), { changes: [], skips: [] })
  })
})
