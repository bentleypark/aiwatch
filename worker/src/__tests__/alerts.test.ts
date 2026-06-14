import { describe, it, expect, vi } from 'vitest'
import { buildIncidentAlerts, buildServiceAlerts, mergeTogetherAlerts, formatDetectionLead, isFlapNotice, normalizeFlapTitle, flapSuppressionKey, isFlapSuppressible, shouldHoldNewIncident, pendingNewKey, PENDING_NEW_TTL_S, buildRegionHint, parseAlertedRoster } from '../alerts'
import type { AlertCandidate, ScoredService } from '../alerts'
import type { Incident } from '../types'

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

// #545: buildIncidentAlerts now takes incidentId → Set<already-alerted svcId> (was Set<incId>).
// This helper builds that map from { incId: [svcIds] } pairs; alertedMap() is the empty case.
function alertedMap(entries: Record<string, string[]> = {}): Map<string, Set<string>> {
  return new Map(Object.entries(entries).map(([incId, ids]) => [incId, new Set(ids)]))
}

describe('buildIncidentAlerts', () => {
  it('creates new incident alert for recent non-resolved incident', () => {
    const svc = mockService({
      incidents: [{ id: 'inc1', title: 'API Error', status: 'investigating', startedAt: recentDate, impact: 'major' }],
    })
    const alerts = buildIncidentAlerts([svc], alertedMap(), NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].key).toBe('alerted:new:inc1')
    expect(alerts[0].title).toContain('New Incident')
  })

  it('skips already-alerted new incidents', () => {
    const svc = mockService({
      incidents: [{ id: 'inc1', title: 'API Error', status: 'investigating', startedAt: recentDate, impact: 'major' }],
    })
    const alerts = buildIncidentAlerts([svc], alertedMap({ inc1: ['openai'] }), NOW)
    expect(alerts).toHaveLength(0)
  })

  it('skips incidents older than 24 hours', () => {
    const svc = mockService({
      incidents: [{ id: 'inc1', title: 'Old Error', status: 'investigating', startedAt: oldDate, impact: 'major' }],
    })
    const alerts = buildIncidentAlerts([svc], alertedMap(), NOW)
    expect(alerts).toHaveLength(0)
  })

  it('creates resolved alert only if previously alerted as new', () => {
    const svc = mockService({
      incidents: [{ id: 'inc1', title: 'Fixed', status: 'resolved', startedAt: recentDate, duration: '30m', impact: 'major' }],
    })

    // Not previously alerted → no resolved alert
    expect(buildIncidentAlerts([svc], alertedMap(), NOW)).toHaveLength(0)

    // Previously alerted → resolved alert
    const alerts = buildIncidentAlerts([svc], alertedMap({ inc1: ['openai'] }), NOW)
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
    const alerts = buildIncidentAlerts([openai, claude], alertedMap(), NOW)
    expect(alerts[0].description).toBe('Slow')
    expect(alerts[0].fallbackText).toContain('Suggested fallback')
  })

  it('omits fallback when service is operational (incident without outage)', () => {
    const openai = mockService({
      id: 'openai', status: 'operational',
      incidents: [{ id: 'inc1', title: 'Minor issue', status: 'investigating', startedAt: recentDate, impact: 'minor' }],
    })
    const claude = mockService({ id: 'claude', name: 'Claude API', aiwatchScore: 90 })
    const alerts = buildIncidentAlerts([openai, claude], alertedMap(), NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].fallbackText).toBe('')
    expect(alerts[0].description).toBe('Minor issue')
  })

  it('handles service with no incidents', () => {
    const svc = mockService({ incidents: [] })
    expect(buildIncidentAlerts([svc], alertedMap(), NOW)).toHaveLength(0)
  })

  it('groups shared-incidentId services into single alert with all service names', () => {
    // Claude API, claude.ai, Claude Code share Anthropic status page → same inc.id
    const sharedIncident = { id: 'shared1', title: 'Elevated errors', status: 'investigating', startedAt: recentDate, impact: 'major' }
    const claude = mockService({ id: 'claude', name: 'Claude API', provider: 'Anthropic', category: 'api', incidents: [sharedIncident] })
    const claudeai = mockService({ id: 'claudeai', name: 'claude.ai', provider: 'Anthropic', category: 'app', incidents: [sharedIncident] })
    const claudecode = mockService({ id: 'claudecode', name: 'Claude Code', provider: 'Anthropic', category: 'agent', incidents: [sharedIncident] })

    const alerts = buildIncidentAlerts([claude, claudeai, claudecode], alertedMap(), NOW)

    // buildIncidentAlerts groups same incidentId into one alert
    expect(alerts).toHaveLength(1)
    expect(alerts[0].key).toBe('alerted:new:shared1')
    // Title includes all affected service names
    expect(alerts[0].title).toContain('Claude API')
    expect(alerts[0].title).toContain('claude.ai')
    expect(alerts[0].title).toContain('Claude Code')
    expect(alerts[0].title).toContain('Anthropic')
  })

  it('shows same-category fallback only for shared incidents (no cross-category)', () => {
    const sharedIncident = { id: 'shared2', title: 'Opus errors', status: 'investigating', startedAt: recentDate, impact: 'major' }
    const claude = mockService({ id: 'claude', name: 'Claude API', category: 'api', status: 'degraded', incidents: [sharedIncident], aiwatchScore: 80 })
    const claudecode = mockService({ id: 'claude-code', name: 'Claude Code', category: 'agent', status: 'degraded', incidents: [sharedIncident], aiwatchScore: 70 })
    const openai = mockService({ id: 'openai', name: 'OpenAI API', category: 'api', status: 'operational', aiwatchScore: 90 })
    const cursor = mockService({ id: 'cursor', name: 'Cursor', category: 'agent', status: 'operational', aiwatchScore: 75 })

    const alerts = buildIncidentAlerts([claude, claudecode, openai, cursor], alertedMap(), NOW)
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
    const alerts = buildIncidentAlerts([svc], alertedMap({ inc2: ['openai'] }), NOW)
    expect(alerts).toHaveLength(2)
    expect(alerts[0].key).toBe('alerted:new:inc1')
    expect(alerts[1].key).toBe('alerted:res:inc2')
  })

  // #545: a service that JOINS a multi-service incident AFTER the first New Incident alert fired
  // (e.g. OpenAI renames "Issue with Codex" → "…Codex and ChatGPT", so chatgpt's keyword now matches
  // the same incidentId) must still get its own alert — scoped to only the joiner.
  describe('#545 late-joining service', () => {
    const shared = { id: 'oai-multi', title: 'Elevated errors on Codex and ChatGPT', status: 'investigating' as const, startedAt: recentDate, impact: 'major' as const }
    const codex = mockService({ id: 'codex', name: 'Codex', provider: 'OpenAI', category: 'agent', status: 'down', incidents: [shared] })
    const chatgpt = mockService({ id: 'chatgpt', name: 'ChatGPT', provider: 'OpenAI', category: 'app', status: 'down', incidents: [shared] })

    it('alerts the joiner when only the first service was already alerted', () => {
      // codex already fired (roster = {codex}); chatgpt joined the same incidentId later.
      const alerts = buildIncidentAlerts([codex, chatgpt], alertedMap({ 'oai-multi': ['codex'] }), NOW)
      expect(alerts).toHaveLength(1)
      expect(alerts[0].key).toBe('alerted:new:oai-multi')
      // The alert represents ONLY the joiner — not the already-alerted codex.
      expect(alerts[0].svcIds).toEqual(['chatgpt'])
      expect(alerts[0].title).toContain('ChatGPT')
      expect(alerts[0].title).not.toContain('Codex')
    })

    it('does not re-alert once every affected service is in the roster', () => {
      const alerts = buildIncidentAlerts([codex, chatgpt], alertedMap({ 'oai-multi': ['codex', 'chatgpt'] }), NOW)
      expect(alerts).toHaveLength(0)
    })

    it('alerts both (grouped) when neither was alerted yet — first-fire path unchanged', () => {
      const alerts = buildIncidentAlerts([codex, chatgpt], alertedMap(), NOW)
      expect(alerts).toHaveLength(1)
      expect(alerts[0].svcIds).toEqual(['codex', 'chatgpt'])
    })

    it('fires ONE grouped resolved alert (incidentId-level) for a multi-service roster', () => {
      const resolved = { ...shared, status: 'resolved' as const, duration: '42m' }
      const codexR = mockService({ ...codex, status: 'operational', incidents: [resolved] })
      const chatgptR = mockService({ ...chatgpt, status: 'operational', incidents: [resolved] })
      const alerts = buildIncidentAlerts([codexR, chatgptR], alertedMap({ 'oai-multi': ['codex', 'chatgpt'] }), NOW)
      expect(alerts).toHaveLength(1)
      expect(alerts[0].key).toBe('alerted:res:oai-multi')
      expect(alerts[0].svcIds).toEqual(['codex', 'chatgpt']) // full affected set on resolve
      expect(alerts[0].title).toContain('Codex')
      expect(alerts[0].title).toContain('ChatGPT')
    })
  })
})

// #545: the cron read-site (index.ts) auto-migrates legacy '1' and parses the JSON roster through
// this helper. Pinning it here is the unit test for the migration logic, which is otherwise only
// reachable via the (unexported) cron handler.
describe('parseAlertedRoster (#545)', () => {
  it('migrates the legacy boolean "1" by seeding the current service', () => {
    expect(parseAlertedRoster('1', 'codex')).toEqual({ ids: ['codex'], corrupt: false })
  })

  it('round-trips a JSON svcId array', () => {
    expect(parseAlertedRoster('["codex","chatgpt"]', 'chatgpt')).toEqual({ ids: ['codex', 'chatgpt'], corrupt: false })
  })

  it('treats non-array JSON as corrupt and falls back to the current service', () => {
    expect(parseAlertedRoster('{}', 'codex')).toEqual({ ids: ['codex'], corrupt: true })
    expect(parseAlertedRoster('true', 'codex')).toEqual({ ids: ['codex'], corrupt: true })
  })

  it('treats unparseable JSON as corrupt and falls back to the current service', () => {
    expect(parseAlertedRoster('not json', 'gpt')).toEqual({ ids: ['gpt'], corrupt: true })
  })
})

describe('region-switch hint (#422)', () => {
  // Pinecone is region-aware (SERVICE_REGIONS) with AWS us-east-1 listed first and
  // AWS us-west-2 second — so a us-east-1-only outage recommends "AWS US West".
  const regionSpecific: Incident = {
    id: 'pc1', title: 'Index unavailable', status: 'investigating',
    startedAt: recentDate, impact: 'major', componentNames: ['AWS us-east-1'],
  }

  it('buildRegionHint recommends the first healthy region for a region-specific outage', () => {
    const pinecone = mockService({ id: 'pinecone', name: 'Pinecone', status: 'degraded', incidents: [regionSpecific] })
    expect(buildRegionHint(pinecone)).toBe('📍 Try region: AWS US West')
  })

  it('buildRegionHint returns undefined for a non-region-aware service', () => {
    // mistral has no SERVICE_REGIONS entry → regionStatusOf returns null
    const mistral = mockService({ id: 'mistral', name: 'Mistral API', status: 'degraded',
      incidents: [{ id: 'm1', title: 'Errors', status: 'investigating', startedAt: recentDate, impact: 'major' }] })
    expect(buildRegionHint(mistral)).toBeUndefined()
  })

  it('buildRegionHint returns undefined for a global (non-region-specific) incident', () => {
    // No region in title/components → every region marked down via fallback → allDown → no recommendation
    const pinecone = mockService({ id: 'pinecone', name: 'Pinecone', status: 'down',
      incidents: [{ id: 'pc-global', title: 'Major outage', status: 'investigating', startedAt: recentDate, impact: 'critical' }] })
    expect(buildRegionHint(pinecone)).toBeUndefined()
  })

  it('attaches regionText to the new-incident alert for region-specific outages', () => {
    const pinecone = mockService({ id: 'pinecone', name: 'Pinecone', status: 'degraded', incidents: [regionSpecific] })
    const alerts = buildIncidentAlerts([pinecone], alertedMap(), NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].regionText).toBe('📍 Try region: AWS US West')
  })

  it('does not attach regionText to resolved alerts', () => {
    const pinecone = mockService({ id: 'pinecone', name: 'Pinecone', status: 'operational',
      incidents: [{ ...regionSpecific, id: 'pc-res', status: 'resolved', duration: '20m' }] })
    const alerts = buildIncidentAlerts([pinecone], alertedMap({ 'pc-res': ['pinecone'] }), NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].key).toBe('alerted:res:pc-res')
    expect(alerts[0].regionText).toBeUndefined()
  })

  it('suppresses the hint when a global incident coexists with a region-specific one', () => {
    // A region-tagged outage flips hasRegionSpecific=true, but a coexisting global
    // incident (matches no region) means the whole service is affected — recommending
    // a "healthy" region would point operators at a region the global outage also
    // takes down. Must suppress. (#422 — pr-test-analyzer Severity-9 finding)
    const pinecone = mockService({ id: 'pinecone', name: 'Pinecone', status: 'down', incidents: [
      regionSpecific,
      { id: 'pc-global', title: 'Major outage', status: 'investigating', startedAt: recentDate, impact: 'critical' },
    ] })
    expect(buildRegionHint(pinecone)).toBeUndefined()
    const alerts = buildIncidentAlerts([pinecone], alertedMap(), NOW)
    // Both incidents alert; neither carries a region hint while the global outage is open.
    expect(alerts.every(a => a.regionText === undefined)).toBe(true)
  })

  it('recommends the first healthy region when several regions are hit (partial multi-region)', () => {
    // Two region-specific incidents knock out AWS us-east-1 + us-west-2 → first
    // remaining healthy region in SERVICE_REGIONS order is AWS eu-west-1 ("AWS EU West").
    const pinecone = mockService({ id: 'pinecone', name: 'Pinecone', status: 'degraded', incidents: [
      { id: 'pc-e', title: 'Outage', status: 'investigating', startedAt: recentDate, impact: 'major', componentNames: ['AWS us-east-1'] },
      { id: 'pc-w', title: 'Outage', status: 'investigating', startedAt: recentDate, impact: 'major', componentNames: ['AWS us-west-2'] },
    ] })
    expect(buildRegionHint(pinecone)).toBe('📍 Try region: AWS EU West')
  })

  it('#641 suppresses the cross-service fallback when a region switch IS offered', () => {
    // OpenAI is region-aware (SERVICE_REGIONS) AND fallback-eligible (not EXCLUDE_FALLBACK). A
    // region-specific outage is solved by the cheaper same-provider region switch, so the
    // cross-service fallback (Claude) must be suppressed to avoid redundant noise.
    const openai = mockService({ id: 'openai', name: 'OpenAI API', status: 'degraded', incidents: [
      { id: 'oai-r', title: 'Elevated errors', status: 'investigating', startedAt: recentDate, impact: 'major', componentNames: ['us-east-1'] },
    ] })
    const claude = mockService({ id: 'claude', name: 'Claude API', provider: 'Anthropic', status: 'operational', aiwatchScore: 95 })
    const alert = buildIncidentAlerts([openai, claude], alertedMap(), NOW).find(a => a.key === 'alerted:new:oai-r')
    expect(alert.regionText).toBe('📍 Try region: US West (us-west-2)')
    expect(alert.fallbackText).toBe('') // suppressed despite Claude being an operational same-tier fallback
  })

  it('#641 still shows the cross-service fallback for a GLOBAL (non-region) incident', () => {
    // No region switch applies → the cross-service fallback is the only actionable alternative.
    const openai = mockService({ id: 'openai', name: 'OpenAI API', status: 'down', incidents: [
      { id: 'oai-g', title: 'Major outage', status: 'investigating', startedAt: recentDate, impact: 'critical' },
    ] })
    const claude = mockService({ id: 'claude', name: 'Claude API', provider: 'Anthropic', status: 'operational', aiwatchScore: 95 })
    const alert = buildIncidentAlerts([openai, claude], alertedMap(), NOW).find(a => a.key === 'alerted:new:oai-g')
    expect(alert.regionText).toBeUndefined()        // global → no region hint
    expect(alert.fallbackText).toContain('Claude API') // fallback shown
  })

  it('mergeTogetherAlerts preserves regionText from the first merged alert', () => {
    // Together has no region map so this is undefined in practice, but the merge path
    // is generic — pin that a set regionText survives the merge. (#422 Severity-6)
    const withRegion: AlertCandidate = {
      key: 'alerted:new:t1', title: '🔴 Together AI — New Incident', description: 'A — down',
      color: 0xED4245, url: 'https://ai-watch.dev/#together', regionText: '📍 Try region: AWS US West',
    }
    const second: AlertCandidate = {
      key: 'alerted:new:t2', title: '🔴 Together AI — New Incident', description: 'B — down',
      color: 0xED4245, url: 'https://ai-watch.dev/#together',
    }
    const merged = mergeTogetherAlerts([withRegion, second])
    expect(merged).toHaveLength(1)
    expect(merged[0].regionText).toBe('📍 Try region: AWS US West')
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

  it('does not suppress when all incidents are resolved without resolvedAt', () => {
    const svc = mockService({
      status: 'degraded',
      incidents: [{ id: 'inc1', title: 'Fixed', status: 'resolved', startedAt: recentDate, duration: '10m', impact: 'minor' }],
    })
    const alerts = buildServiceAlerts([svc], new Map(), new Map())
    expect(alerts).toHaveLength(1)
    expect(alerts[0].key).toBe('alerted:degraded:openai')
  })

  // #394: Atlassian Statuspage clears incident.status before component status_indicator,
  // producing a confusing 🟢 Resolved → 🟠 Degraded → 🟢 Recovered tail in the same window.
  describe('resolved-race-window suppression (#394)', () => {
    it('suppresses degraded alert when incident resolved within 15min', () => {
      const resolvedAt = new Date(NOW - 5 * 60_000).toISOString() // 5min ago
      const svc = mockService({
        status: 'degraded',
        incidents: [{ id: 'inc1', title: 'Fixed', status: 'resolved', startedAt: recentDate, resolvedAt, duration: '7m', impact: 'major' }],
      })
      expect(buildServiceAlerts([svc], new Map(), new Map(), NOW)).toHaveLength(0)
    })

    it('fires degraded alert when incident resolved more than 15min ago', () => {
      const resolvedAt = new Date(NOW - 16 * 60_000).toISOString()
      const svc = mockService({
        status: 'degraded',
        incidents: [{ id: 'inc1', title: 'Fixed', status: 'resolved', startedAt: recentDate, resolvedAt, duration: '7m', impact: 'major' }],
      })
      const alerts = buildServiceAlerts([svc], new Map(), new Map(), NOW)
      expect(alerts).toHaveLength(1)
      expect(alerts[0].key).toBe('alerted:degraded:openai')
    })

    it('does NOT suppress down alert during race window (high-urgency)', () => {
      const resolvedAt = new Date(NOW - 5 * 60_000).toISOString()
      const svc = mockService({
        status: 'down',
        incidents: [{ id: 'inc1', title: 'Fixed', status: 'resolved', startedAt: recentDate, resolvedAt, duration: '7m', impact: 'major' }],
      })
      const alerts = buildServiceAlerts([svc], new Map(), new Map(), NOW)
      expect(alerts).toHaveLength(1)
      expect(alerts[0].key).toBe('alerted:down:openai')
    })

    it('handles invalid resolvedAt without throwing — falls through to degraded fire', () => {
      const svc = mockService({
        status: 'degraded',
        incidents: [{ id: 'inc1', title: 'Fixed', status: 'resolved', startedAt: recentDate, resolvedAt: 'not-a-date', duration: '7m', impact: 'major' }],
      })
      const alerts = buildServiceAlerts([svc], new Map(), new Map(), NOW)
      expect(alerts).toHaveLength(1)
      expect(alerts[0].key).toBe('alerted:degraded:openai')
    })
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
    const alerts = buildIncidentAlerts([together], alertedMap(), NOW)
    expect(alerts).toHaveLength(3)
    const merged = mergeTogetherAlerts(alerts)
    expect(merged).toHaveLength(1)
    expect(merged[0].title).toContain('3 New Incidents')
    expect(merged[0]._mergedKeys).toHaveLength(3)
    expect(merged[0].svcIds).toEqual(['together']) // #545 — deduped union of the merged rosters
  })

  it('correctly merges resolved alerts generated by buildIncidentAlerts (integration)', () => {
    const together = mockService({
      id: 'together', name: 'Together AI', status: 'operational', category: 'api',
      incidents: [
        { id: 'inc1', title: 'FLUX.1 Krea [dev]', status: 'resolved', startedAt: recentDate, duration: '13m', impact: 'major' },
        { id: 'inc2', title: 'ZAI GLM 5 FP4', status: 'resolved', startedAt: recentDate, duration: '15m', impact: 'major' },
      ],
    })
    const alerts = buildIncidentAlerts([together], alertedMap({ inc1: ['together'], inc2: ['together'] }), NOW)
    expect(alerts).toHaveLength(2)
    const merged = mergeTogetherAlerts(alerts)
    expect(merged).toHaveLength(1)
    expect(merged[0].title).toContain('2 Incidents Resolved')
    expect(merged[0]._mergedKeys).toHaveLength(2)
    expect(merged[0].svcIds).toEqual(['together']) // #545 — deduped union of the merged rosters
  })
})

describe('formatDetectionLead', () => {
  it('returns lead text when detected before official report', () => {
    const detected = new Date(NOW - 10 * 60_000).toISOString() // 10min before startedAt
    const started = new Date(NOW).toISOString()
    const result = formatDetectionLead(detected, started)
    expect(result).toContain('Early signal: 10m')
    expect(result).toContain('AIWatch flagged RTT degradation')
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

  it('returns empty for exactly 60 min lead (capped at 59m, #189)', () => {
    const detected = new Date(NOW - 60 * 60_000).toISOString()
    const started = new Date(NOW).toISOString()
    expect(formatDetectionLead(detected, started)).toBe('')
  })

  it('returns result for 59 min lead (max valid)', () => {
    const detected = new Date(NOW - 59 * 60_000).toISOString()
    const started = new Date(NOW).toISOString()
    const result = formatDetectionLead(detected, started)
    expect(result).toContain('59m')
  })
})

describe('flap suppression (#283)', () => {
  const mkInc = (overrides: Partial<Incident> = {}): Incident => ({
    id: 'inc1',
    title: 'Nomic Embed Text v1.5 embeddings API — recovered',
    status: 'resolved',
    impact: null,
    startedAt: new Date(NOW - 300_000).toISOString(),
    duration: '5m',
    timeline: [],
    ...overrides,
  })

  describe('isFlapNotice', () => {
    it('matches BetterStack-style " — recovered" titles (resolved half of a flap)', () => {
      expect(isFlapNotice(mkInc({ title: 'Embedding API — recovered' }))).toBe(true)
      expect(isFlapNotice(mkInc({ title: 'Llama 3.3 70B chat completion API — recovered' }))).toBe(true)
    })

    it('matches BetterStack-style " — down" titles (down half of a flap)', () => {
      // BetterStack parser emits both halves; suppression must cover the down phase too
      // so the 2nd flap's down alert is dropped along with its resolved counterpart.
      expect(isFlapNotice(mkInc({ status: 'investigating', title: 'Embedding API — down' }))).toBe(true)
    })

    it('ignores titles without the exact " — down" or " — recovered" suffix', () => {
      expect(isFlapNotice(mkInc({ title: 'Service recovered after outage' }))).toBe(false)
      expect(isFlapNotice(mkInc({ title: 'API — investigating' }))).toBe(false)
      expect(isFlapNotice(mkInc({ title: 'Major Outage' }))).toBe(false)
    })

    it('excludes only `major` impact — a `minor` or null flap still matches (#633/#565)', () => {
      // `major` = explicit broad-outage wording (#564) → never a flap, alert immediately.
      expect(isFlapNotice(mkInc({ impact: 'major', title: 'X — recovered' }))).toBe(false)
      // #564/#565 maps a BetterStack auto-monitor "— down" flap → `minor` (only outage/unavailable/
      // offline → major). The pre-fix `impact != null` guard wrongly excluded these, silently
      // disabling the #283 flap-dedup AND the #633 first-seen hold for every BetterStack incident
      // (the Modal "Web endpoints — down" phantom). A minor/null flap MUST still match.
      expect(isFlapNotice(mkInc({ impact: 'minor', title: 'X — down' }))).toBe(true)
      expect(isFlapNotice(mkInc({ impact: null, title: 'X — down' }))).toBe(true)
    })
  })

  describe('normalizeFlapTitle', () => {
    it('strips " — recovered" suffix for KV key stability', () => {
      expect(normalizeFlapTitle('Nomic Embed Text v1.5 embeddings API — recovered'))
        .toBe('Nomic Embed Text v1.5 embeddings API')
    })
    it('strips " — down" suffix so the down + res halves share the same key', () => {
      expect(normalizeFlapTitle('Nomic Embed Text v1.5 embeddings API — down'))
        .toBe('Nomic Embed Text v1.5 embeddings API')
    })
    it('trims whitespace around separators', () => {
      expect(normalizeFlapTitle('X —  recovered  ')).toBe('X')
    })
    it('leaves titles without the suffix unchanged', () => {
      expect(normalizeFlapTitle('Major Outage')).toBe('Major Outage')
    })
  })

  describe('flapSuppressionKey', () => {
    it('scopes key to svcId + normalized title', () => {
      const key = flapSuppressionKey('fireworks', mkInc({ title: 'Embed API — recovered' }))
      expect(key).toBe('alerted:flap:fireworks:Embed API')
    })
    it('returns different keys for different services with identical titles', () => {
      const inc = mkInc({ title: 'Shared Title — recovered' })
      expect(flapSuppressionKey('fireworks', inc)).not.toEqual(flapSuppressionKey('together', inc))
    })
  })

  describe('isFlapSuppressible', () => {
    const config = { flapSuppression: true }

    it('returns true for a flap notice on an opted-in service', () => {
      expect(isFlapSuppressible('fireworks', config, mkInc())).toBe(true)
    })

    it('returns false for opted-out services (flag absent or false)', () => {
      expect(isFlapSuppressible('fireworks', {}, mkInc())).toBe(false)
      expect(isFlapSuppressible('fireworks', { flapSuppression: false }, mkInc())).toBe(false)
    })

    it('returns false for `major` impact (real outages never suppressed) but true for `minor` flaps (#565)', () => {
      expect(isFlapSuppressible('fireworks', config, mkInc({ impact: 'major' }))).toBe(false)
      // #564/#565 maps BetterStack "— down" flaps to `minor` — these MUST stay suppressible.
      expect(isFlapSuppressible('fireworks', config, mkInc({ impact: 'minor', title: 'X — down' }))).toBe(true)
    })

    it('returns false for titles without the " — recovered" suffix', () => {
      expect(isFlapSuppressible('fireworks', config, mkInc({ title: 'API Outage' }))).toBe(false)
    })

    it('Tier-1 guard: never suppresses claude / openai / gemini even if flag set', () => {
      // Defense-in-depth: a configuration mistake enabling flapSuppression on a Tier-1
      // service would silently swallow real outage alerts. Hard-coded exclusion.
      expect(isFlapSuppressible('claude', config, mkInc())).toBe(false)
      expect(isFlapSuppressible('openai', config, mkInc())).toBe(false)
      expect(isFlapSuppressible('gemini', config, mkInc())).toBe(false)
    })
  })

  describe('buildIncidentAlerts — suppressedIncIds integration', () => {
    // End-to-end: proves the plumbing from pre-collection (suppressedIncIds) into
    // buildIncidentAlerts actually drops the Discord alert. The reviewer of the first
    // draft caught a silent no-op here; this test locks the contract.
    it('drops both new and resolved alerts for suppressed incident IDs', () => {
      const svc = mockService({
        id: 'fireworks',
        status: 'operational',
        incidents: [
          // Down half of a second flap in the same 60min window
          { id: 'flap2-down', title: 'X — down', status: 'investigating', impact: null, startedAt: recentDate },
          // Resolved half of the same flap (would normally fire alerted:res if alertedNewIds had it)
          { id: 'flap2-res', title: 'X — recovered', status: 'resolved', impact: null, startedAt: recentDate, duration: '5m' },
        ],
      })
      const suppressed = new Set(['flap2-down', 'flap2-res'])
      const alerts = buildIncidentAlerts([svc], alertedMap({ 'flap2-res': ['fireworks'] }), NOW, suppressed)
      expect(alerts).toHaveLength(0)
    })

    it('does not affect non-suppressed incidents on the same service', () => {
      const svc = mockService({
        incidents: [
          { id: 'suppressed', title: 'X — down', status: 'investigating', impact: null, startedAt: recentDate },
          { id: 'real', title: 'Actual Outage', status: 'investigating', impact: 'major', startedAt: recentDate },
        ],
      })
      const alerts = buildIncidentAlerts([svc], alertedMap(), NOW, new Set(['suppressed']))
      expect(alerts).toHaveLength(1)
      expect(alerts[0].key).toBe('alerted:new:real')
    })
  })
})

describe('first-seen confirmation gate (#633)', () => {
  const mkInc = (overrides: Partial<Incident> = {}): Incident => ({
    id: 'inc1',
    title: 'Web endpoints — down',
    status: 'investigating',
    impact: null,
    startedAt: new Date(NOW - 60_000).toISOString(),
    timeline: [],
    ...overrides,
  })
  const config = { flapSuppression: true }
  const firstSight = { alreadyAlerted: false, pendingExists: false }

  describe('pendingNewKey + TTL', () => {
    it('scopes the marker to the incident id', () => {
      expect(pendingNewKey('flashduty:abc123')).toBe('pending:new:flashduty:abc123')
    })
    it('TTL spans 2 */5 cron cycles so a single skipped run still confirms', () => {
      expect(PENDING_NEW_TTL_S).toBe(600)
    })
  })

  describe('shouldHoldNewIncident', () => {
    it('HOLDS a flap-shaped new incident on its first sight (monitor-flap service)', () => {
      expect(shouldHoldNewIncident('modal', config, mkInc(), firstSight)).toBe(true)
    })

    it('HOLDS the real `minor`-impact phantom shape (Modal "Web endpoints — down", #633/#565)', () => {
      // Regression: the live BetterStack incident carries impact 'minor' (#564), not null. Pre-fix the
      // `impact != null` guard made this fire on first sight (the recurred Modal phantom); it must hold.
      const inc = mkInc({ status: 'investigating', impact: 'minor', title: 'Web endpoints — down' })
      expect(shouldHoldNewIncident('modal', config, inc, firstSight)).toBe(true)
    })

    it('FIRES once the incident survived a prior cycle (pending marker present)', () => {
      expect(shouldHoldNewIncident('modal', config, mkInc(), { alreadyAlerted: false, pendingExists: true })).toBe(false)
    })

    it('never re-holds an already-alerted incident (a later cron re-fire)', () => {
      expect(shouldHoldNewIncident('modal', config, mkInc(), { alreadyAlerted: true, pendingExists: false })).toBe(false)
    })

    it('does not hold resolved incidents (resolved path is gated by alertedNewMap)', () => {
      expect(shouldHoldNewIncident('modal', config, mkInc({ status: 'resolved', title: 'Web endpoints — recovered' }), firstSight)).toBe(false)
    })

    it('does not hold severity-tagged incidents — real outages alert immediately', () => {
      expect(shouldHoldNewIncident('modal', config, mkInc({ impact: 'major', title: 'Web endpoints — down' }), firstSight)).toBe(false)
    })

    it('does not hold services without flapSuppression — immediate alert, no regression', () => {
      expect(shouldHoldNewIncident('anthropic', { flapSuppression: false }, mkInc(), firstSight)).toBe(false)
      expect(shouldHoldNewIncident('anthropic', {}, mkInc(), firstSight)).toBe(false)
    })

    it('Tier-1 guard: never holds claude / openai / gemini even with the flag', () => {
      expect(shouldHoldNewIncident('claude', config, mkInc(), firstSight)).toBe(false)
      expect(shouldHoldNewIncident('openai', config, mkInc(), firstSight)).toBe(false)
      expect(shouldHoldNewIncident('gemini', config, mkInc(), firstSight)).toBe(false)
    })
  })

  describe('held incident produces no phantom alert (buildIncidentAlerts integration)', () => {
    it('a held flap incident that recovers inside the window emits neither new nor recovered', () => {
      // Cycle 1: held → added to suppressedIncIds, no alerted:new written (alertedMap empty).
      // Cycle 2: the blip self-recovered → status resolved, but it was never in alertedNewMap,
      // so buildIncidentAlerts emits NO "recovered" (the alertedNewMap.has guard). Net: silent.
      const recovered = mockService({
        id: 'modal',
        status: 'operational',
        incidents: [{ id: 'flap-blip', title: 'Web endpoints — recovered', status: 'resolved', impact: null, startedAt: recentDate, duration: '3m' }],
      })
      const alerts = buildIncidentAlerts([recovered], alertedMap(), NOW, new Set(['flap-blip']))
      expect(alerts).toHaveLength(0)
    })

    it('two-cycle hold→confirm: composes shouldHoldNewIncident → suppressedIncIds → buildIncidentAlerts like index.ts', () => {
      // This drives the SAME two real functions the cron wires together, simulating the pending:new
      // KV transition (absent on cycle 1 → present on cycle 2). It proves the cross-cycle contract
      // end-to-end at the function-composition level (the cronAlertCheck glue is otherwise unexported).
      const inc: Incident = { id: 'flap-x', title: 'Web endpoints — down', status: 'investigating', impact: null, startedAt: recentDate, timeline: [] }
      const svc = mockService({ id: 'modal', status: 'down', incidents: [inc] })
      const config = { flapSuppression: true }

      // Cycle 1: no pending marker yet (pendingExists:false) → held → goes into suppressedIncIds.
      const suppressed1 = new Set<string>()
      if (shouldHoldNewIncident('modal', config, inc, { alreadyAlerted: false, pendingExists: false })) suppressed1.add(inc.id)
      expect(suppressed1.has('flap-x')).toBe(true)
      expect(buildIncidentAlerts([svc], alertedMap(), NOW, suppressed1)).toHaveLength(0) // silent cycle 1

      // Cycle 2: marker written on cycle 1 (pendingExists:true) → NOT held → fires.
      const suppressed2 = new Set<string>()
      if (shouldHoldNewIncident('modal', config, inc, { alreadyAlerted: false, pendingExists: true })) suppressed2.add(inc.id)
      expect(suppressed2.size).toBe(0)
      const alerts = buildIncidentAlerts([svc], alertedMap(), NOW, suppressed2)
      expect(alerts.map(a => a.key)).toEqual(['alerted:new:flap-x']) // fires cycle 2
    })

    it('incId stability: a churned id is treated as a fresh first-sight (re-held) — documents the gate dependency', () => {
      // The gate keys on pendingNewKey(inc.id); if the feed re-issues a NEW id for the same flap
      // between cycles, the cycle-2 pending lookup misses and the incident is held again. BetterStack
      // RSS ids are stable guids (parsers/betterstack.ts), so this degenerate case shouldn't occur —
      // this test pins the assumption so a future unstable-id source is caught by intent.
      const config = { flapSuppression: true }
      const churnedInc: Incident = { id: 'flap-y', title: 'Web endpoints — down', status: 'investigating', impact: null, startedAt: recentDate, timeline: [] }
      // pending:new was written for 'flap-x' on cycle 1; cycle 2 surfaces 'flap-y' → its marker is absent.
      expect(shouldHoldNewIncident('modal', config, churnedInc, { alreadyAlerted: false, pendingExists: false })).toBe(true)
    })
  })
})
