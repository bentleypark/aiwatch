// #965 — tests for the May-2026 officialUptime scrub script's decision layer.
//
// This script overwrites `archive:monthly:2026-05`, a PERMANENT no-TTL KV entry. The guard it carries
// is not "which services are contaminated" (nothing in the archive can answer that — see the script's
// header) but "does the archive still hold exactly what #965 found" — the cases below are the ways
// that stops being true and the script must refuse rather than patch through it.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { CONTAMINATED, planScrub } from './patch-archive-officialuptime-scrub.mjs'

const svc = (officialUptime, extra = {}) => ({ officialUptime, uptime: 100, monthlyScore: 80, ...extra })

/** The real archive's shape for the six contaminated services, as #965 recorded it, plus a few
 *  untouched services thrown in so a run against the whole archive doesn't drift them. */
function mayLike(overrides = {}) {
  const services = {
    stability: svc(100), elevenlabs: svc(99.21), replicate: svc(99.34),
    characterai: svc(99.61), bedrock: svc(100), azureopenai: svc(100),
    claude: svc(99.2), openai: svc(99.98), // legitimate — officialUptime present, NOT in CONTAMINATED
    ...overrides,
  }
  return { period: '2026-05', generatedAt: '2026-06-13T03:08:04.345Z', services }
}

describe('CONTAMINATED', () => {
  test('names exactly the six services #965 identified', () => {
    assert.deepEqual(
      CONTAMINATED.map((c) => c.id).sort(),
      ['azureopenai', 'bedrock', 'characterai', 'elevenlabs', 'replicate', 'stability'],
    )
  })
})

describe('planScrub', () => {
  test('plans a null-out for every contaminated service whose value matches #965 exactly', () => {
    const { changes, skips, refusals } = planScrub(mayLike())
    assert.deepEqual(changes.map((c) => c.id).sort(), CONTAMINATED.map((c) => c.id).sort())
    assert.equal(skips.length, 0)
    assert.equal(refusals.length, 0)
  })

  test('never plans a change for a service NOT in the CONTAMINATED table, even with officialUptime set', () => {
    const { changes } = planScrub(mayLike())
    assert.equal(changes.find((c) => c.id === 'claude'), undefined)
    assert.equal(changes.find((c) => c.id === 'openai'), undefined)
  })

  test('skips (benign — does not re-plan) a service already nulled', () => {
    const { changes, skips, refusals } = planScrub(mayLike({ stability: svc(null) }))
    assert.equal(changes.find((c) => c.id === 'stability'), undefined)
    assert.ok(skips.some((s) => s.startsWith('stability:') && s.includes('already')))
    assert.equal(refusals.length, 0)
  })

  test('REFUSES (not a skip) a service whose current value has drifted from what #965 recorded', () => {
    const { changes, skips, refusals } = planScrub(mayLike({ stability: svc(97.5) }))
    assert.equal(changes.find((c) => c.id === 'stability'), undefined)
    assert.equal(skips.length, 0, 'a drift must land on the refusal channel, not skip')
    assert.ok(refusals.some((r) => r.startsWith('stability:')))
  })

  test('skips a service absent from the archive entirely — benign, not a refusal', () => {
    const archive = mayLike()
    delete archive.services.bedrock
    const { changes, skips, refusals } = planScrub(archive)
    assert.equal(changes.find((c) => c.id === 'bedrock'), undefined)
    assert.ok(skips.some((s) => s.startsWith('bedrock:') && s.includes('not present')))
    assert.equal(refusals.length, 0)
  })

  test('a drifted service still plans changes for the other five (the CLI is what aborts the run, not the planner)', () => {
    const { changes } = planScrub(mayLike({ stability: svc(97.5) }))
    assert.deepEqual(
      changes.map((c) => c.id).sort(),
      ['azureopenai', 'bedrock', 'characterai', 'elevenlabs', 'replicate'],
    )
  })

  test('reports the pre-patch value in each planned change, for the operator log line', () => {
    const { changes } = planScrub(mayLike())
    const stability = changes.find((c) => c.id === 'stability')
    assert.equal(stability.before, 100)
  })
})
