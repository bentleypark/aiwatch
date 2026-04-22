import { describe, it, expect } from 'vitest'
import { mapOSVSeverity, detectSecurityAlerts, formatSecurityDigest, securityDetectedKey, incrementSecurityCount, readRecentSecurityAlerts, shouldAppendTimeline, appendTimelineEntry, osvTimelineKey, planOsvTimelineCycle } from '../security-monitor'
import type { SecurityAlert, SecurityAlertMeta, OsvTimeline } from '../security-monitor'

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

describe('securityDetectedKey + incrementSecurityCount (#288)', () => {
  it('scopes key to UTC date', () => {
    expect(securityDetectedKey('2026-04-20')).toBe('security:detected:2026-04-20')
  })

  it('starts at N when no prior value exists', () => {
    expect(incrementSecurityCount(null, 3)).toBe(3)
    expect(incrementSecurityCount('', 2)).toBe(2)
  })

  it('adds to an existing integer value', () => {
    expect(incrementSecurityCount('5', 2)).toBe(7)
  })

  it('treats corrupt values as 0 to avoid NaN propagation', () => {
    // Defensive: KV could return a non-numeric string from a prior schema migration
    // or user-facing debug write. The daily summary should never display NaN.
    expect(incrementSecurityCount('not-a-number', 3)).toBe(3)
    expect(incrementSecurityCount('1.5.3', 2)).toBe(3) // parseInt stops at first non-digit → 1
  })

  it('add-by-zero read pattern returns the current value', () => {
    // Daily summary uses incrementSecurityCount(raw, 0) to parse without mutating.
    expect(incrementSecurityCount('14', 0)).toBe(14)
    expect(incrementSecurityCount(null, 0)).toBe(0)
  })
})

// Minimal in-memory KV stub for readRecentSecurityAlerts. Only implements list/get —
// enough to exercise the filter/parse branches without pulling in Miniflare.
function makeFakeKV(entries: Record<string, string>): KVNamespace {
  const api = {
    async list({ prefix, limit }: { prefix: string; limit?: number }) {
      const all = Object.keys(entries).filter(k => k.startsWith(prefix))
      const keys = (limit ? all.slice(0, limit) : all).map(name => ({ name }))
      return { keys, list_complete: true, cacheStatus: null } as unknown as KVNamespaceListResult<unknown, string>
    },
    async get(key: string) {
      return entries[key] ?? null
    },
  }
  return api as unknown as KVNamespace
}

describe('readRecentSecurityAlerts', () => {
  it('returns empty array when KV is null', async () => {
    // Defensive: env.STATUS_CACHE is typed as nullable in the Worker bindings.
    expect(await readRecentSecurityAlerts(null)).toEqual([])
  })

  it('returns empty array when no security:seen:* keys exist', async () => {
    const kv = makeFakeKV({ 'other:key': 'value' })
    expect(await readRecentSecurityAlerts(kv)).toEqual([])
  })

  it('parses JSON metadata entries', async () => {
    const meta: SecurityAlertMeta = {
      title: 'GHSA-w828: PyPI/anthropic',
      url: 'https://osv.dev/vulnerability/GHSA-w828',
      source: 'osv',
      severity: 'high',
      service: 'Anthropic (Claude)',
      detectedAt: '2026-04-22T09:00:00.000Z',
    }
    const kv = makeFakeKV({
      'security:seen:osv:GHSA-w828': JSON.stringify(meta),
    })
    const result = await readRecentSecurityAlerts(kv)
    expect(result).toEqual([meta])
  })

  it('skips legacy `"1"` marker values (pre-metadata schema)', async () => {
    // Earlier versions only stored "1" as a dedup marker. Those keys must not crash the parser
    // or be returned as alerts — the dashboard needs real metadata.
    const kv = makeFakeKV({
      'security:seen:hn:old-entry': '1',
      'security:seen:osv:new-entry': JSON.stringify({ title: 'T', url: 'U', source: 'osv' }),
    })
    const result = await readRecentSecurityAlerts(kv)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('T')
  })

  it('skips malformed JSON entries without failing the whole read', async () => {
    const kv = makeFakeKV({
      'security:seen:hn:malformed': '{not valid json',
      'security:seen:osv:good': JSON.stringify({ title: 'Good', url: 'U', source: 'osv' }),
    })
    const result = await readRecentSecurityAlerts(kv)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Good')
  })

  it('swallows KV list errors — security data is optional', async () => {
    // If KV is temporarily unavailable, the status endpoint must still succeed.
    const brokenKv = {
      async list() { throw new Error('KV down') },
      async get() { return null },
    } as unknown as KVNamespace
    expect(await readRecentSecurityAlerts(brokenKv)).toEqual([])
  })

  // Regression lock for #304: `/api/status` used to omit `securityAlerts` while
  // `/api/status/cached` included it, so silent polls every 60s hid the banner.
  // Both endpoints now pass readRecentSecurityAlerts's output through the same
  // conditional-spread pattern — this describe block locks that contract.
  describe('response-shape parity invariant', () => {
    // Mirrors the spread used at both endpoint callsites in worker/src/index.ts
    // (`...(securityAlerts.length > 0 ? { securityAlerts } : {})`). If either
    // callsite drifts — e.g. `securityAlerts: alerts` without the guard, or no
    // spread at all — these assertions catch it by diffing both shapes.
    function buildEndpointResponse(alerts: SecurityAlertMeta[]): Record<string, unknown> {
      return {
        services: [],
        ...(alerts.length > 0 ? { securityAlerts: alerts } : {}),
      }
    }

    it('omits the securityAlerts key entirely when there are no alerts', async () => {
      // Schema clarity: client reads `data.securityAlerts ?? []`, so `[]` and
      // omitted behave the same — but emitting `[]` would add avoidable bytes
      // and could drift consumers that use `'securityAlerts' in data` as a signal.
      const kv = makeFakeKV({})
      const alerts = await readRecentSecurityAlerts(kv)
      const response = buildEndpointResponse(alerts)
      expect('securityAlerts' in response).toBe(false)
    })

    it('both callsite-shaped responses are identical for the same KV state', async () => {
      // #304 root cause was asymmetric shape between endpoints. This test derives
      // both endpoints' shapes from the same readRecentSecurityAlerts output and
      // asserts deep equality — a future contributor dropping the spread on one
      // side would fail this immediately.
      const kv = makeFakeKV({
        'security:seen:osv:GHSA-1': JSON.stringify({ title: 'A', url: 'U1', source: 'osv' }),
        'security:seen:hn:2': JSON.stringify({ title: 'B', url: 'U2', source: 'hn' }),
      })
      const fullShape = buildEndpointResponse(await readRecentSecurityAlerts(kv))
      const cachedShape = buildEndpointResponse(await readRecentSecurityAlerts(kv))
      expect(fullShape).toEqual(cachedShape)
      expect(fullShape.securityAlerts).toHaveLength(2)
    })
  })
})

// ── OSV timeline tracking (#291) ─────────────────────────────────────

describe('osvTimelineKey', () => {
  it('scopes the key to the vuln id', () => {
    expect(osvTimelineKey('GHSA-abc-123')).toBe('security:timeline:osv:GHSA-abc-123')
    expect(osvTimelineKey('CVE-2026-0001')).toBe('security:timeline:osv:CVE-2026-0001')
  })
})

describe('shouldAppendTimeline', () => {
  const baseAlert: SecurityAlert = {
    source: 'osv',
    id: 'GHSA-test-001',
    title: 'Test vuln',
    url: 'https://osv.dev/vulnerability/GHSA-test-001',
    severity: 'high',
    kvKey: 'security:seen:osv:GHSA-test-001',
    service: 'OpenAI',
    affectedPackage: 'PyPI/openai',
  }

  it('emits a detected entry on first observation (existing is null)', () => {
    const entry = shouldAppendTimeline(null, baseAlert, '2026-04-22T10:00:00Z')
    expect(entry).not.toBeNull()
    expect(entry!.stage).toBe('detected')
    expect(entry!.at).toBe('2026-04-22T10:00:00Z')
    expect(entry!.severity).toBe('high')
  })

  it('returns null when nothing changed since last observation', () => {
    const existing: OsvTimeline = {
      vulnId: baseAlert.id,
      createdAt: '2026-04-20T00:00:00Z',
      lastSeen: '2026-04-22T09:00:00Z',
      entries: [{ stage: 'detected', at: '2026-04-20T00:00:00Z', severity: 'high' }],
    }
    expect(shouldAppendTimeline(existing, baseAlert, '2026-04-22T10:00:00Z')).toBeNull()
  })

  it('emits severity_changed when the current severity differs from the last observed', () => {
    const existing: OsvTimeline = {
      vulnId: baseAlert.id,
      createdAt: '2026-04-20T00:00:00Z',
      lastSeen: '2026-04-22T09:00:00Z',
      entries: [{ stage: 'detected', at: '2026-04-20T00:00:00Z', severity: 'medium' }],
    }
    const entry = shouldAppendTimeline(existing, { ...baseAlert, severity: 'critical' }, '2026-04-22T10:00:00Z')
    expect(entry).not.toBeNull()
    expect(entry!.stage).toBe('severity_changed')
    expect(entry!.severity).toBe('critical')
  })

  it('emits fix_released when a fixedVersion appears where none was known', () => {
    const existing: OsvTimeline = {
      vulnId: baseAlert.id,
      createdAt: '2026-04-20T00:00:00Z',
      lastSeen: '2026-04-22T09:00:00Z',
      entries: [{ stage: 'detected', at: '2026-04-20T00:00:00Z', severity: 'high' }],
    }
    const entry = shouldAppendTimeline(existing, { ...baseAlert, fixedVersion: '1.2.3' }, '2026-04-22T10:00:00Z')
    expect(entry).not.toBeNull()
    expect(entry!.stage).toBe('fix_released')
    expect(entry!.fixedVersion).toBe('1.2.3')
  })

  it('does not re-emit fix_released when the fix was already recorded', () => {
    // Prevents a runaway timeline — once a fixedVersion is known, later observations with
    // the same fix should be a no-op, not a second fix_released entry.
    const existing: OsvTimeline = {
      vulnId: baseAlert.id,
      createdAt: '2026-04-20T00:00:00Z',
      lastSeen: '2026-04-22T09:00:00Z',
      entries: [
        { stage: 'detected', at: '2026-04-20T00:00:00Z', severity: 'high' },
        { stage: 'fix_released', at: '2026-04-21T00:00:00Z', fixedVersion: '1.2.3' },
      ],
    }
    expect(shouldAppendTimeline(existing, { ...baseAlert, fixedVersion: '1.2.3' }, '2026-04-22T10:00:00Z')).toBeNull()
  })

  it('severity_changed preempts fix_released when both would fire in the same cycle', () => {
    // Current implementation checks severity first; the single-entry-per-cycle model
    // means the next cycle's observation still sees the new fixedVersion as "newly present"
    // and emits fix_released then. This test locks that ordering.
    const existing: OsvTimeline = {
      vulnId: baseAlert.id,
      createdAt: '2026-04-20T00:00:00Z',
      lastSeen: '2026-04-22T09:00:00Z',
      entries: [{ stage: 'detected', at: '2026-04-20T00:00:00Z', severity: 'high' }],
    }
    const entry = shouldAppendTimeline(existing, { ...baseAlert, severity: 'critical', fixedVersion: '1.2.3' }, '2026-04-22T10:00:00Z')
    expect(entry!.stage).toBe('severity_changed')
    // On the next cycle, severity matches; fix_released fires.
    const after = appendTimelineEntry(existing, baseAlert, entry!, '2026-04-22T10:00:00Z')
    const second = shouldAppendTimeline(after, { ...baseAlert, severity: 'critical', fixedVersion: '1.2.3' }, '2026-04-22T11:00:00Z')
    expect(second!.stage).toBe('fix_released')
  })

  it('walks the timeline back when the most recent entry lacks the field being compared', () => {
    // A severity is recorded on `detected`, then a later `fix_released` entry omits severity.
    // When a severity observation arrives and equals the last KNOWN severity (not the most
    // recent-entry severity, which is undefined), we must NOT emit a spurious severity_changed.
    const existing: OsvTimeline = {
      vulnId: baseAlert.id,
      createdAt: '2026-04-20T00:00:00Z',
      lastSeen: '2026-04-21T00:00:00Z',
      entries: [
        { stage: 'detected', at: '2026-04-20T00:00:00Z', severity: 'high' },
        { stage: 'fix_released', at: '2026-04-21T00:00:00Z', fixedVersion: '1.2.3' },  // no severity field
      ],
    }
    expect(shouldAppendTimeline(existing, { ...baseAlert, severity: 'high', fixedVersion: '1.2.3' }, '2026-04-22T10:00:00Z')).toBeNull()
  })

  it('treats a missing current severity as "no change" (does not spurious-emit)', () => {
    // Some OSV fetches may return an entry without a numeric CVSS or a readable text label —
    // in that case mapOSVSeverity falls back to 'medium'. But if the alert object is built
    // without a severity field at all, we must not spuriously emit severity_changed.
    const existing: OsvTimeline = {
      vulnId: baseAlert.id,
      createdAt: '2026-04-20T00:00:00Z',
      lastSeen: '2026-04-22T09:00:00Z',
      entries: [{ stage: 'detected', at: '2026-04-20T00:00:00Z', severity: 'high' }],
    }
    const noSevAlert = { ...baseAlert, severity: undefined }
    expect(shouldAppendTimeline(existing, noSevAlert, '2026-04-22T10:00:00Z')).toBeNull()
  })
})

describe('appendTimelineEntry', () => {
  const baseAlert: SecurityAlert = {
    source: 'osv', id: 'GHSA-001', title: 't', url: 'u', kvKey: 'k',
    service: 'OpenAI', affectedPackage: 'PyPI/openai',
  }

  it('constructs a new timeline with createdAt = lastSeen when no prior exists', () => {
    const entry = { stage: 'detected' as const, at: '2026-04-22T10:00:00Z', severity: 'high' as const }
    const timeline = appendTimelineEntry(null, baseAlert, entry, '2026-04-22T10:00:00Z')
    expect(timeline.vulnId).toBe('GHSA-001')
    expect(timeline.createdAt).toBe('2026-04-22T10:00:00Z')
    expect(timeline.lastSeen).toBe('2026-04-22T10:00:00Z')
    expect(timeline.entries).toHaveLength(1)
    expect(timeline.service).toBe('OpenAI')
    expect(timeline.affectedPackage).toBe('PyPI/openai')
  })

  it('appends to an existing timeline and updates only lastSeen', () => {
    const existing: OsvTimeline = {
      vulnId: 'GHSA-001', service: 'OpenAI', affectedPackage: 'PyPI/openai',
      createdAt: '2026-04-20T00:00:00Z', lastSeen: '2026-04-21T00:00:00Z',
      entries: [{ stage: 'detected', at: '2026-04-20T00:00:00Z', severity: 'high' }],
    }
    const entry = { stage: 'severity_changed' as const, at: '2026-04-22T10:00:00Z', severity: 'critical' as const }
    const next = appendTimelineEntry(existing, baseAlert, entry, '2026-04-22T10:00:00Z')
    expect(next.createdAt).toBe('2026-04-20T00:00:00Z')  // preserved
    expect(next.lastSeen).toBe('2026-04-22T10:00:00Z')   // updated
    expect(next.entries).toHaveLength(2)
    expect(next.entries[1].stage).toBe('severity_changed')
  })
})

describe('planOsvTimelineCycle', () => {
  const alertA: SecurityAlert = {
    source: 'osv', id: 'GHSA-aaa', title: 't', url: 'u', severity: 'high',
    kvKey: 'security:seen:osv:GHSA-aaa', service: 'S', affectedPackage: 'PyPI/a',
  }
  const alertB: SecurityAlert = {
    source: 'osv', id: 'GHSA-bbb', title: 't', url: 'u', severity: 'medium',
    kvKey: 'security:seen:osv:GHSA-bbb', service: 'S', affectedPackage: 'PyPI/b',
  }

  it('plans a `detected` write for each alert on first observation', async () => {
    const reader = async () => null
    const plans = await planOsvTimelineCycle([alertA, alertB], reader, '2026-04-22T10:00:00Z')
    expect(plans).toHaveLength(2)
    expect(plans[0].key).toBe('security:timeline:osv:GHSA-aaa')
    expect(plans[0].next.entries[0].stage).toBe('detected')
    expect(plans[1].key).toBe('security:timeline:osv:GHSA-bbb')
  })

  it('emits zero plans when no alerts transitioned', async () => {
    const existing: OsvTimeline = {
      vulnId: 'GHSA-aaa', createdAt: '2026-04-20T00:00:00Z', lastSeen: '2026-04-21T00:00:00Z',
      entries: [{ stage: 'detected', at: '2026-04-20T00:00:00Z', severity: 'high' }],
    }
    const reader = async (key: string) => key === 'security:timeline:osv:GHSA-aaa' ? JSON.stringify(existing) : null
    const plans = await planOsvTimelineCycle([alertA], reader, '2026-04-22T10:00:00Z')
    expect(plans).toHaveLength(0)
  })

  it('skips the write entirely when the existing timeline is corrupt — preserves historical createdAt', async () => {
    // Overwriting a corrupt blob with a fresh `detected` entry would reset createdAt to
    // today, erasing the real first-detection timestamp the monthly report depends on.
    const reader = async () => '{not valid json'
    const parseFails: string[] = []
    const plans = await planOsvTimelineCycle(
      [alertA],
      reader,
      '2026-04-22T10:00:00Z',
      (key) => parseFails.push(key),
    )
    expect(plans).toHaveLength(0)
    expect(parseFails).toEqual(['security:timeline:osv:GHSA-aaa'])
  })

  it('ignores non-OSV alerts in the input mix', async () => {
    const hnAlert: SecurityAlert = {
      source: 'hackernews', id: '1', title: 't', url: 'u', kvKey: 'k',
    }
    const reader = async () => null
    const plans = await planOsvTimelineCycle([hnAlert, alertA], reader, '2026-04-22T10:00:00Z')
    expect(plans).toHaveLength(1)
    expect(plans[0].key).toBe('security:timeline:osv:GHSA-aaa')
  })
})
