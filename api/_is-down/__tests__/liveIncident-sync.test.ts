import { describe, it, expect } from 'vitest'
import { hasLiveIncident as edgeHasLive } from '../html-template'
// @ts-expect-error — JS module, no types
import { hasLiveIncident as spaHasLive } from '../../../src/utils/liveIncident.js'

// #1104 — "does this service still carry a live incident?" is answered independently on two surfaces:
// the Edge is-down template and the SPA (AnalysisModal pill, Overview + ServiceDetails chips). They
// share no module — Edge and SPA are separate bundles — so the rule is duplicated deliberately, the
// same way SERVICE_SITE_URL, incident-grouping and incident-sort already are. Every one of those
// mirrors ships a lockstep test, because "deliberate duplicate" and "silent drift" look identical in
// a diff. This is that test.
//
// The specific drift to fear is `monitoring`. Both copies exclude it (provider says recovery is
// confirmed — the same cut `/api/status/cached` makes when choosing which analyses to send), but
// `hasOngoingIncident` in `worker/src/alerts.ts` and the older SPA code define the opposite cut, so a
// future edit "fixing" one copy to match those is the likely mistake. If it happens, the dashboard
// modal and the is-down card give opposite answers about one incident — exactly what #1104 filed.

const svc = (statuses: (string | undefined)[]) => ({ incidents: statuses.map((status) => ({ status })) })

describe('hasLiveIncident Edge↔SPA parity (#1104)', () => {
  const cases: Array<[string, unknown]> = [
    ['no live incident — all resolved', svc(['resolved', 'resolved'])],
    ['monitoring only — NOT live on either side', svc(['monitoring'])],
    ['monitoring + resolved', svc(['monitoring', 'resolved'])],
    ['identified', svc(['identified'])],
    ['investigating among resolved', svc(['resolved', 'investigating'])],
    ['the #1104 state — one live, the rest closed', svc(['identified', 'resolved', 'monitoring'])],
    ['empty incident list', svc([])],
    ['undefined status', svc([undefined])],
    ['no incidents key', {}],
    ['null service', null],
    ['undefined service', undefined],
    // A malformed cached payload. Both must DEGRADE, not throw — a throw on the SPA side happens
    // inside a React render and takes the page down.
    ['incidents is not an array', { incidents: 'oops' }],
    ['incidents is an object', { incidents: { 0: { status: 'identified' } } }],
    // A null ELEMENT, not just a null array: the two copies once differed here (`i.status` threw on
    // the Edge while `i?.status` degraded in the SPA), which is a divergence in how they FAIL.
    ['a null element among real ones', { incidents: [null, { status: 'resolved' }] }],
    ['only null elements', { incidents: [null] }],
  ]

  it.each(cases)('%s — both copies agree', (_label, service) => {
    const edge = edgeHasLive(service as never)
    const spa = spaHasLive(service)
    expect({ edge, spa }).toEqual({ edge: spa, spa })
  })

  it('agrees that the #1104 state IS live and a monitoring-only service is NOT', () => {
    // Pins the direction too, not just the agreement — two copies that are both wrong in the same
    // way would satisfy the parity assertion above on its own.
    expect(edgeHasLive(svc(['identified', 'resolved']) as never)).toBe(true)
    expect(spaHasLive(svc(['identified', 'resolved']))).toBe(true)
    expect(edgeHasLive(svc(['monitoring', 'resolved']) as never)).toBe(false)
    expect(spaHasLive(svc(['monitoring', 'resolved']))).toBe(false)
  })
})
