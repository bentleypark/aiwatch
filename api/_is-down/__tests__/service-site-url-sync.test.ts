import { describe, it, expect } from 'vitest'
import { SERVICE_SITE_URL as EDGE_MAP, outboundReferralUrl as edgeOutbound } from '../slug-map'
// @ts-expect-error — JS module, no types
import { SERVICE_SITE_URL as SPA_MAP, outboundReferralUrl as spaOutbound } from '../../../src/utils/constants.js'

// #842 — the outbound-referral URL map is mirrored across the Edge is-down page (slug-map.ts) and the
// SPA surfaces (constants.js — Analyze modal + Overview ActionBanner). They MUST stay byte-identical
// so a service's "Open ↗" destination is the same everywhere. This pins the two against drift.
describe('SERVICE_SITE_URL Edge↔SPA parity (#842)', () => {
  it('has the identical key set', () => {
    expect(Object.keys(EDGE_MAP).sort()).toEqual(Object.keys(SPA_MAP).sort())
  })
  it('maps every id to the identical URL', () => {
    expect({ ...EDGE_MAP }).toEqual({ ...SPA_MAP })
  })
  it('outboundReferralUrl produces the identical output on both sides (pins the ?ref behavior too)', () => {
    for (const id of Object.keys(EDGE_MAP)) expect(edgeOutbound(id)).toBe(spaOutbound(id))
    // and both agree on an uncurated id (graceful null)
    expect(edgeOutbound('bedrock')).toBe(spaOutbound('bedrock'))
  })
})
