import { describe, it, expect } from 'vitest'
import { readsResolved, hasLiveIncident, showRecoveredChip } from './liveIncident'

// #1104 — the worker now keeps an incident whose impact on our component ended while the incident
// stays open, so "operational badge + live incident" is an ordinary state rather than a rare one. The
// dashboard modal and the Edge is-down card must not answer it differently (the standing
// dashboard-AND-is-down rule); is-down's side is pinned in api/__tests__/is-down-render.test.ts.
const svc = (status, incidents = []) => ({ id: 'openai', status, incidents })
const inc = (status, id) => ({ id: id ?? `i-${status}`, status })

describe('readsResolved / hasLiveIncident (#1104)', () => {
  it('hasLiveIncident: only an unclosed incident counts', () => {
    expect(hasLiveIncident(svc('operational', [inc('identified')]))).toBe(true)
    expect(hasLiveIncident(svc('operational', [inc('monitoring')]))).toBe(false)
    expect(hasLiveIncident(svc('operational', [inc('resolved')]))).toBe(false)
    expect(hasLiveIncident(undefined)).toBe(false)
  })

  it('accepts a single service as well as a group — the ServiceDetails chip passes one', () => {
    expect(readsResolved(svc('operational', [inc('identified')]))).toBe(false)
    expect(readsResolved(svc('operational', [inc('resolved')]))).toBe(true)
  })

  it('a live incident vetoes the pill even when every analysis on the card is resolved', () => {
    // The exact state the old `analyses.every(a => a.resolvedAt) ||` short-circuit mislabelled:
    // /api/status/cached sends recovered analyses whenever the ACTIVE branch produced nothing, so the
    // card can hold only resolved analyses while the incident is still open.
    expect(readsResolved([svc('operational', [inc('identified')])])).toBe(false)
  })

  it('monitoring is not live — the provider is confirming recovery', () => {
    // Same cut the worker makes when choosing which analyses to send; counting it as live would keep a
    // genuinely resolved card open forever.
    expect(readsResolved([svc('operational', [inc('monitoring')])])).toBe(true)
  })

  it('the ordinary resolved case still shows the pill', () => {
    expect(readsResolved([svc('operational', [inc('resolved')])])).toBe(true)
    expect(readsResolved([svc('operational')])).toBe(true)
  })

  it('a non-operational service never reads resolved', () => {
    expect(readsResolved([svc('degraded', [inc('resolved')])])).toBe(false)
  })

  it('a multi-service group is vetoed by ANY member (sibling-shared incident)', () => {
    expect(readsResolved([svc('operational', [inc('resolved')]), svc('operational', [inc('identified')])])).toBe(false)
    expect(readsResolved([svc('operational', [inc('resolved')]), svc('down')])).toBe(false)
  })
})

describe('readsResolved — the fail direction (#1104)', () => {
  it('an EMPTY group does not read resolved', () => {
    // `[].every()` is true, so without the explicit guard this returns true — failing OPEN, and
    // claiming "Resolved" over nothing at all is the same class as claiming it over a live incident.
    expect(readsResolved([])).toBe(false)
  })
})

describe('showRecoveredChip (#1104)', () => {
  // The decision both dashboard chips route through. Wiring is pinned separately by
  // src/components/__tests__/live-incident-wiring.test.js.
  const service = svc('operational', [inc('resolved', 'done'), inc('identified', 'live')])
  const clean = svc('operational', [inc('resolved', 'done')])

  it('withholds the chip when the service still carries a live incident', () => {
    expect(showRecoveredChip({ openai: ['done'] }, service)).toBe(false)
  })

  it('shows it when the marker names a resolved incident and nothing is open', () => {
    expect(showRecoveredChip({ openai: ['done'] }, clean)).toBe(true)
  })

  it('needs a marker at all — the chip is not a pure status read', () => {
    expect(showRecoveredChip({}, clean)).toBe(false)
    expect(showRecoveredChip(undefined, clean)).toBe(false)
  })

  it('survives a missing service', () => {
    expect(showRecoveredChip({ openai: ['done'] }, undefined)).toBe(false)
  })
})
