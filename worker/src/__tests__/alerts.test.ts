import { describe, it, expect, vi } from 'vitest'
import { buildIncidentAlerts, buildServiceAlerts, mergeTogetherAlerts, formatDetectionLead } from '../alerts'
import type { AlertCandidate, ScoredService } from '../alerts'

const NOW = 1742860800000 // fixed timestamp for deterministic tests
const recentDate = new Date(NOW - 3600_000).toISOString() // 1h ago
const oldDate = new Date(NOW - 90_000_000).toISOString() // 25h ago

function mockService(overrides: Partial<ScoredService> = {}): ScoredService {
  return {
    id: 'openai',
    name: 'OpenAI API',
    provider: 'OpenAI',
    category: 'api',
    status: 'operational',
    statusUrl: 'https://status.openai.com',
    incidents: [],
    uptime30d: 99.5,
    latency: 200,
    aiwatchScore: 85,
    scoreGrade: 'good',
    ...overrides,
  } as ScoredService
}

describe('buildIncidentAlerts', () => {
  it('creates new incident alert for recent non-resolved incident', () => {
    const svc = mockService({
      incidents: [{ id: 'inc1', title: 'API Error', status: 'investigating', startedAt: recentDate, impact: 'major' }],
    })
    const alerts = buildIncidentAlerts([svc], new Set(), NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].key).toBe('alerted:new:inc1')
    expect(alerts[0].title).toContain('New Incident')
  })

  it('skips already-alerted new incidents', () => {
    const svc = mockService({
      incidents: [{ id: 'inc1', title: 'API Error', status: 'investigating', startedAt: recentDate, impact: 'major' }],
    })
    const alerts = buildIncidentAlerts([svc], new Set(['inc1']), NOW)
    expect(alerts).toHaveLength(0)
  })

  it('skips incidents older than 24 hours', () => {
    const svc = mockService({
      incidents: [{ id: 'inc1', title: 'Old Error', status: 'investigating', startedAt: oldDate, impact: 'major' }],
    })
    const alerts = buildIncidentAlerts([svc], new Set(), NOW)
    expect(alerts).toHaveLength(0)
  })

  it('creates resolved alert only if previously alerted as new', () => {
    const svc = mockService({
      incidents: [{ id: 'inc1', title: 'Fixed', status: 'resolved', startedAt: recentDate, duration: '30m', impact: 'major' }],
    })

    // Not previously alerted → no resolved alert
    expect(buildIncidentAlerts([svc], new Set(), NOW)).toHaveLength(0)

    // Previously alerted → resolved alert
    const alerts = buildIncidentAlerts([svc], new Set(['inc1']), NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].key).toBe('alerted:res:inc1')
    expect(alerts[0].title).toContain('Resolved (30m)')
  })

  it('includes fallback text as separate field for degraded service', () => {
    const openai = mockService({
      id: 'openai', status: 'degraded',
      incidents: [{ id: 'inc1', title: 'Slow', status: 'investigating', startedAt: recentDate, impact: 'minor' }],
    })
    const claude = mockService({ id: 'claude', name: 'Claude API', aiwatchScore: 90 })
    const alerts = buildIncidentAlerts([openai, claude], new Set(), NOW)
    expect(alerts[0].description).toBe('Slow')
    expect(alerts[0].fallbackText).toContain('Suggested fallback')
  })

  it('omits fallback when service is operational (incident without outage)', () => {
    const openai = mockService({
      id: 'openai', status: 'operational',
      incidents: [{ id: 'inc1', title: 'Minor issue', status: 'investigating', startedAt: recentDate, impact: 'minor' }],
    })
    const claude = mockService({ id: 'claude', name: 'Claude API', aiwatchScore: 90 })
    const alerts = buildIncidentAlerts([openai, claude], new Set(), NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].fallbackText).toBe('')
    expect(alerts[0].description).toBe('Minor issue')
  })

  it('handles service with no incidents', () => {
    const svc = mockService({ incidents: [] })
    expect(buildIncidentAlerts([svc], new Set(), NOW)).toHaveLength(0)
  })

  it('generates duplicate alerts for shared-status-page services (caller must dedup by key)', () => {
    // Claude API, claude.ai, Claude Code share Anthropic status page → same inc.id
    const sharedIncident = { id: 'shared1', title: 'Elevated errors', status: 'investigating', startedAt: recentDate, impact: 'major' }
    const claude = mockService({ id: 'claude', name: 'Claude API', category: 'api', incidents: [sharedIncident] })
    const claudeai = mockService({ id: 'claudeai', name: 'claude.ai', category: 'app', incidents: [sharedIncident] })
    const claudecode = mockService({ id: 'claudecode', name: 'Claude Code', category: 'agent', incidents: [sharedIncident] })

    const alerts = buildIncidentAlerts([claude, claudeai, claudecode], new Set(), NOW)

    // buildIncidentAlerts produces one alert per service — all with the same key
    expect(alerts).toHaveLength(3)
    expect(alerts[0].key).toBe('alerted:new:shared1')
    expect(alerts[1].key).toBe('alerted:new:shared1')
    expect(alerts[2].key).toBe('alerted:new:shared1')
    // Different service names
    expect(alerts[0].title).toContain('Claude API')
    expect(alerts[1].title).toContain('claude.ai')
    expect(alerts[2].title).toContain('Claude Code')

    // Caller (cronAlertCheck) uses seenKeys Set to dedup → only first is sent
    const seenKeys = new Set<string>()
    const deduped = alerts.filter(a => {
      if (seenKeys.has(a.key)) return false
      seenKeys.add(a.key)
      return true
    })
    expect(deduped).toHaveLength(1)
    expect(deduped[0].title).toContain('Claude API')
  })

  it('shows same-category fallback only for shared incidents (no cross-category)', () => {
    const sharedIncident = { id: 'shared2', title: 'Opus errors', status: 'investigating', startedAt: recentDate, impact: 'major' }
    const claude = mockService({ id: 'claude', name: 'Claude API', category: 'api', status: 'degraded', incidents: [sharedIncident], aiwatchScore: 80 })
    const claudecode = mockService({ id: 'claude-code', name: 'Claude Code', category: 'agent', status: 'degraded', incidents: [sharedIncident], aiwatchScore: 70 })
    const openai = mockService({ id: 'openai', name: 'OpenAI API', category: 'api', status: 'operational', aiwatchScore: 90 })
    const cursor = mockService({ id: 'cursor', name: 'Cursor', category: 'agent', status: 'operational', aiwatchScore: 75 })

    const alerts = buildIncidentAlerts([claude, claudecode, openai, cursor], new Set(), NOW)
    // Dedup: only first alert for shared2 is sent
    const first = alerts.find(a => a.key === 'alerted:new:shared2')!
    // Claude API alert should only have API fallbacks, not Coding Agent
    expect(first.fallbackText).toContain('OpenAI API')
    expect(first.fallbackText).not.toContain('Cursor')
    expect(first.fallbackText).not.toContain('Coding Agent')
  })

  it('handles multiple incidents per service', () => {
    const svc = mockService({
      incidents: [
        { id: 'inc1', title: 'Error 1', status: 'investigating', startedAt: recentDate, impact: 'major' },
        { id: 'inc2', title: 'Error 2', status: 'resolved', startedAt: recentDate, duration: '10m', impact: 'minor' },
      ],
    })
    const alerts = buildIncidentAlerts([svc], new Set(['inc2']), NOW)
    expect(alerts).toHaveLength(2)
    expect(alerts[0].key).toBe('alerted:new:inc1')
    expect(alerts[1].key).toBe('alerted:res:inc2')
  })
})

describe('buildServiceAlerts', () => {
  it('creates down alert for service with status down (no ongoing incidents)', () => {
    const svc = mockService({ status: 'down' })
    const alerts = buildServiceAlerts([svc], new Map(), new Map())
    expect(alerts).toHaveLength(1)
    expect(alerts[0].key).toBe('alerted:down:openai')
    expect(alerts[0].title).toContain('Service Down')
    expect(alerts[0].color).toBe(0xED4245) // red
  })

  it('creates degraded alert for service with status degraded (no ongoing incidents)', () => {
    const svc = mockService({ status: 'degraded' })
    const alerts = buildServiceAlerts([svc], new Map(), new Map())
    expect(alerts).toHaveLength(1)
    expect(alerts[0].key).toBe('alerted:degraded:openai')
    expect(alerts[0].title).toContain('Partially Degraded')
    expect(alerts[0].color).toBe(0xE86235) // amber
  })

  it('suppresses status alert when ongoing incidents exist', () => {
    const svc = mockService({
      status: 'degraded',
      incidents: [{ id: 'inc1', title: 'Errors', status: 'investigating', startedAt: recentDate, impact: 'major' }],
    })
    const alerts = buildServiceAlerts([svc], new Map(), new Map())
    expect(alerts).toHaveLength(0)
  })

  it('suppresses down alert when ongoing incidents exist', () => {
    const svc = mockService({
      status: 'down',
      incidents: [{ id: 'inc1', title: 'Outage', status: 'identified', startedAt: recentDate, impact: 'critical' }],
    })
    const alerts = buildServiceAlerts([svc], new Map(), new Map())
    expect(alerts).toHaveLength(0)
  })

  it('does not suppress when all incidents are resolved', () => {
    const svc = mockService({
      status: 'degraded',
      incidents: [{ id: 'inc1', title: 'Fixed', status: 'resolved', startedAt: recentDate, duration: '10m', impact: 'minor' }],
    })
    const alerts = buildServiceAlerts([svc], new Map(), new Map())
    expect(alerts).toHaveLength(1)
    expect(alerts[0].key).toBe('alerted:degraded:openai')
  })

  it('does not create alert for operational service', () => {
    const svc = mockService({ status: 'operational' })
    expect(buildServiceAlerts([svc], new Map(), new Map())).toHaveLength(0)
  })

  it('creates recovery alert if previously alerted as down', () => {
    const svc = mockService({ status: 'operational' })
    const alerts = buildServiceAlerts([svc], new Map([['openai', '2026-03-24T00:00:00Z']]), new Map())
    expect(alerts).toHaveLength(1)
    expect(alerts[0].key).toBe('alerted:recovered:openai')
    expect(alerts[0].title).toContain('Service Recovered')
    expect(alerts[0].color).toBe(0x57F287)
  })

  it('creates recovery alert if previously alerted as degraded', () => {
    const svc = mockService({ status: 'operational' })
    const alerts = buildServiceAlerts([svc], new Map(), new Map([['openai', '2026-03-24T00:00:00Z']]))
    expect(alerts).toHaveLength(1)
    expect(alerts[0].key).toBe('alerted:recovered:openai')
  })

  it('creates both down and recovery alerts for different services', () => {
    const downSvc = mockService({ id: 'openai', name: 'OpenAI API', status: 'down' })
    const recoveredSvc = mockService({ id: 'claude', name: 'Claude API', status: 'operational' })
    const alerts = buildServiceAlerts([downSvc, recoveredSvc], new Map([['claude', '2026-03-24T00:00:00Z']]), new Map())
    expect(alerts).toHaveLength(2)
    expect(alerts[0].key).toBe('alerted:down:openai')
    expect(alerts[1].key).toBe('alerted:recovered:claude')
  })

  it('includes downtime duration in recovery alert title', () => {
    const svc = mockService({ status: 'operational' })
    // Alerted 45 minutes ago
    const alertedAt = new Date(Date.now() - 45 * 60_000).toISOString()
    const alerts = buildServiceAlerts([svc], new Map([['openai', alertedAt]]), new Map())
    expect(alerts).toHaveLength(1)
    expect(alerts[0].title).toContain('Service Recovered')
    expect(alerts[0].title).toMatch(/\(.*4[56]m.*\)/)
  })

  it('includes downtime duration from degraded alert in recovery', () => {
    const svc = mockService({ status: 'operational' })
    const alertedAt = new Date(Date.now() - 2 * 3600_000 - 10 * 60_000).toISOString()
    const alerts = buildServiceAlerts([svc], new Map(), new Map([['openai', alertedAt]]))
    expect(alerts).toHaveLength(1)
    expect(alerts[0].title).toMatch(/\(.*2h 1[01]m.*\)/)
  })

  it('handles legacy "1" value gracefully (no duration)', () => {
    const svc = mockService({ status: 'operational' })
    const alerts = buildServiceAlerts([svc], new Map([['openai', '1']]), new Map())
    expect(alerts).toHaveLength(1)
    expect(alerts[0].title).toBe('🟢 OpenAI API — Service Recovered')
  })
})

describe('mergeTogetherAlerts', () => {
  function togetherNewAlert(incId: string, model: string): AlertCandidate {
    return {
      key: `alerted:new:${incId}`,
      title: '🔴 Together AI — New Incident',
      description: `${model} — down`,
      fallbackText: '👉 Suggested fallback: Fireworks AI',
      color: 0xED4245,
      url: `https://ai-watch.dev/#together`,
    }
  }

  function togetherResAlert(incId: string, model: string): AlertCandidate {
    return {
      key: `alerted:res:${incId}`,
      title: '🟢 Together AI — Incident Resolved (15m)',
      description: `${model} — recovered`,
      color: 0x57F287,
      url: `https://ai-watch.dev/#together`,
    }
  }

  it('merges multiple new Together AI alerts into one', () => {
    const alerts = [
      togetherNewAlert('inc1', 'FLUX.1 Krea [dev]'),
      togetherNewAlert('inc2', 'ZAI GLM 5 FP4'),
      togetherNewAlert('inc3', 'Kokoro-82M'),
    ]
    const result = mergeTogetherAlerts(alerts)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('🔴 Together AI — 3 New Incidents')
    expect(result[0].description).toContain('FLUX.1 Krea [dev]')
    expect(result[0].description).toContain('ZAI GLM 5 FP4')
    expect(result[0].description).toContain('Kokoro-82M')
    expect(result[0]._mergedKeys).toEqual(['alerted:new:inc1', 'alerted:new:inc2', 'alerted:new:inc3'])
    expect(result[0].fallbackText).toContain('Suggested fallback')
  })

  it('merges multiple resolved Together AI alerts into one', () => {
    const alerts = [
      togetherResAlert('inc1', 'FLUX.1 Krea [dev]'),
      togetherResAlert('inc2', 'ZAI GLM 5 FP4'),
    ]
    const result = mergeTogetherAlerts(alerts)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('🟢 Together AI — 2 Incidents Resolved')
    expect(result[0]._mergedKeys).toEqual(['alerted:res:inc1', 'alerted:res:inc2'])
  })

  it('passes through single Together AI alert unchanged', () => {
    const alerts = [togetherNewAlert('inc1', 'FLUX.1 Krea [dev]')]
    const result = mergeTogetherAlerts(alerts)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('🔴 Together AI — New Incident')
    expect(result[0]._mergedKeys).toBeUndefined()
  })

  it('does not merge non-Together alerts', () => {
    const alerts: AlertCandidate[] = [
      { key: 'alerted:new:abc', title: '🔴 OpenAI API — New Incident', description: 'API Error', color: 0xED4245, url: 'https://ai-watch.dev/#openai' },
      { key: 'alerted:new:def', title: '🔴 Claude API — New Incident', description: 'Timeout', color: 0xED4245, url: 'https://ai-watch.dev/#claude' },
    ]
    const result = mergeTogetherAlerts(alerts)
    expect(result).toHaveLength(2)
    expect(result[0].title).toContain('OpenAI')
    expect(result[1].title).toContain('Claude')
  })

  it('merges Together alerts while preserving non-Together alerts', () => {
    const alerts: AlertCandidate[] = [
      { key: 'alerted:new:abc', title: '🔴 OpenAI API — New Incident', description: 'API Error', color: 0xED4245, url: 'https://ai-watch.dev/#openai' },
      togetherNewAlert('inc1', 'FLUX.1 Krea [dev]'),
      togetherNewAlert('inc2', 'ZAI GLM 5 FP4'),
    ]
    const result = mergeTogetherAlerts(alerts)
    expect(result).toHaveLength(2)
    expect(result[0].title).toContain('OpenAI')
    expect(result[1].title).toBe('🔴 Together AI — 2 New Incidents')
  })

  it('handles mix of new and resolved Together alerts', () => {
    const alerts = [
      togetherNewAlert('inc1', 'FLUX.1 Krea [dev]'),
      togetherNewAlert('inc2', 'ZAI GLM 5 FP4'),
      togetherResAlert('inc3', 'Kokoro-82M'),
      togetherResAlert('inc4', 'Orpheus TTS'),
    ]
    const result = mergeTogetherAlerts(alerts)
    expect(result).toHaveLength(2)
    const newAlert = result.find(a => a.title.includes('New Incidents'))!
    const resAlert = result.find(a => a.title.includes('Resolved'))!
    expect(newAlert._mergedKeys).toHaveLength(2)
    expect(resAlert._mergedKeys).toHaveLength(2)
  })

  it('returns original array when no Together alerts present', () => {
    const alerts: AlertCandidate[] = [
      { key: 'alerted:new:abc', title: '🔴 OpenAI API — New Incident', description: 'Error', color: 0xED4245, url: '' },
    ]
    const result = mergeTogetherAlerts(alerts)
    expect(result).toBe(alerts) // same reference — no transformation
  })

  it('correctly merges alerts generated by buildIncidentAlerts (integration)', () => {
    const together = mockService({
      id: 'together', name: 'Together AI', status: 'degraded', category: 'api',
      incidents: [
        { id: 'inc1', title: 'FLUX.1 Krea [dev] — down', status: 'investigating', startedAt: recentDate, impact: 'major' },
        { id: 'inc2', title: 'ZAI GLM 5 FP4 — down', status: 'investigating', startedAt: recentDate, impact: 'major' },
        { id: 'inc3', title: 'Kokoro-82M — down', status: 'investigating', startedAt: recentDate, impact: 'major' },
      ],
    })
    const alerts = buildIncidentAlerts([together], new Set(), NOW)
    expect(alerts).toHaveLength(3)
    const merged = mergeTogetherAlerts(alerts)
    expect(merged).toHaveLength(1)
    expect(merged[0].title).toContain('3 New Incidents')
    expect(merged[0]._mergedKeys).toHaveLength(3)
  })

  it('correctly merges resolved alerts generated by buildIncidentAlerts (integration)', () => {
    const together = mockService({
      id: 'together', name: 'Together AI', status: 'operational', category: 'api',
      incidents: [
        { id: 'inc1', title: 'FLUX.1 Krea [dev]', status: 'resolved', startedAt: recentDate, duration: '13m', impact: 'major' },
        { id: 'inc2', title: 'ZAI GLM 5 FP4', status: 'resolved', startedAt: recentDate, duration: '15m', impact: 'major' },
      ],
    })
    const alerts = buildIncidentAlerts([together], new Set(['inc1', 'inc2']), NOW)
    expect(alerts).toHaveLength(2)
    const merged = mergeTogetherAlerts(alerts)
    expect(merged).toHaveLength(1)
    expect(merged[0].title).toContain('2 Incidents Resolved')
    expect(merged[0]._mergedKeys).toHaveLength(2)
  })
})

describe('formatDetectionLead', () => {
  it('returns lead text when detected before official report', () => {
    const detected = new Date(NOW - 10 * 60_000).toISOString() // 10min before startedAt
    const started = new Date(NOW).toISOString()
    const result = formatDetectionLead(detected, started)
    expect(result).toContain('Detection Lead: 10m')
    expect(result).toContain('AIWatch detected')
  })

  it('returns empty when detectedAt is null', () => {
    expect(formatDetectionLead(null, new Date(NOW).toISOString())).toBe('')
  })

  it('returns empty when detected after official report', () => {
    const detected = new Date(NOW + 5 * 60_000).toISOString()
    const started = new Date(NOW).toISOString()
    expect(formatDetectionLead(detected, started)).toBe('')
  })

  it('returns empty when lead is less than 1 minute', () => {
    const detected = new Date(NOW - 59_000).toISOString() // 59s before (floor → 0m)
    const started = new Date(NOW).toISOString()
    expect(formatDetectionLead(detected, started)).toBe('')
  })

  it('returns empty when lead exceeds 60 minutes (stale detection)', () => {
    const detected = new Date(NOW - 90 * 60_000).toISOString() // 90min before
    const started = new Date(NOW).toISOString()
    expect(formatDetectionLead(detected, started)).toBe('')
  })

  it('handles invalid date strings', () => {
    expect(formatDetectionLead('not-a-date', new Date(NOW).toISOString())).toBe('')
    expect(formatDetectionLead(new Date(NOW).toISOString(), 'not-a-date')).toBe('')
  })

  it('formats hour+minute label for exactly 60 min lead', () => {
    const detected = new Date(NOW - 60 * 60_000).toISOString()
    const started = new Date(NOW).toISOString()
    const result = formatDetectionLead(detected, started)
    expect(result).toContain('1h 0m')
  })

  it('returns result for 60.5 min (floor to 60, still within range)', () => {
    const detected = new Date(NOW - 60.5 * 60_000).toISOString()
    const started = new Date(NOW).toISOString()
    const result = formatDetectionLead(detected, started)
    expect(result).toContain('1h 0m')
  })
})
