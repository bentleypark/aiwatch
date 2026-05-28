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
})
