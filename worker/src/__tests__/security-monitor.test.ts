import { describe, it, expect } from 'vitest'
import { mapOSVSeverity, detectSecurityAlerts, formatSecurityDigest } from '../security-monitor'
import type { SecurityAlert } from '../security-monitor'

describe('mapOSVSeverity', () => {
  it('maps critical (>= 9.0)', () => {
    expect(mapOSVSeverity({ id: 'X', modified: '', severity: [{ type: 'CVSS_V3', score: '9.0' }] })).toBe('critical')
    expect(mapOSVSeverity({ id: 'X', modified: '', severity: [{ type: 'CVSS_V3', score: '10.0' }] })).toBe('critical')
  })

  it('maps high (>= 7.0, < 9.0)', () => {
    expect(mapOSVSeverity({ id: 'X', modified: '', severity: [{ type: 'CVSS_V3', score: '7.0' }] })).toBe('high')
    expect(mapOSVSeverity({ id: 'X', modified: '', severity: [{ type: 'CVSS_V3', score: '8.9' }] })).toBe('high')
  })

  it('maps medium (>= 4.0, < 7.0)', () => {
    expect(mapOSVSeverity({ id: 'X', modified: '', severity: [{ type: 'CVSS_V3', score: '4.0' }] })).toBe('medium')
    expect(mapOSVSeverity({ id: 'X', modified: '', severity: [{ type: 'CVSS_V3', score: '6.9' }] })).toBe('medium')
  })

  it('maps low (< 4.0)', () => {
    expect(mapOSVSeverity({ id: 'X', modified: '', severity: [{ type: 'CVSS_V3', score: '3.9' }] })).toBe('low')
    expect(mapOSVSeverity({ id: 'X', modified: '', severity: [{ type: 'CVSS_V3', score: '0.1' }] })).toBe('low')
  })

  it('handles CVSS vector strings by falling back to database_specific.severity', () => {
    expect(mapOSVSeverity({
      id: 'X', modified: '',
      severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:L/AC:L/AT:N/PR:L/UI:N/VC:L/VI:L/VA:N/SC:N/SI:N/SA:N' }],
      database_specific: { severity: 'MODERATE' },
    })).toBe('medium')

    expect(mapOSVSeverity({
      id: 'X', modified: '',
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
      database_specific: { severity: 'CRITICAL' },
    })).toBe('critical')
  })

  it('defaults to medium when no severity data at all', () => {
    expect(mapOSVSeverity({ id: 'X', modified: '' })).toBe('medium')
    expect(mapOSVSeverity({ id: 'X', modified: '', severity: [] })).toBe('medium')
  })

  it('uses database_specific.severity text when no numeric score', () => {
    expect(mapOSVSeverity({ id: 'X', modified: '', database_specific: { severity: 'HIGH' } })).toBe('high')
    expect(mapOSVSeverity({ id: 'X', modified: '', database_specific: { severity: 'LOW' } })).toBe('low')
    expect(mapOSVSeverity({ id: 'X', modified: '', database_specific: { severity: 'CRITICAL' } })).toBe('critical')
  })

  it('prefers numeric CVSS score over database_specific text', () => {
    expect(mapOSVSeverity({
      id: 'X', modified: '',
      severity: [{ type: 'CVSS_V3', score: '3.9' }],
      database_specific: { severity: 'CRITICAL' },
    })).toBe('low')
  })
})

describe('detectSecurityAlerts', () => {
  it('returns empty when kv is null', async () => {
    const result = await detectSecurityAlerts(null)
    expect(result).toEqual([])
  })
})

describe('formatSecurityDigest', () => {
  it('formats single OSV alert with remediation', () => {
    const alerts: SecurityAlert[] = [{
      source: 'osv',
      id: 'GHSA-abc-123',
      title: 'RCE in openai package',
      url: 'https://osv.dev/vulnerability/GHSA-abc-123',
      severity: 'critical',
      kvKey: 'security:seen:osv:GHSA-abc-123',
      affectedPackage: 'PyPI/openai',
      affectedRange: '>= 1.0.0',
      fixedVersion: '1.0.1',
      patchUrl: 'https://github.com/openai/openai-python/commit/abc',
    }]
    const digest = formatSecurityDigest(alerts)
    expect(digest.title).toBe('🔒 Security Alert — 1 new finding')
    expect(digest.description).toContain('SDK Vulnerabilities (1)')
    expect(digest.description).toContain('GHSA-abc-123')
    expect(digest.description).toContain('pip install openai>=1.0.1')
    expect(digest.color).toBe(0xf85149) // critical → red
  })

  it('formats single HN alert', () => {
    const alerts: SecurityAlert[] = [{
      source: 'hackernews',
      id: '99999',
      title: 'OpenAI data breach',
      url: 'https://example.com/breach',
      kvKey: 'security:seen:hn:99999',
    }]
    const digest = formatSecurityDigest(alerts)
    expect(digest.title).toBe('🔒 Security Alert — 1 new finding')
    expect(digest.description).toContain('Security News (1)')
    expect(digest.description).toContain('OpenAI data breach')
    expect(digest.description).toContain('[HN]')
    expect(digest.description).toContain('[Source]')
  })

  it('groups mixed OSV + HN alerts into sections', () => {
    const alerts: SecurityAlert[] = [
      {
        source: 'osv', id: 'GHSA-1', title: 'Vuln A', url: 'https://osv.dev/1',
        severity: 'high', kvKey: 'k1', affectedPackage: 'PyPI/anthropic', fixedVersion: '2.0.0',
      },
      {
        source: 'osv', id: 'GHSA-2', title: 'Vuln B', url: 'https://osv.dev/2',
        severity: 'medium', kvKey: 'k2', affectedPackage: 'npm/@anthropic-ai/sdk',
      },
      {
        source: 'hackernews', id: '111', title: 'Claude security news',
        url: 'https://news.ycombinator.com/item?id=111', kvKey: 'k3',
      },
    ]
    const digest = formatSecurityDigest(alerts)
    expect(digest.title).toBe('🔒 Security Alert — 3 new findings')
    expect(digest.description).toContain('SDK Vulnerabilities (2)')
    expect(digest.description).toContain('Security News (1)')
    expect(digest.description).toContain('GHSA-1')
    expect(digest.description).toContain('GHSA-2')
    expect(digest.color).toBe(0xd29922) // highest is high → yellow
  })

  it('formats npm package with npm install command', () => {
    const alerts: SecurityAlert[] = [{
      source: 'osv', id: 'GHSA-npm', title: 'Path traversal',
      url: 'https://osv.dev/npm', severity: 'medium', kvKey: 'k',
      affectedPackage: 'npm/@anthropic-ai/sdk', fixedVersion: '0.81.0',
    }]
    const digest = formatSecurityDigest(alerts)
    expect(digest.description).toContain('npm install @anthropic-ai/sdk@0.81.0')
  })

  it('uses gray color when all alerts are medium/low', () => {
    const alerts: SecurityAlert[] = [{
      source: 'osv', id: 'X', title: 'Minor', url: 'u',
      severity: 'low', kvKey: 'k', affectedPackage: 'PyPI/x',
    }]
    expect(formatSecurityDigest(alerts).color).toBe(0x8b949e)
  })

  it('includes service name tag in OSV alert format', () => {
    const alerts: SecurityAlert[] = [{
      source: 'osv', id: 'GHSA-test', title: 'Vuln in transformers',
      url: 'https://osv.dev/test', severity: 'medium', kvKey: 'k',
      service: 'Hugging Face', affectedPackage: 'PyPI/transformers',
    }]
    const digest = formatSecurityDigest(alerts)
    expect(digest.description).toContain('[Hugging Face]')
    expect(digest.description).toContain('GHSA-test')
  })

  it('omits service tag when service is undefined', () => {
    const alerts: SecurityAlert[] = [{
      source: 'osv', id: 'GHSA-noservice', title: 'Generic vuln',
      url: 'https://osv.dev/x', severity: 'low', kvKey: 'k',
      affectedPackage: 'PyPI/unknown',
    }]
    const digest = formatSecurityDigest(alerts)
    // Should not contain a service tag like [Hugging Face], but [Details]/[HN] links are expected
    expect(digest.description).not.toMatch(/\[(?!Details|HN|Source)[A-Z][a-zA-Z ]+\]/)
    expect(digest.description).toContain('GHSA-noservice')
  })
})
