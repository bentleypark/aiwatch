import { describe, it, expect } from 'vitest'
import { buildSupplyChainBanner, SUPPLY_CHAIN_AWS_DEPS } from '../supply-chain'
import type { ServiceStatus, Incident } from '../types'

// Minimal ServiceStatus fixtures — only the fields buildSupplyChainBanner reads.
const inc = (title: string, timelineText = ''): Incident =>
  ({ id: 'i', title, status: 'investigating', impact: 'major', startedAt: '2026-06-22T00:00:00Z', duration: null,
     timeline: timelineText ? [{ stage: 'investigating', text: timelineText, at: '2026-06-22T00:00:00Z' }] : [] } as Incident)

const svc = (id: string, status: ServiceStatus['status'], incidents: Incident[] = []): ServiceStatus =>
  ({ id, name: id === 'claude' ? 'Claude API' : id, status, incidents } as ServiceStatus)

const bedrockWith = (regionHealth: ServiceStatus['awsRegionHealth'], status: ServiceStatus['status'] = 'operational') =>
  ({ id: 'bedrock', name: 'Amazon Bedrock', status, incidents: [], awsRegionHealth: regionHealth } as unknown as ServiceStatus)

const REGION = { 'us-east-1': { level: 'degraded' as const, summary: 'Increased error rates' } }
// an AWS-attributed incident (the service's own page blames AWS/upstream)
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

  it('Bedrock is AWS-native → auto-attributed (its incidents come from the AWS Health feed)', () => {
    const banner = buildSupplyChainBanner([bedrockWith(REGION, 'degraded')]) // no incident text needed
    expect(banner!.affectedNow.map((s) => s.id)).toEqual(['bedrock'])
  })

  it('GATE: AWS region degraded but NO dependent degraded → null', () => {
    expect(buildSupplyChainBanner([bedrockWith(REGION), svc('claude', 'operational')])).toBeNull()
  })

  it('GATE: a dependent attributes to AWS but NO region health → null', () => {
    expect(buildSupplyChainBanner([bedrockWith(undefined), svc('claude', 'degraded', [awsAttributed])])).toBeNull()
  })

  it('severity is worst-of the degraded regions (a down region → down)', () => {
    const banner = buildSupplyChainBanner([
      bedrockWith({ 'us-east-1': { level: 'degraded' }, 'eu-west-1': { level: 'down' } }),
      svc('claude', 'degraded', [awsAttributed]),
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
