import { describe, it, expect } from 'vitest'
import { buildSupplyChainNote, type SupplyChainBannerLike } from '../supply-chain-note'

// #1000 — the is-down note turns the banner's service-wide data into a claim about ONE service. The
// `confirmed` wording is causal ("<svc> is degraded and attributes it to an AWS/upstream issue
// (<regions>)"), so the regions it prints must be the ones THAT service named. Printing the
// banner-wide union there reproduces #1000's false attribution on the is-down surface.

const banner = (over: Partial<SupplyChainBannerLike> = {}): SupplyChainBannerLike => ({
  regions: [{ region: 'us-east-1', level: 'degraded' }, { region: 'eu-west-1', level: 'down' }],
  affectedNow: [
    { id: 'pinecone', name: 'Pinecone', regions: ['us-east-1'] },
    { id: 'huggingface', name: 'Hugging Face', regions: ['eu-west-1'] },
  ],
  mayBeAffected: [{ id: 'claude', name: 'Claude API', confidence: 'high' }],
  ...over,
})

describe('buildSupplyChainNote (#574/#1000)', () => {
  it('a CONFIRMED service names ONLY the regions it correlated on — never the banner-wide union', () => {
    expect(buildSupplyChainNote(banner(), 'pinecone')).toEqual({ regions: 'us-east-1', confirmed: true })
    expect(buildSupplyChainNote(banner(), 'huggingface')).toEqual({ regions: 'eu-west-1', confirmed: true })
    // the union is 'us-east-1, eu-west-1' — printing it on Pinecone's page would attribute its outage
    // to eu-west-1, a region Pinecone never mentioned.
  })

  it('a service correlated on SEVERAL regions lists all of its own', () => {
    const b = banner({ affectedNow: [{ id: 'pinecone', name: 'Pinecone', regions: ['us-east-1', 'eu-west-1'] }] })
    expect(buildSupplyChainNote(b, 'pinecone')).toEqual({ regions: 'us-east-1, eu-west-1', confirmed: true })
  })

  it('a mayBeAffected service is hedged (no causal claim) → the full degraded-region set is correct there', () => {
    expect(buildSupplyChainNote(banner(), 'claude')).toEqual({ regions: 'us-east-1, eu-west-1', confirmed: false })
  })

  it('a service in neither list gets NO note', () => {
    expect(buildSupplyChainNote(banner(), 'openai')).toBeNull()
  })

  it('no banner → no note', () => {
    expect(buildSupplyChainNote(undefined, 'pinecone')).toBeNull()
  })

  // DEPLOY SKEW — Vercel ships this Edge function on merge to main, the worker deploy is manual and
  // batched, so for hours-to-days a worker predating #1000 serves affectedNow entries with NO regions.
  // Falling back to the banner-wide union for the CAUSAL wording there would re-render #1000 on every
  // is-down page for the length of the skew (the union diverges from a service's own regions exactly
  // when two dependents correlate on disjoint regions). Downgrade to hedged instead.
  it('a worker predating #1000 (no per-service regions) → HEDGED, never a causal claim', () => {
    const legacy = banner({ affectedNow: [{ id: 'pinecone', name: 'Pinecone' }] })
    expect(buildSupplyChainNote(legacy, 'pinecone')).toEqual({ regions: 'us-east-1, eu-west-1', confirmed: false })
    // confirmed:false renders "Pinecone runs on AWS and may be affected" — true whatever the regions
    // are — instead of "…attributes it to an AWS/upstream issue (us-east-1, eu-west-1)", which would
    // pin eu-west-1 (Hugging Face's region) to Pinecone's outage.
  })

  it('an EMPTY per-service regions array is treated the same as absent (hedged, not causal)', () => {
    const empty = banner({ affectedNow: [{ id: 'pinecone', name: 'Pinecone', regions: [] }] })
    expect(buildSupplyChainNote(empty, 'pinecone')).toEqual({ regions: 'us-east-1, eu-west-1', confirmed: false })
  })
})
