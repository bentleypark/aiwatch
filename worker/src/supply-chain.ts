// #574 — Supply-chain impact banner (Phase 1: AWS only). Region-aware since #1000.
//
// Surface a banner correlating an AWS infrastructure outage with dependent AI services, but ONLY when
// a dependent is degraded AND its own incident names an AWS region that AWS ITSELF reports degraded.
// Two gates, and both matter: the CORRELATION gate (a dependent must actually be degraded) is what
// separates us from AIDown.io's static "dependency map" — we never show a cloud-only banner (alarmist;
// mirrors the #575 crowd-report gate). The REGION gate is what makes the correlation a claim we can
// defend rather than a coincidence: without it, "both degraded at once, and the word AWS appears
// somewhere" was enough, which is how #1000 shipped a me-central-1 headline over a us-east-1 incident.
// The dependency map below is the curation moat; it lives worker-side only (clients just render text).

import type { ServiceStatus } from './types'
import { causalIncidents } from './incident-text'

export type DepConfidence = 'certain' | 'high' | 'medium'

/** Monitored AI services that run on AWS, with our confidence in the dependency. Curated from primary
 *  evidence (the moat), NOT a blunt copy of AIDown.io's %:
 *  - bedrock — AWS-native (certain).
 *  - Anthropic (claude/claudeai/claudecode) — high: a public $100B+ AWS compute commitment (Trainium /
 *    Project Rainier / Bedrock). Anthropic doesn't ATTRIBUTE outages to AWS in its status text, so it
 *    only ever appears under "may be affected" (the attribution cross-check won't confirm it) — correct.
 *  - pinecone — its own incidents tag `[AWS][us-east-1]` (verified) → reliably confirmable.
 *  - huggingface — AWS-hosted (S3 etc.), occasional AWS mentions.
 *  NOTE: `together` was REMOVED (2026-06) — Together AI runs its OWN AI-native GPU cloud (Hypertec
 *  GB200 build, own DCs), NOT AWS, so AIDown's 60% was wrong. Phase 2 adds Azure/GCP maps. */
export const SUPPLY_CHAIN_AWS_DEPS: Array<{ id: string; confidence: DepConfidence }> = [
  { id: 'bedrock', confidence: 'certain' },
  { id: 'claude', confidence: 'high' },
  { id: 'claudeai', confidence: 'high' },
  { id: 'claudecode', confidence: 'high' },
  { id: 'huggingface', confidence: 'medium' },
  { id: 'pinecone', confidence: 'medium' },
]

export interface SupplyChainBanner {
  cloud: 'aws'
  severity: 'degraded' | 'down'
  /** ONLY the regions an `affectedNow` service actually named (#1000) — NOT every degraded AWS region.
   *  Both clients render this as the user-facing headline ("AWS infrastructure issue — <regions>"), so
   *  a region nobody correlated with must not appear here. Never empty when the banner is non-null. */
  regions: Array<{ region: string; level: 'degraded' | 'down'; summary?: string }>
  /** Dependent services that are CURRENTLY degraded/down (the correlation — confirmed). `regions` is
   *  the subset of the degraded AWS regions THIS service named in its own incident — carried per
   *  service because the is-down page makes a per-service causal claim ("<svc> … attributes it to an
   *  AWS/upstream issue (<regions>)"). Joining the banner-wide union there would bind a region the
   *  service never named to its outage — #1000's defect on a second surface, just smaller. */
  affectedNow: Array<{ id: string; name: string; regions: string[] }>
  /** other AWS-dependent services NOT currently degraded (estimated — may be affected), confidence-tagged. */
  mayBeAffected: Array<{ id: string; name: string; confidence: DepConfidence }>
}

const isImpacted = (s?: ServiceStatus) => s != null && (s.status === 'degraded' || s.status === 'down')

// StatusGator-style attribution cross-check (#574), made REGION-AWARE (#1000). A degraded dependent
// service counts as "AWS-attributed" only when its OWN active incident names an AWS region that AWS
// ITSELF currently reports as degraded. The original gate only asked "does the incident mention AWS
// at all?", which is not a cross-check — it left the two halves of the banner free to disagree: on
// 2026-07-13 prod showed "AWS infrastructure issue — me-central-1, me-south-1 · AWS-attributed:
// Pinecone" while Pinecone's only incident was `[Serverless][AWS][us-east-1] …` and us-east-1 had no
// AWS event at all. That is the "vague timing correlation" the gate exists to eliminate, not an
// instance of it.
//
// Region-token shape: <area>-<direction>-<n> — us-east-1, eu-west-3, me-central-1, ap-southeast-4,
// ca-central-1, sa-east-1, af-south-1, il-central-1, mx-central-1, cn-north-1, us-gov-west-1. Matched
// by SHAPE, not by a hand-kept list of full region names, so a newly-launched region reusing the same
// area+direction vocabulary is picked up with no code change. The old `AWS_ATTRIBUTION_RE` did keep
// such a list and it had already gone stale — it omitted me-/ca-/sa-/af-/il-/cn-/mx-/us-gov-/ap-east-/
// eu-north-/eu-south-, so an incident naming ONLY an unlisted region and never writing the word "AWS"
// went unattributed. (Narrow in practice — Pinecone tags `[AWS][…]`, so the bare `aws` alternative
// caught it — but the shape match removes the maintenance burden outright.)
//
// The token is AWS-specific by construction (GCP writes `us-east1`, Azure `eastus`), so naming one IS
// the AWS attribution — no separate "mentions the word AWS" test is needed. A trailing AZ letter
// (`us-east-1a`) is matched and folded to its region, since the AWS feed reports health per region.
//
// The <direction> vocabulary is enumerated rather than a bare `[a-z]+`, which would also match
// `ca-cert-1`, `me-too-1`, `mx-record-1`. The `∩ awsRegionHealth` join already makes a bogus token
// inert (it can never equal a key AWS itself emits), so this is defence in depth, not the load-bearing
// check — but it keeps `named` honest for anyone who reads it, and it costs nothing: every real AWS
// region reuses this vocabulary, so a newly-launched one still matches with no code change.
const AWS_REGION_RE = /\b(?:us|eu|ap|sa|ca|me|af|il|cn|mx)-(?:gov-)?(?:east|west|central|north|south|northeast|northwest|southeast|southwest)-\d(?=[a-z]?\b)/gi

/**
 * The AWS regions this service's OWN active incidents name.
 *
 * Which incidents count as a cause, and what text is searched (title + componentNames + TIMELINE — the
 * timeline read is load-bearing), is `causalIncidents` in `incident-text.ts` — shared with #1053's
 * upstream-link layer, which asks the same question with a different needle. The rationale for each
 * filter lives there.
 *
 * Empty when the service blames nothing region-specific — including the "our upstream provider is
 * having issues" phrasing that carries no region. That case is deliberately NOT attributed here: the
 * banner's headline is region-scoped, so listing a service under regions its own status page never
 * mentions would re-create the very claim this gate removes. Fail-closed — we under-claim rather
 * than assert an unverifiable cause.
 *
 * (Region-less phrasing that NAMES a specific provider — "HuggingFace download issues" — is what
 * `upstream-link.ts` (#1053) picks up instead, which is why it is a separate layer and not a
 * loosening of this one. NOT the fully generic phrasing quoted above: that names nothing, so its
 * gate 3 has no alias to match and it is missed by BOTH layers — see that module's "Accepted cost".)
 *
 * Bedrock needs no special case: it is AWS-native, and its incidents come from the AWS Health feed
 * with `componentNames: [region]` (`parsers/aws.ts`), so its regions parse out like any other
 * service's. Keeping it auto-attributed would have preserved exactly this bug for Bedrock — a
 * Bedrock outage in one region rendering under an unrelated region's infra event.
 */
export function awsRegionsNamedByService(svc: ServiceStatus): Set<string> {
  const named = new Set<string>()
  for (const { text } of causalIncidents(svc)) {
    for (const m of text.matchAll(AWS_REGION_RE)) named.add(m[0].toLowerCase())
  }
  return named
}

/**
 * Build the supply-chain banner from the live service list, or null when the gate isn't met.
 * Gate: ≥1 currently-degraded AWS INFRA region (bedrock.awsRegionHealth, Bedrock-excluded) AND ≥1
 * dependent service that is degraded AND names one of THOSE degraded regions in its own incident.
 * A degraded service that names a different, healthy region — or no region at all — is omitted: it is
 * degraded for a cause AWS's own feed does not corroborate, so the regular outage banner covers it and
 * we make no supply-chain claim.
 *
 * KNOWN, DELIBERATE GAP: AWS files its region-less services (Route 53 / IAM / CloudFront / STS) under
 * `region: "global"`. `awsRegionsNamedByService` only ever emits <area>-<direction>-<n> tokens, so
 * `global` can never enter the intersection no matter what an incident's text says — a global-only AWS
 * event never correlates and the banner stays silent. Treating `global` as a wildcard ("degraded
 * everywhere, so it can't contradict anyone") was tried and reverted: non-contradiction is not
 * corroboration. It would have let an active CloudFront advisory attribute Pinecone's routine
 * `[AWS][us-east-1]` freshness lag — #1000's headline again with `global` in place of `me-central-1`.
 * The big AWS outages that actually move dependents are filed per-region anyway, so the regional path
 * covers them. We under-claim rather than assert a cause we cannot check.
 *
 * `regions` is narrowed to the correlated regions only (#1000). Reporting every degraded AWS region
 * would put regions no affected service ever mentioned into a headline that reads as their cause —
 * and would let an uncorrelated `down` region inflate a `degraded` banner to red.
 */
export function buildSupplyChainBanner(services: ServiceStatus[]): SupplyChainBanner | null {
  const byId = new Map(services.map((s) => [s.id, s]))
  const regionHealth = byId.get('bedrock')?.awsRegionHealth
  if (!regionHealth) return null

  // lowercased region key → its health entry (AWS emits lowercase; normalize so the join can't miss).
  const degraded = new Map(Object.entries(regionHealth).map(([region, v]) => [region.toLowerCase(), { region, ...v }]))
  if (degraded.size === 0) return null

  const affectedNow: SupplyChainBanner['affectedNow'] = []
  const mayBeAffected: SupplyChainBanner['mayBeAffected'] = []
  const correlated = new Set<string>() // degraded regions actually named by an affected service
  for (const dep of SUPPLY_CHAIN_AWS_DEPS) {
    const svc = byId.get(dep.id)
    if (!svc) continue // service not present in this snapshot
    if (isImpacted(svc)) {
      // degraded: include ONLY where the service's own incident names a region AWS reports as degraded.
      const overlap = [...awsRegionsNamedByService(svc)].filter((r) => degraded.has(r))
      if (overlap.length > 0) {
        // carry THIS service's regions (AWS's original casing), not the banner-wide union.
        affectedNow.push({ id: svc.id, name: svc.name, regions: overlap.map((r) => degraded.get(r)!.region) })
        for (const r of overlap) correlated.add(r)
      }
      // else: degraded for a cause AWS does not corroborate → omit (no supply-chain claim).
    } else {
      // healthy AWS-dependent → "may be affected if the AWS issue spreads" (static map, hedged).
      mayBeAffected.push({ id: svc.id, name: svc.name, confidence: dep.confidence })
    }
  }

  // Gate: at least one dependent service is degraded in a region AWS itself reports as degraded.
  if (affectedNow.length === 0) return null

  const regions = [...correlated].map((r) => {
    const { region, level, summary } = degraded.get(r)!
    return { region, level, ...(summary ? { summary } : {}) }
  })
  const severity: 'degraded' | 'down' = regions.some((r) => r.level === 'down') ? 'down' : 'degraded'
  return { cloud: 'aws', severity, regions, affectedNow, mayBeAffected }
}
