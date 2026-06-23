// #574 — Supply-chain impact banner (Phase 1: AWS only).
//
// When an AWS region is currently degraded AND ≥1 AWS-dependent AI service is ALSO degraded, surface
// a banner correlating the two. The CORRELATION GATE (a dependent service must actually be degraded)
// is the differentiator vs AIDown.io's static "dependency map" — we never show a cloud-only banner
// (that would be alarmist; mirrors the #575 crowd-report gate). The dependency map below is the
// curation moat; it lives worker-side only (the banner is computed here; clients just render text).

import type { ServiceStatus } from './types'

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
  regions: Array<{ region: string; level: 'degraded' | 'down'; summary?: string }>
  /** dependent services that are CURRENTLY degraded/down (the correlation — confirmed). */
  affectedNow: Array<{ id: string; name: string }>
  /** other AWS-dependent services NOT currently degraded (estimated — may be affected), confidence-tagged. */
  mayBeAffected: Array<{ id: string; name: string; confidence: DepConfidence }>
}

const isImpacted = (s?: ServiceStatus) => s != null && (s.status === 'degraded' || s.status === 'down')

// StatusGator-style attribution cross-check (#574): a degraded dependent service counts as
// "AWS-attributed" only when ITS OWN active incident text names AWS / a region / an upstream-provider
// — i.e. the service itself blames the cloud. This replaces a vague timing correlation ("both down at
// once") with a verifiable basis. Region tokens (us-east-1) + EC2/EBS + the generic "upstream/cloud/
// infrastructure provider" language StatusGator filters on.
const AWS_ATTRIBUTION_RE = /\b(aws|amazon web services|us-east-\d|us-west-\d|eu-west-\d|eu-central-\d|ap-(?:south|southeast|northeast)-\d|ec2|ebs|upstream provider|cloud provider|infrastructure provider|third-party provider)\b/i

/** Does this service's OWN active incident text attribute the issue to AWS / an upstream provider?
 *  Bedrock is AWS-native (its incidents come from the AWS Health feed) → always attributed. */
function isAwsAttributed(svc: ServiceStatus): boolean {
  if (svc.id === 'bedrock') return true
  for (const inc of svc.incidents ?? []) {
    if (inc.status === 'resolved') continue
    const text = `${inc.title ?? ''} ${(inc.timeline ?? []).map((e) => e.text ?? '').join(' ')}`
    if (AWS_ATTRIBUTION_RE.test(text)) return true
  }
  return false
}

/**
 * Build the supply-chain banner from the live service list, or null when the gate isn't met.
 * Gate: ≥1 currently-degraded AWS INFRA region (bedrock.awsRegionHealth, Bedrock-excluded) AND ≥1
 * dependent service that is degraded AND ATTRIBUTES the issue to AWS in its own incident text
 * (StatusGator-style cross-check). A degraded-but-unattributed service is omitted (it's degraded for
 * an unconfirmed/unrelated reason — the regular outage banner covers it; we don't claim AWS caused it).
 */
export function buildSupplyChainBanner(services: ServiceStatus[]): SupplyChainBanner | null {
  const byId = new Map(services.map((s) => [s.id, s]))
  const regionHealth = byId.get('bedrock')?.awsRegionHealth
  if (!regionHealth) return null

  const regions = Object.entries(regionHealth).map(([region, v]) => ({ region, level: v.level, ...(v.summary ? { summary: v.summary } : {}) }))
  if (regions.length === 0) return null

  const affectedNow: SupplyChainBanner['affectedNow'] = []
  const mayBeAffected: SupplyChainBanner['mayBeAffected'] = []
  for (const dep of SUPPLY_CHAIN_AWS_DEPS) {
    const svc = byId.get(dep.id)
    if (!svc) continue // service not present in this snapshot
    if (isImpacted(svc)) {
      // degraded: include ONLY if the service itself attributes it to AWS/upstream (confirmed basis).
      if (isAwsAttributed(svc)) affectedNow.push({ id: svc.id, name: svc.name })
      // else: degraded for an unconfirmed reason → omit (no supply-chain claim).
    } else {
      // healthy AWS-dependent → "may be affected if the AWS issue spreads" (static map, hedged).
      mayBeAffected.push({ id: svc.id, name: svc.name, confidence: dep.confidence })
    }
  }

  // Gate: at least one dependent service is degraded AND AWS-attributed (not mere timing coincidence).
  if (affectedNow.length === 0) return null

  const severity: 'degraded' | 'down' = regions.some((r) => r.level === 'down') ? 'down' : 'degraded'
  return { cloud: 'aws', severity, regions, affectedNow, mayBeAffected }
}
