import { describe, it, expect } from 'vitest'
import { buildSupplyChainBanner, awsRegionsNamedByService, SUPPLY_CHAIN_AWS_DEPS } from '../supply-chain'
import type { ServiceStatus, Incident } from '../types'

// Minimal ServiceStatus fixtures — only the fields buildSupplyChainBanner reads.
const inc = (title: string, timelineText = '', componentNames?: string[]): Incident =>
  ({ id: 'i', title, status: 'investigating', impact: 'major', startedAt: '2026-06-22T00:00:00Z', duration: null,
     ...(componentNames ? { componentNames } : {}),
     timeline: timelineText ? [{ stage: 'investigating', text: timelineText, at: '2026-06-22T00:00:00Z' }] : [] } as Incident)

const svc = (id: string, status: ServiceStatus['status'], incidents: Incident[] = []): ServiceStatus =>
  ({ id, name: id === 'claude' ? 'Claude API' : id, status, incidents } as ServiceStatus)

const bedrockWith = (regionHealth: ServiceStatus['awsRegionHealth'], status: ServiceStatus['status'] = 'operational', incidents: Incident[] = []) =>
  ({ id: 'bedrock', name: 'Amazon Bedrock', status, incidents, awsRegionHealth: regionHealth } as unknown as ServiceStatus)

const REGION = { 'us-east-1': { level: 'degraded' as const, summary: 'Increased error rates' } }
// an AWS-attributed incident (the service's own page blames AWS/upstream, naming the region)
const awsAttributed = inc('Elevated errors', 'Investigating an issue with our upstream cloud provider (AWS us-east-1).')

describe('buildSupplyChainBanner (#574 — StatusGator-style attribution cross-check)', () => {
  it('fires when an AWS region is degraded AND a dependent service is degraded AND attributes it to AWS', () => {
    const banner = buildSupplyChainBanner([
      bedrockWith(REGION), svc('claude', 'degraded', [awsAttributed]),
      svc('claudeai', 'operational'), svc('claudecode', 'operational'),
      svc('huggingface', 'operational'), svc('pinecone', 'operational'),
    ])
    expect(banner).not.toBeNull()
    expect(banner!.affectedNow.map((s) => s.id)).toEqual(['claude'])
    // bedrock is operational here → it lands in mayBeAffected (healthy AWS-dependent), with the rest.
    expect(banner!.mayBeAffected.map((s) => s.id).sort()).toEqual(['bedrock', 'claudeai', 'claudecode', 'huggingface', 'pinecone'])
  })

  it('GATE: a dependent degraded but with NO AWS attribution in its incident → omitted → null (no banner)', () => {
    const banner = buildSupplyChainBanner([
      bedrockWith(REGION), svc('claude', 'degraded', [inc('Elevated errors', 'Investigating internal model latency.')]),
    ])
    expect(banner).toBeNull() // degraded but unattributed → not counted → gate fails
  })

  it('a degraded-unattributed dependent is OMITTED while an attributed one still fires the banner', () => {
    const banner = buildSupplyChainBanner([
      bedrockWith(REGION),
      svc('claude', 'degraded', [awsAttributed]),                               // attributed → affectedNow
      svc('huggingface', 'degraded', [inc('Slow', 'unrelated GPU capacity')]),  // unattributed → omitted
    ])
    expect(banner!.affectedNow.map((s) => s.id)).toEqual(['claude'])
    expect(banner!.mayBeAffected.some((s) => s.id === 'huggingface')).toBe(false) // not "may be affected" (it IS degraded, just not AWS)
  })

  it('Bedrock is AWS-native → attributed from its AWS-Health-feed incident (componentNames: [region])', () => {
    const bedrockIncident = inc('Increased error rates', '', ['us-east-1'])
    const banner = buildSupplyChainBanner([bedrockWith(REGION, 'degraded', [bedrockIncident])])
    expect(banner!.affectedNow.map((s) => s.id)).toEqual(['bedrock'])
  })

  it('GATE: AWS region degraded but NO dependent degraded → null', () => {
    expect(buildSupplyChainBanner([bedrockWith(REGION), svc('claude', 'operational')])).toBeNull()
  })

  it('GATE: a dependent attributes to AWS but NO region health → null', () => {
    expect(buildSupplyChainBanner([bedrockWith(undefined), svc('claude', 'degraded', [awsAttributed])])).toBeNull()
  })

  it('severity is worst-of the CORRELATED regions (a down region → down)', () => {
    const banner = buildSupplyChainBanner([
      bedrockWith({ 'us-east-1': { level: 'degraded' }, 'eu-west-1': { level: 'down' } }),
      svc('claude', 'degraded', [inc('Elevated errors', 'AWS issues in us-east-1 and eu-west-1.')]),
    ])
    expect(banner!.severity).toBe('down')
    expect(banner!.regions).toHaveLength(2)
  })

  it('the dependency map carries a confidence per service; Together is excluded (own cloud, not AWS)', () => {
    expect(SUPPLY_CHAIN_AWS_DEPS.find((d) => d.id === 'bedrock')!.confidence).toBe('certain')
    expect(SUPPLY_CHAIN_AWS_DEPS.find((d) => d.id === 'claude')!.confidence).toBe('high')
    expect(SUPPLY_CHAIN_AWS_DEPS.find((d) => d.id === 'huggingface')!.confidence).toBe('medium')
    expect(SUPPLY_CHAIN_AWS_DEPS.find((d) => d.id === 'together')).toBeUndefined()
  })
})

describe('region-aware attribution (#1000 — the banner must not cross regions)', () => {
  // The exact production false positive, 2026-07-13: AWS reported active events ONLY in me-central-1 /
  // me-south-1, while Pinecone's only incident named us-east-1 — two unrelated events that the
  // region-blind gate presented as cause and effect.
  const ME_REGIONS = {
    'me-central-1': { level: 'degraded' as const, summary: 'Increased Error Rates' },
    'me-south-1': { level: 'degraded' as const, summary: 'Increased connectivity issues and API Error Rates' },
  }
  const pineconeUsEast1 = inc('[Serverless][AWS][us-east-1] Increase in freshness lag for some namespaces', '', ['AWS us-east-1'])

  it('REGRESSION: a dependent degraded in a DIFFERENT region than the degraded AWS regions → null (no banner)', () => {
    const banner = buildSupplyChainBanner([
      bedrockWith(ME_REGIONS), svc('pinecone', 'degraded', [pineconeUsEast1]),
    ])
    expect(banner).toBeNull() // us-east-1 ∉ {me-central-1, me-south-1} → no corroborated cause → no claim
  })

  it('fires when the dependent names a region AWS ITSELF reports degraded (true positive)', () => {
    const banner = buildSupplyChainBanner([
      bedrockWith({ 'us-east-1': { level: 'degraded' as const, summary: 'Increased Error Rates' } }),
      svc('pinecone', 'degraded', [pineconeUsEast1]),
    ])
    expect(banner!.affectedNow.map((s) => s.id)).toEqual(['pinecone'])
    expect(banner!.regions.map((r) => r.region)).toEqual(['us-east-1'])
  })

  it('the banner lists ONLY the correlated regions, not every degraded AWS region', () => {
    const banner = buildSupplyChainBanner([
      bedrockWith({ ...ME_REGIONS, 'us-east-1': { level: 'degraded' as const, summary: 'Increased Error Rates' } }),
      svc('pinecone', 'degraded', [pineconeUsEast1]),
    ])
    // me-central-1 / me-south-1 are degraded too, but no affected service names them → not our story.
    expect(banner!.regions.map((r) => r.region)).toEqual(['us-east-1'])
  })

  it('an AWS-blaming incident with NO region is NOT attributed (fail-closed — region unverifiable)', () => {
    const banner = buildSupplyChainBanner([
      bedrockWith(ME_REGIONS),
      svc('huggingface', 'degraded', [inc('Downloads failing', 'Our upstream cloud provider (AWS) is having issues.')]),
    ])
    expect(banner).toBeNull()
  })

  it('REGRESSION: Bedrock degraded in a DIFFERENT region than the infra event → null (no auto-attribution)', () => {
    const banner = buildSupplyChainBanner([
      bedrockWith(ME_REGIONS, 'degraded', [inc('Increased error rates', '', ['us-east-1'])]),
    ])
    expect(banner).toBeNull() // the old `id === 'bedrock' → always attributed` shortcut would have fired here
  })

  it('extracts region tokens the old hand-kept allowlist omitted (me-/ca-/sa-/af-/il-/gov)', () => {
    const named = awsRegionsNamedByService(
      svc('pinecone', 'degraded', [inc('Degraded in me-central-1, ca-central-1, sa-east-1, af-south-1, il-central-1 and us-gov-west-1')]),
    )
    expect([...named].sort()).toEqual(['af-south-1', 'ca-central-1', 'il-central-1', 'me-central-1', 'sa-east-1', 'us-gov-west-1'])
  })

  it('ignores regions named only by a RESOLVED incident', () => {
    const resolved = { ...inc('[AWS][me-central-1] Errors'), status: 'resolved' } as Incident
    expect(awsRegionsNamedByService(svc('pinecone', 'degraded', [resolved])).size).toBe(0)
    expect(buildSupplyChainBanner([bedrockWith(ME_REGIONS), svc('pinecone', 'degraded', [resolved])])).toBeNull()
  })

  it('ignores regions named only by an impact:null incident (provider claims no availability impact)', () => {
    // symmetric with the AWS side, where awsHealthImpact drops non-reliability advisories (#707).
    const advisory = { ...inc('[AWS][me-central-1] Console metrics tab not loading'), impact: null } as Incident
    expect(awsRegionsNamedByService(svc('pinecone', 'degraded', [advisory])).size).toBe(0)
    expect(buildSupplyChainBanner([bedrockWith(ME_REGIONS), svc('pinecone', 'degraded', [advisory])])).toBeNull()
  })

  it('reads the incident BODY, not just the title — the real Hugging Face AWS incident', () => {
    // Text verbatim from status.huggingface.co (2026-07-13); the real incident was already RESOLVED at
    // capture, so the fixture makes it active (only an active incident can be a cause —
    // awsRegionsNamedByService skips resolved). The title carries a human place name and NO region
    // token; only the update body names ap-southeast-1. Title-only extraction would leave HF
    // permanently unattributable even though it explicitly blames AWS.
    const hfAwsCdn = inc(
      'Elevated error rate – AWS CDN (Singapore)',
      'Between 07:58 and 08:05 UTC, the AWS CDN returned an elevated rate of HTTP 500 errors for a portion of requests in the Asia-Pacific (Singapore / ap-southeast-1) region.',
    )
    expect([...awsRegionsNamedByService(svc('huggingface', 'degraded', [hfAwsCdn]))]).toEqual(['ap-southeast-1'])

    const banner = buildSupplyChainBanner([
      bedrockWith({ 'ap-southeast-1': { level: 'degraded' as const, summary: 'Increased error rates' } }),
      svc('huggingface', 'degraded', [hfAwsCdn]),
    ])
    expect(banner!.affectedNow).toEqual([{ id: 'huggingface', name: 'huggingface', regions: ['ap-southeast-1'] }])
  })

  it('folds an AZ-suffixed token (us-east-1a) to its region', () => {
    expect([...awsRegionsNamedByService(svc('pinecone', 'degraded', [inc('Errors in us-east-1a')]))]).toEqual(['us-east-1'])
  })

  it('severity ignores an UNCORRELATED down region (worst-of the CORRELATED regions only)', () => {
    const banner = buildSupplyChainBanner([
      bedrockWith({ 'us-east-1': { level: 'degraded' as const }, 'eu-west-1': { level: 'down' as const } }),
      svc('pinecone', 'degraded', [pineconeUsEast1]), // names us-east-1 ONLY
    ])
    expect(banner!.severity).toBe('degraded') // NOT 'down' — eu-west-1 is nobody's corroborated cause
    expect(banner!.regions.map((r) => r.region)).toEqual(['us-east-1'])
  })

  it('region matching is case-insensitive on BOTH sides, and the health key keeps its original casing', () => {
    const banner = buildSupplyChainBanner([
      bedrockWith({ 'US-East-1': { level: 'degraded' as const } }),
      svc('pinecone', 'degraded', [inc('[AWS][US-EAST-1] Elevated errors')]),
    ])
    expect(banner!.regions.map((r) => r.region)).toEqual(['US-East-1'])
  })

  it('an empty awsRegionHealth ({}) → null', () => {
    expect(buildSupplyChainBanner([bedrockWith({}), svc('pinecone', 'degraded', [pineconeUsEast1])])).toBeNull()
  })

  it('several dependents correlating on DIFFERENT degraded regions → both listed, severity worst-of', () => {
    const banner = buildSupplyChainBanner([
      bedrockWith({ 'us-east-1': { level: 'degraded' as const }, 'eu-west-1': { level: 'down' as const }, ...ME_REGIONS }, 'degraded', [inc('Errors', '', ['eu-west-1'])]),
      svc('pinecone', 'degraded', [pineconeUsEast1]),
    ])
    expect(banner!.affectedNow.map((s) => s.id).sort()).toEqual(['bedrock', 'pinecone'])
    expect(banner!.regions.map((r) => r.region).sort()).toEqual(['eu-west-1', 'us-east-1']) // NOT the me-* pair
    expect(banner!.severity).toBe('down') // from eu-west-1, a CORRELATED region

    // #1000 — each affected service carries ONLY the regions IT named. The is-down page renders a
    // per-service causal claim from this; the banner-wide union would tell Pinecone's readers that its
    // outage is attributed to eu-west-1, which Pinecone never mentioned.
    const byId = Object.fromEntries(banner!.affectedNow.map((s) => [s.id, s.regions]))
    expect(byId.pinecone).toEqual(['us-east-1'])
    expect(byId.bedrock).toEqual(['eu-west-1'])
  })

  it('affectedNow.regions keeps AWS\'s original region casing (what the page prints)', () => {
    const banner = buildSupplyChainBanner([
      bedrockWith({ 'US-East-1': { level: 'degraded' as const } }),
      svc('pinecone', 'degraded', [inc('[AWS][us-east-1] Elevated errors')]),
    ])
    expect(banner!.affectedNow[0].regions).toEqual(['US-East-1'])
  })
})

// AWS files its region-less services (Route 53 / IAM / CloudFront / STS) under `region: "global"`.
// awsRegionsNamedByService only emits <area>-<direction>-<n> tokens, so `global` can never enter the
// intersection — a global-only event cannot correlate and the banner stays silent. That is a DELIBERATE
// under-claim, not an oversight: treating `global` as a wildcard ("degraded everywhere → can't
// contradict anyone") was implemented and reverted, because non-contradiction is not corroboration —
// it let a CloudFront advisory attribute Pinecone's routine us-east-1 freshness lag, i.e. #1000 again.
// These tests pin the gap so nobody "fixes" it back.
describe('global AWS events (#1000 — deliberately do NOT correlate)', () => {
  const GLOBAL_DOWN = { global: { level: 'down' as const, summary: 'Route 53 operational issue' } }
  const pineconeUsEast1 = inc('[Serverless][AWS][us-east-1] Increase in freshness lag', '', ['AWS us-east-1'])

  it('a global-only AWS event does NOT attribute a dependent degraded in a real region', () => {
    expect(buildSupplyChainBanner([bedrockWith(GLOBAL_DOWN), svc('pinecone', 'degraded', [pineconeUsEast1])])).toBeNull()
  })

  it('a global event alongside a CORRELATED region → banner fires, but global stays out of the headline', () => {
    const banner = buildSupplyChainBanner([
      bedrockWith({ ...GLOBAL_DOWN, 'us-east-1': { level: 'degraded' as const } }),
      svc('pinecone', 'degraded', [pineconeUsEast1]),
    ])
    expect(banner!.affectedNow.map((s) => s.id)).toEqual(['pinecone'])
    expect(banner!.regions.map((r) => r.region)).toEqual(['us-east-1']) // NOT 'global' — nobody named it
    expect(banner!.severity).toBe('degraded') // the global `down` must not inflate a correlated `degraded`
  })

  it('a region-SHAPED but bogus token (cert id, DNS record) extracts no region', () => {
    const junk = svc('pinecone', 'degraded', [inc('ca-cert-1 rotation failed; me-too-1; mx-record-1 update')])
    expect(awsRegionsNamedByService(junk).size).toBe(0)
  })
})
