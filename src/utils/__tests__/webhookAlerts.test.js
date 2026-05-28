import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  computeStatusAlerts,
  buildIncidentSnapshot,
  computeIncidentAlerts,
  runWebhookAlerts,
  __resetIncidentFirstRun,
} from '../webhookAlerts'
import { SETTINGS_STORAGE_KEY } from '../constants'

const svc = (id, status, incidents = []) => ({ id, name: id.toUpperCase(), status, incidents })

describe('computeStatusAlerts', () => {
  const base = { alertCondition: 'all', alertTarget: 'all', alertServices: [] }

  it('returns nothing when there is no previous snapshot', () => {
    expect(computeStatusAlerts([], [svc('claude', 'down')], base)).toEqual([])
    expect(computeStatusAlerts(null, [svc('claude', 'down')], base)).toEqual([])
  })

  it('fires only on a changed status', () => {
    const prev = [svc('claude', 'operational'), svc('openai', 'operational')]
    const curr = [svc('claude', 'down'), svc('openai', 'operational')]
    const out = computeStatusAlerts(prev, curr, base)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ svcId: 'claude', prevStatus: 'operational', status: 'down' })
  })

  it("alertCondition 'down' ignores degraded-only transitions but keeps down entry + recovery", () => {
    const cond = { ...base, alertCondition: 'down' }
    const degradedOnly = computeStatusAlerts([svc('a', 'operational')], [svc('a', 'degraded')], cond)
    expect(degradedOnly).toEqual([])
    const downEntry = computeStatusAlerts([svc('a', 'operational')], [svc('a', 'down')], cond)
    expect(downEntry).toHaveLength(1)
    const downRecovery = computeStatusAlerts([svc('a', 'down')], [svc('a', 'operational')], cond)
    expect(downRecovery).toHaveLength(1)
  })

  it("alertCondition 'degraded' ignores nothing-to-operational noise but keeps any non-operational change", () => {
    const cond = { ...base, alertCondition: 'degraded' }
    // operational stays operational is already filtered by "no change"; this guards the explicit rule
    expect(computeStatusAlerts([svc('a', 'degraded')], [svc('a', 'down')], cond)).toHaveLength(1)
    expect(computeStatusAlerts([svc('a', 'degraded')], [svc('a', 'operational')], cond)).toHaveLength(1)
  })

  it("alertTarget 'custom' only fires for selected services", () => {
    const cond = { ...base, alertTarget: 'custom', alertServices: ['openai'] }
    const prev = [svc('claude', 'operational'), svc('openai', 'operational')]
    const curr = [svc('claude', 'down'), svc('openai', 'down')]
    const out = computeStatusAlerts(prev, curr, cond)
    expect(out).toHaveLength(1)
    expect(out[0].svcId).toBe('openai')
  })

  it('does not fire for a service absent from the previous snapshot', () => {
    expect(computeStatusAlerts([svc('claude', 'operational')], [svc('claude', 'operational'), svc('new', 'down')], base)).toEqual([])
  })
})

describe('buildIncidentSnapshot', () => {
  it('maps service → incident id → {status,title,duration}', () => {
    const snap = buildIncidentSnapshot([
      svc('claude', 'down', [{ id: 'i1', status: 'investigating', title: 'API errors', duration: null }]),
      svc('openai', 'operational', []),
    ])
    expect(snap).toEqual({
      claude: { i1: { status: 'investigating', title: 'API errors', duration: null } },
      openai: {},
    })
  })
})

describe('computeIncidentAlerts', () => {
  const services = [svc('claude', 'down', [{ id: 'i1', status: 'investigating', title: 'API errors' }])]
  const base = { alertIncidents: true, alertTarget: 'all', alertServices: [] }

  it('respects alertIncidents=false', () => {
    expect(computeIncidentAlerts({}, buildIncidentSnapshot(services), services, { ...base, alertIncidents: false })).toEqual([])
  })

  it('detects a new incident', () => {
    const out = computeIncidentAlerts({}, { claude: { i1: { status: 'investigating', title: 'API errors' } } }, services, base)
    expect(out).toEqual([{ kind: 'new', svcId: 'claude', name: 'CLAUDE', incId: 'i1', title: 'API errors' }])
  })

  it('detects a resolved incident (status change to resolved)', () => {
    const prev = { claude: { i1: { status: 'investigating', title: 'API errors' } } }
    const curr = { claude: { i1: { status: 'resolved', title: 'API errors', duration: '1h 20m' } } }
    const out = computeIncidentAlerts(prev, curr, services, base)
    expect(out).toEqual([{ kind: 'resolved', svcId: 'claude', name: 'CLAUDE', incId: 'i1', title: 'API errors', duration: '1h 20m' }])
  })

  it('treats an incident that vanished from the feed as resolved', () => {
    const prev = { claude: { i1: { status: 'investigating', title: 'API errors' } } }
    const out = computeIncidentAlerts(prev, { claude: {} }, services, base)
    expect(out).toEqual([{ kind: 'resolved', svcId: 'claude', name: 'CLAUDE', incId: 'i1', title: 'API errors' }])
  })

  it('does not re-alert an already-resolved incident', () => {
    const prev = { claude: { i1: { status: 'resolved', title: 'API errors' } } }
    const curr = { claude: { i1: { status: 'resolved', title: 'API errors' } } }
    expect(computeIncidentAlerts(prev, curr, services, base)).toEqual([])
  })

  it("alertTarget 'custom' filters by selected services", () => {
    const prev = {}
    const curr = { claude: { i1: { status: 'investigating', title: 'API errors' } } }
    const out = computeIncidentAlerts(prev, curr, services, { ...base, alertTarget: 'custom', alertServices: ['openai'] })
    expect(out).toEqual([])
  })
})

// happy-dom doesn't expose a usable Storage API under vitest 4, so install an in-memory
// polyfill (same approach as analytics.test.js).
function makeLocalStorage() {
  const store = new Map()
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null },
    setItem(k, v) { store.set(String(k), String(v)) },
    removeItem(k) { store.delete(k) },
    clear() { store.clear() },
  }
}

describe('runWebhookAlerts (dispatch — Discord only)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal('localStorage', makeLocalStorage())
    __resetIncidentFirstRun()
  })

  const withSettings = (extra = {}) => localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
    discordUrl: 'https://discord.com/api/webhooks/x/y', alertCondition: 'all', alertTarget: 'all', alertServices: [], alertIncidents: true, ...extra,
  }))

  it('no-ops (no fetch) when no Discord webhook is configured', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ alertCondition: 'all', alertTarget: 'all' }))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    runWebhookAlerts([svc('claude', 'operational')], [svc('claude', 'down')])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POSTs a Discord alert to /api/alert on a status change', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    runWebhookAlerts([svc('claude', 'operational')], [svc('claude', 'down')])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/alert$/)
    const body = JSON.parse(opts.body)
    expect(body.channel).toBe('discord')
    expect(body.webhookUrl).toBe('https://discord.com/api/webhooks/x/y')
    expect(body.payload.embeds[0].title).toContain('CLAUDE — Down')
  })

  it('respects the per-key cooldown (no duplicate send for the same transition)', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    runWebhookAlerts([svc('claude', 'operational')], [svc('claude', 'down')])
    runWebhookAlerts([svc('claude', 'operational')], [svc('claude', 'down')])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // ── incident path + first-run guard ──────────────────────────────────
  const downWith = (incidents) => svc('claude', 'down', incidents)

  it('does not alert on incidents present at the first poll (incidentFirstRun guard)', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    // First call: prev=[] (no status diff) + first incident snapshot is baselined, not alerted —
    // otherwise every already-open incident would fire on page load.
    runWebhookAlerts([], [downWith([{ id: 'i1', status: 'investigating', title: 'API errors' }])])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('alerts on a NEW incident appearing after the first poll', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    const prevIncidents = [{ id: 'i1', status: 'investigating', title: 'API errors' }]
    runWebhookAlerts([], [downWith(prevIncidents)]) // baseline (no alert)
    // Same status (down→down, no status alert), but a new incident i2 appears → one incident alert.
    runWebhookAlerts([downWith(prevIncidents)], [downWith([...prevIncidents, { id: 'i2', status: 'investigating', title: 'New outage' }])])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.payload.embeds[0].title).toContain('New incident')
    expect(body.payload.embeds[0].description).toBe('New outage')
  })

  it('alerts on an incident transitioning to resolved after the first poll', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    runWebhookAlerts([], [downWith([{ id: 'i1', status: 'investigating', title: 'API errors' }])]) // baseline
    // Service stays down (no status alert); incident i1 flips to resolved → one resolved alert.
    runWebhookAlerts([downWith([{ id: 'i1', status: 'investigating', title: 'API errors' }])], [downWith([{ id: 'i1', status: 'resolved', title: 'API errors', duration: '1h' }])])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).payload.embeds[0].title).toContain('Incident resolved')
  })

  // ── status↔incident dedup (#473) ─────────────────────────────────────
  it('suppresses the status embed when a NEW incident covers the same down event (no duplicate, #473)', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    runWebhookAlerts([], [svc('claude', 'operational')]) // baseline (no incidents)
    // claude goes down AND posts a new incident in the same poll → only the incident embed, not down.
    runWebhookAlerts([svc('claude', 'operational')], [downWith([{ id: 'i1', status: 'investigating', title: 'API errors' }])])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).payload.embeds[0].title).toContain('New incident')
  })

  it('suppresses the recovery status embed when the incident resolves the same cycle (#473)', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    runWebhookAlerts([], [downWith([{ id: 'i1', status: 'investigating', title: 'API errors' }])]) // baseline
    runWebhookAlerts(
      [downWith([{ id: 'i1', status: 'investigating', title: 'API errors' }])],
      [svc('claude', 'operational', [{ id: 'i1', status: 'resolved', title: 'API errors', duration: '1h' }])],
    )
    expect(fetchMock).toHaveBeenCalledTimes(1) // only "Incident resolved", not "Recovered"
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).payload.embeds[0].title).toContain('Incident resolved')
  })

  it('suppresses a down status embed when an ongoing incident from a prior cycle covers it (operator parity, #473)', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    const inc = [{ id: 'i1', status: 'investigating', title: 'API errors' }]
    // Baseline: incident already present while still operational (minor incident, not yet down).
    runWebhookAlerts([], [svc('claude', 'operational', inc)])
    // Status drops to down; i1 is ongoing but NOT new this cycle → no incident embed, and the
    // down status embed is suppressed because the ongoing incident already covers it.
    runWebhookAlerts([svc('claude', 'operational', inc)], [svc('claude', 'down', inc)])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still fires a status embed for a status change with NO incident covering it (#473)', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    runWebhookAlerts([], [svc('claude', 'operational')]) // baseline
    // Down with no incident posted (early-detection case) → status embed still fires.
    runWebhookAlerts([svc('claude', 'operational')], [svc('claude', 'down')])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).payload.embeds[0].title).toContain('CLAUDE — Down')
  })

  // ── grouping + fallback + AI parity with operator (#474) ─────────────
  const incidentEmbedBody = (fetchMock) =>
    JSON.parse(fetchMock.mock.calls.find((c) => JSON.parse(c[1].body).payload.embeds[0].title.includes('New incident'))[1].body).payload.embeds[0]

  it('groups a multi-service incident into ONE embed with "{provider} ({names})" (#474)', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    const op = (id, name) => ({ id, name, provider: 'Anthropic', status: 'operational', category: id === 'claudeai' ? 'app' : 'api', incidents: [] })
    const down = (id, name) => ({ id, name, provider: 'Anthropic', status: 'down', category: id === 'claudeai' ? 'app' : 'api', incidents: [{ id: 'x', status: 'investigating', title: 'Elevated errors' }] })
    runWebhookAlerts([], [op('claude', 'Claude API'), op('claudeai', 'claude.ai')]) // baseline
    runWebhookAlerts([op('claude', 'Claude API'), op('claudeai', 'claude.ai')], [down('claude', 'Claude API'), down('claudeai', 'claude.ai')])
    // Exactly one incident embed (not one per service), titled with the grouped provider + names.
    const incidentTitles = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).payload.embeds[0].title).filter((t) => t.includes('New incident'))
    expect(incidentTitles).toEqual(['🔴 Anthropic (Claude API, claude.ai) — New incident'])
  })

  it('adds a Suggested fallback line for an impaired service (#474)', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    const claudeOp = { id: 'claude', name: 'Claude API', provider: 'Anthropic', status: 'operational', category: 'api', aiwatchScore: 80, incidents: [] }
    const claudeDown = { ...claudeOp, status: 'down', incidents: [{ id: 'x', status: 'investigating', title: 'Errors' }] }
    const openai = { id: 'openai', name: 'OpenAI API', provider: 'OpenAI', status: 'operational', category: 'api', aiwatchScore: 79, incidents: [] }
    runWebhookAlerts([], [claudeOp, openai]) // baseline
    runWebhookAlerts([claudeOp, openai], [claudeDown, openai])
    expect(incidentEmbedBody(fetchMock).description).toContain('Suggested fallback: OpenAI API (Score 79)')
  })

  it('includes the AI analysis section when available for the incident (#474)', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    const claudeOp = { id: 'claude', name: 'Claude API', provider: 'Anthropic', status: 'operational', category: 'api', incidents: [] }
    const claudeDown = { ...claudeOp, status: 'down', incidents: [{ id: 'x', status: 'investigating', title: 'Errors' }] }
    const aiAnalysis = { claude: [{ incidentId: 'x', summary: 'Opus inference degraded.', estimatedRecovery: '1–3h', affectedScope: ['Claude API'] }] }
    runWebhookAlerts([], [claudeOp]) // baseline
    runWebhookAlerts([claudeOp], [claudeDown], aiAnalysis)
    const desc = incidentEmbedBody(fetchMock).description
    expect(desc).toContain('🤖 Opus inference degraded.')
    expect(desc).toContain('⏱ Est. recovery: 1–3h')
    expect(desc).toContain('📡 Scope: Claude API')
  })

  it('omits the AI section when no analysis matches the incident (#474 default path)', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    const op = { id: 'claude', name: 'Claude API', provider: 'Anthropic', status: 'operational', category: 'api', incidents: [] }
    const down = { ...op, status: 'down', incidents: [{ id: 'x', status: 'investigating', title: 'Errors' }] }
    runWebhookAlerts([], [op]) // baseline
    runWebhookAlerts([op], [down], { claude: [{ incidentId: 'OTHER', summary: 'unrelated' }] }) // no match for 'x'
    expect(incidentEmbedBody(fetchMock).description).not.toContain('🤖')
  })

  it('groups a multi-service RESOLVED incident into one embed (#474)', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    const inv = (id, name) => ({ id, name, provider: 'Anthropic', status: 'down', category: id === 'claudeai' ? 'app' : 'api', incidents: [{ id: 'x', status: 'investigating', title: 'Errors' }] })
    const res = (id, name) => ({ id, name, provider: 'Anthropic', status: 'operational', category: id === 'claudeai' ? 'app' : 'api', incidents: [{ id: 'x', status: 'resolved', title: 'Errors', duration: '1h' }] })
    runWebhookAlerts([], [inv('claude', 'Claude API'), inv('claudeai', 'claude.ai')]) // baseline
    runWebhookAlerts([inv('claude', 'Claude API'), inv('claudeai', 'claude.ai')], [res('claude', 'Claude API'), res('claudeai', 'claude.ai')])
    const resolvedTitles = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).payload.embeds[0].title).filter((t) => t.includes('Incident resolved'))
    expect(resolvedTitles).toEqual(['🟢 Anthropic (Claude API, claude.ai) — Incident resolved (1h)'])
  })

  it('omits the fallback line for an EXCLUDE_FALLBACK service (#474)', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    // bedrock is in EXCLUDE_FALLBACK → getFallbacks returns [] even with operational candidates.
    const op = { id: 'bedrock', name: 'Bedrock', provider: 'AWS', status: 'operational', category: 'api', aiwatchScore: 90, incidents: [] }
    const down = { ...op, status: 'down', incidents: [{ id: 'x', status: 'investigating', title: 'Errors' }] }
    const openai = { id: 'openai', name: 'OpenAI API', provider: 'OpenAI', status: 'operational', category: 'api', aiwatchScore: 79, incidents: [] }
    runWebhookAlerts([], [op, openai]) // baseline
    runWebhookAlerts([op, openai], [down, openai])
    expect(incidentEmbedBody(fetchMock).description).not.toContain('Suggested fallback')
  })

  it('renders a single-service incident with a bare name (no provider grouping) even when provider is set (#474)', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    const op = { id: 'claude', name: 'Claude API', provider: 'Anthropic', status: 'operational', category: 'api', aiwatchScore: 80, incidents: [] }
    const down = { ...op, status: 'down', incidents: [{ id: 'x', status: 'investigating', title: 'Errors' }] }
    const openai = { id: 'openai', name: 'OpenAI API', provider: 'OpenAI', status: 'operational', category: 'api', aiwatchScore: 79, incidents: [] }
    runWebhookAlerts([], [op, openai]) // baseline
    runWebhookAlerts([op, openai], [down, openai]) // incident only on claude → single service
    expect(incidentEmbedBody(fetchMock).title).toBe('🔴 Claude API — New incident') // bare, no "Anthropic (...)"
  })

  it('neutralizes @everyone/@here in the incident title before posting (#474 sanitize parity)', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    const op = { id: 'claude', name: 'Claude API', provider: 'Anthropic', status: 'down', category: 'api', incidents: [] }
    const down = { ...op, incidents: [{ id: 'x', status: 'investigating', title: 'Outage @everyone <@123>' }] }
    runWebhookAlerts([], [{ ...op, status: 'operational', incidents: [] }]) // baseline
    runWebhookAlerts([{ ...op, status: 'operational', incidents: [] }], [down])
    const desc = incidentEmbedBody(fetchMock).description
    expect(desc).not.toMatch(/@everyone/)
    expect(desc).not.toContain('<@123>')
    expect(desc).toContain('[mention]')
  })

  it('shows per-category fallback for a multi-category incident (#474)', () => {
    withSettings()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    const aff = (id, name, cat) => ({ id, name, provider: 'Anthropic', category: cat, status: 'down', aiwatchScore: 80, incidents: [{ id: 'm', status: 'investigating', title: 'Errors' }] })
    const affOp = (id, name, cat) => ({ ...aff(id, name, cat), status: 'operational', incidents: [] })
    const cand = (id, name, cat, score) => ({ id, name, provider: 'OpenAI', category: cat, status: 'operational', aiwatchScore: score, incidents: [] })
    const candidates = [cand('openai', 'OpenAI API', 'api', 79), cand('chatgpt', 'ChatGPT', 'app', 70), cand('codex', 'Codex', 'agent', 60)]
    const baseline = [affOp('claude', 'Claude API', 'api'), affOp('claudeai', 'claude.ai', 'app'), affOp('claudecode', 'Claude Code', 'agent'), ...candidates]
    const incident = [aff('claude', 'Claude API', 'api'), aff('claudeai', 'claude.ai', 'app'), aff('claudecode', 'Claude Code', 'agent'), ...candidates]
    runWebhookAlerts([], baseline) // baseline
    runWebhookAlerts(baseline, incident, {})
    const desc = incidentEmbedBody(fetchMock).description
    // One labeled line per affected category — not just the first service's category.
    expect(desc).toContain('👉 Suggested fallback')
    expect(desc).toMatch(/LLM: OpenAI API/)
    expect(desc).toMatch(/AI Apps: ChatGPT/)
    expect(desc).toMatch(/CLI Agent: Codex/)
  })
})
