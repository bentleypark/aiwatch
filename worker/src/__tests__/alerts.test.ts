import { describe, it, expect, vi } from 'vitest'
import { buildIncidentAlerts, buildServiceAlerts, buildTweetDrafts, buildTweetSearches, buildReplyDraft, mergeTogetherAlerts, mergeXaiRegionalAlerts, isFlapNotice, normalizeFlapTitle, flapSuppressionKey, isFlapSuppressible, isShortIncidentHoldable, FLAP_SUPPRESSION_ESCAPE_MS, incidentRunMs, shouldHoldNewIncident, shouldHoldForAiAnalysis, NEVER_AI_HELD, PUSH_SCOPE, TIER1_IDS, AI_HOLD_MS, pendingAiKey, FLAP_HOLD_MS, pendingNewKey, PENDING_NEW_TTL_S, buildRegionHint, parseAlertedRoster, shouldAlertSourceDead, sourceLivenessOf, decideSourceDeadAction, shouldSuppressSourceDeadAlert, pendingSourceDeadKey, PENDING_SOURCE_DEAD_TTL_S, buildSourceDeadEmbed } from '../alerts'
import type { AlertCandidate, ScoredService } from '../alerts'
import type { Incident } from '../types'
import { SERVICES } from '../services'

describe('sourceLivenessOf (#714)', () => {
  it('dead when sourceDead (confirmed 4xx)', () => {
    expect(sourceLivenessOf({ sourceDead: true })).toBe('dead')
  })
  it('unknown when sourceUnknown (throw / 5xx / 429)', () => {
    expect(sourceLivenessOf({ sourceUnknown: true })).toBe('unknown')
  })
  it('alive when neither flag (clean fetch)', () => {
    expect(sourceLivenessOf({})).toBe('alive')
  })
  it('dead takes precedence if both somehow set (defensive)', () => {
    expect(sourceLivenessOf({ sourceDead: true, sourceUnknown: true })).toBe('dead')
  })
})

describe('shouldAlertSourceDead (#689/#714 — 3-state liveness)', () => {
  it('alerts on the rising edge (dead, not yet alerted)', () => {
    expect(shouldAlertSourceDead('dead', false)).toBe('alert')
  })
  it('does NOT re-alert while still dead + already alerted (deduped)', () => {
    expect(shouldAlertSourceDead('dead', true)).toBe('none')
  })
  it('signals recovery ONLY on a genuine alive observation while alerted', () => {
    expect(shouldAlertSourceDead('alive', true)).toBe('recovered')
  })
  it('stays quiet when alive + never alerted', () => {
    expect(shouldAlertSourceDead('alive', false)).toBe('none')
  })

  // #714 — the core fix: an indeterminate (unknown) cycle is NOT a recovery
  it('HOLDS on unknown while alerted — never a false recovery (the #714 flap)', () => {
    expect(shouldAlertSourceDead('unknown', true)).toBe('hold')
  })
  it('stays quiet on unknown when never alerted', () => {
    expect(shouldAlertSourceDead('unknown', false)).toBe('none')
  })

  it('#714 flap sequence: dead→unknown→dead fires NO recovery (was the repeating Inactive/Recovered)', () => {
    // Cycle A: dead, not alerted → alert (then caller sets the marker)
    expect(shouldAlertSourceDead('dead', false)).toBe('alert')
    // Cycle B: a transient throw mid-dead-source → unknown, alerted → HOLD (pre-#714 this was 'recovered')
    expect(shouldAlertSourceDead('unknown', true)).toBe('hold')
    // Cycle C: dead again, still alerted → none (no re-alert; marker was never cleared by the hold)
    expect(shouldAlertSourceDead('dead', true)).toBe('none')
  })

  it('#714 genuine recovery: dead→alive fires exactly one recovery', () => {
    expect(shouldAlertSourceDead('dead', false)).toBe('alert')   // A: rising edge
    expect(shouldAlertSourceDead('alive', true)).toBe('recovered') // B: page returns 200 → real recovery
    expect(shouldAlertSourceDead('alive', false)).toBe('none')   // C: marker cleared → quiet
  })
})

describe('pendingSourceDeadKey / PENDING_SOURCE_DEAD_TTL_S (#714)', () => {
  it('scopes the confirmation marker per service', () => {
    expect(pendingSourceDeadKey('characterai')).toBe('pending:source-dead:characterai')
  })
  it('TTL spans two cron cycles (survives one skipped run) — its own 1-cycle debounce window', () => {
    // #835 — PENDING_NEW_TTL_S diverged from this (raised to 1800 for the ~2-cycle, write-once
    // first-seen marker); the source-dead debounce is still a 1-cycle confirm gate, so it keeps 600.
    expect(PENDING_SOURCE_DEAD_TTL_S).toBe(600)
  })
})

describe('decideSourceDeadAction (#714 — liveness edge + 1-cycle confirmation gate)', () => {
  const at = (liveness: 'dead' | 'alive' | 'unknown', alreadyAlerted: boolean, pendingExists: boolean) =>
    decideSourceDeadAction(liveness, { alreadyAlerted, pendingExists })

  it('first dead sighting is HELD one cycle (debounce a single-cycle 4xx blip)', () => {
    expect(at('dead', false, false)).toBe('hold-confirm')
  })
  it('dead confirmed a second consecutive cycle (pending set) → fires the alert', () => {
    expect(at('dead', false, true)).toBe('alert')
  })
  it('does not re-alert once already alerted', () => {
    expect(at('dead', true, false)).toBe('none')
    expect(at('dead', true, true)).toBe('none')
  })
  it('unknown while alerted → hold-unknown (no false recovery — the #714 bug)', () => {
    expect(at('unknown', true, false)).toBe('hold-unknown')
  })
  it('genuine alive while alerted → recovered', () => {
    expect(at('alive', true, false)).toBe('recovered')
  })
  it('alive while not alerted → none (caller clears any stale pending)', () => {
    expect(at('alive', false, true)).toBe('none')
  })

  // ── Full cron-cycle sequences (the acceptance criteria) ──

  it('CONSISTENTLY DEAD source (Character.AI): exactly one alert, then quiet — no repeating pairs', () => {
    // A: first dead → held (pending written by caller)
    expect(at('dead', false, false)).toBe('hold-confirm')
    // B: still dead, pending present → fire ONE 'Inactive' (caller sets deadKey, clears pending)
    expect(at('dead', false, true)).toBe('alert')
    // C+: still dead, already alerted → silence (no Inactive/Recovered churn)
    expect(at('dead', true, false)).toBe('none')
    expect(at('dead', true, false)).toBe('none')
  })

  it('the #714 flap (dead→transient→dead AFTER alerting): a transient cycle never fabricates recovery', () => {
    // already alerted (deadKey set, pending cleared)
    expect(at('unknown', true, false)).toBe('hold-unknown') // throw/5xx mid-dead → HOLD (was 'recovered')
    expect(at('dead', true, false)).toBe('none')            // dead again → still silent (marker kept)
  })

  it('single-cycle 4xx blip that self-recovers: held, then recovered before confirming → no alert at all', () => {
    expect(at('dead', false, false)).toBe('hold-confirm')   // A: blip → held (pending set)
    expect(at('alive', false, true)).toBe('none')           // B: back to 200 before confirm → none (no Inactive)
    // → caller drops the stale pending; no 'Inactive' was sent, so no 'Recovered' either
  })

  it('genuine recovery after a confirmed alert fires exactly one Recovered', () => {
    expect(at('dead', false, true)).toBe('alert')           // confirmed dead → alert (deadKey set)
    expect(at('alive', true, false)).toBe('recovered')      // page returns 200 → one Recovered (deadKey cleared)
    expect(at('alive', false, false)).toBe('none')          // quiet thereafter
  })
})

describe('shouldSuppressSourceDeadAlert (#800)', () => {
  const dead = { statusSourceDeactivated: true }
  it('SUPPRESSES the recurring rising-edge alert for a known-deactivated source', () => {
    expect(shouldSuppressSourceDeadAlert('alert', dead)).toBe(true)
  })
  it('NEVER suppresses a recovery — a reactivation is worth one alert', () => {
    expect(shouldSuppressSourceDeadAlert('recovered', dead)).toBe(false)
  })
  it('does NOT suppress when the flag is absent/false (normal services re-alert as before)', () => {
    expect(shouldSuppressSourceDeadAlert('alert', {})).toBe(false)
    expect(shouldSuppressSourceDeadAlert('alert', { statusSourceDeactivated: false })).toBe(false)
  })
  it('only the alert edge is in scope — hold/none never reach the send anyway', () => {
    for (const a of ['hold-confirm', 'hold-unknown', 'none'] as const) {
      expect(shouldSuppressSourceDeadAlert(a, dead)).toBe(false)
    }
  })
})

describe('buildSourceDeadEmbed (#689)', () => {
  it('is a distinct "source inactive" operator alert — yellow, NOT a red "degraded"', () => {
    const e = buildSourceDeadEmbed('Character.AI', 'https://status.character.ai', false)
    expect(e.title).toContain('Status Source Inactive')
    expect(e.description).toContain('NOT a service degradation')
    expect(e.description).toContain('https://status.character.ai')
    expect(e.color).toBe(0xFEE75C) // yellow (operator action), not red 0xED4245
  })
  it('emits a green recovery note when the source responds again', () => {
    const e = buildSourceDeadEmbed('Character.AI', 'https://status.character.ai', true)
    expect(e.title).toContain('Recovered')
    expect(e.color).toBe(0x57F287)
  })
})

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

// Typed incident factory: fills the required `impact`/`duration`/`timeline` defaults so inline
// mocks only specify the fields a test cares about. Defaults are the neutral empty values
// (impact null, duration null, empty timeline) — overridable via the partial.
function inc(o: Partial<Incident> & Pick<Incident, 'id' | 'title' | 'status' | 'startedAt'>): Incident {
  return { impact: null, duration: null, timeline: [], ...o }
}

describe('buildIncidentAlerts', () => {
  it('creates new incident alert for recent non-resolved incident', () => {
    const svc = mockService({
      incidents: [inc({ id: 'inc1', title: 'API Error', status: 'investigating', startedAt: recentDate, impact: 'major' })],
    })
    const alerts = buildIncidentAlerts([svc], alertedMap(), NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].key).toBe('alerted:new:inc1')
    expect(alerts[0].title).toContain('New Incident')
  })

  // #1039 — the alert path was the ONLY consumer treating `monitoring` as a new outage. Every other
  // site (ext-claude.ts:86, incident-history.ts:154, six in index.ts incl. the "monitoring = recovery
  // confirmed" one) filters `!== 'resolved' && !== 'monitoring'`. The dissent shipped a real red
  // `🔴 OpenAI API — New Incident` for an already-recovering incident on 2026-07-16.
  describe('#1039 — `monitoring` is not a NEW outage', () => {
    const sso = (status: Incident['status']) =>
      inc({ id: 'sso1', title: 'Elevated Error Rates For SSO Login', status, startedAt: recentDate, impact: 'minor' })

    it('fires NO new alert for an incident first observed at `monitoring` (the production bug)', () => {
      const svc = mockService({ status: 'degraded', incidents: [sso('monitoring')] })
      expect(buildIncidentAlerts([svc], alertedMap(), NOW)).toHaveLength(0)
    })

    it('the #545 joiner case: a service joining while the incident is already `monitoring` stays silent', () => {
      // Exactly 2026-07-16: chatgpt had alerted; the #1032 deploy made openai join the same incident id,
      // which was `monitoring` by then → openai got its own red "New Incident".
      const openai = mockService({ id: 'openai', name: 'OpenAI API', status: 'degraded', incidents: [sso('monitoring')] })
      const chatgpt = mockService({ id: 'chatgpt', name: 'ChatGPT', category: 'app', status: 'degraded', incidents: [sso('monitoring')] })
      expect(buildIncidentAlerts([openai, chatgpt], alertedMap({ sso1: ['chatgpt'] }), NOW)).toHaveLength(0)
    })

    it('still fires for `investigating` and `identified` — only `monitoring` is excluded', () => {
      for (const status of ['investigating', 'identified'] as const) {
        const svc = mockService({ status: 'degraded', incidents: [sso(status)] })
        const alerts = buildIncidentAlerts([svc], alertedMap(), NOW)
        expect(alerts, `status=${status}`).toHaveLength(1)
        expect(alerts[0].title).toContain('New Incident')
      }
    })

    it('a reopen does NOT re-alert a service already in the roster — the #545 dedup still rules', () => {
      // Documents the REAL behaviour, which is NOT "reopens alert again": the branch also requires
      // `!alertedNewMap...has(svc.id)`, so a service that alerted at `investigating` stays deduped
      // through monitoring → investigating. Only a service never alerted for this incident (i.e. the
      // monitoring-first case) can alert on a reopen. Asserting with an EMPTY roster would model no
      // reopen at all and pass for the wrong reason.
      const svc = mockService({ status: 'degraded', incidents: [sso('investigating')] })
      expect(buildIncidentAlerts([svc], alertedMap({ sso1: ['openai'] }), NOW)).toHaveLength(0)
    })

    it('a monitoring-first service DOES alert if the incident reopens to `investigating` (never rostered)', () => {
      const svc = mockService({ status: 'degraded', incidents: [sso('investigating')] })
      expect(buildIncidentAlerts([svc], alertedMap(), NOW)).toHaveLength(1)
    })

    it('logs the withheld alert — a judgement drop must be observable (#970/#983)', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const svc = mockService({ status: 'degraded', incidents: [sso('monitoring')] })
      buildIncidentAlerts([svc], alertedMap(), NOW)
      const line = log.mock.calls.flat().join(' ')
      expect(line).toContain('#1039')
      // The line describes a STATE, not an event: this fn is stateless and a withheld alert is never
      // rostered, so it reprints every cycle (below). "first sight" would be false from cycle 2 on.
      expect(line).not.toContain('first sight')
      log.mockRestore()
    })

    it('the log repeats each cycle — so line COUNT is not a frequency (count distinct incident ids)', () => {
      // Pins the reasoning the comment + doc rely on: three cron cycles over one withheld incident
      // produce three lines, not one. Anyone grepping this line to size the residual risk must dedup
      // by incident id, or they overcount by the monitoring duration in cycles.
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const svc = mockService({ status: 'degraded', incidents: [sso('monitoring')] })
      for (let i = 0; i < 3; i++) buildIncidentAlerts([svc], alertedMap(), NOW + i * 300_000)
      expect(log.mock.calls.filter((c) => c.join(' ').includes('#1039'))).toHaveLength(3)
      log.mockRestore()
    })

    it('does NOT log when the service was already rostered (normal path stays quiet)', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const svc = mockService({ status: 'degraded', incidents: [sso('monitoring')] })
      buildIncidentAlerts([svc], alertedMap({ sso1: ['openai'] }), NOW)
      expect(log.mock.calls.flat().join(' ')).not.toContain('#1039')
      log.mockRestore()
    })

    it('`monitoring` → `resolved` still fires exactly one resolved alert when it HAD been alerted', () => {
      // The normal path: alerted at `investigating`, silent through `monitoring`, resolved alert at the end.
      const svc = mockService({
        incidents: [inc({ id: 'sso1', title: 'Elevated Error Rates For SSO Login', status: 'resolved', startedAt: recentDate, duration: '2h', impact: 'minor' })],
      })
      const alerts = buildIncidentAlerts([svc], alertedMap({ sso1: ['openai'] }), NOW)
      expect(alerts).toHaveLength(1)
      expect(alerts[0].key).toBe('alerted:res:sso1')
    })

    it('a joiner that stayed silent still appears in the resolved alert (accurate: it WAS affected)', () => {
      const resolved = inc({ id: 'sso1', title: 'Elevated Error Rates For SSO Login', status: 'resolved', startedAt: recentDate, duration: '2h', impact: 'minor' })
      const openai = mockService({ id: 'openai', name: 'OpenAI API', incidents: [resolved] })
      const chatgpt = mockService({ id: 'chatgpt', name: 'ChatGPT', category: 'app', incidents: [resolved] })
      const alerts = buildIncidentAlerts([openai, chatgpt], alertedMap({ sso1: ['chatgpt'] }), NOW)
      expect(alerts).toHaveLength(1)
      expect(alerts[0].svcIds).toEqual(['openai', 'chatgpt'])
    })

    it('no `new` candidate ⇒ the #778 phone push has nothing to find (leak closed for free)', () => {
      const svc = mockService({ status: 'degraded', incidents: [sso('monitoring')] })
      const alerts = buildIncidentAlerts([svc], alertedMap(), NOW)
      // pushTargetFor only ever reads a `new`-keyed candidate; with none built it cannot fire.
      expect(alerts.filter((a) => a.key.startsWith('alerted:new:'))).toHaveLength(0)
    })
  })

  it('skips already-alerted new incidents', () => {
    const svc = mockService({
      incidents: [inc({ id: 'inc1', title: 'API Error', status: 'investigating', startedAt: recentDate, impact: 'major' })],
    })
    const alerts = buildIncidentAlerts([svc], alertedMap({ inc1: ['openai'] }), NOW)
    expect(alerts).toHaveLength(0)
  })

  it('skips incidents older than 24 hours', () => {
    const svc = mockService({
      incidents: [inc({ id: 'inc1', title: 'Old Error', status: 'investigating', startedAt: oldDate, impact: 'major' })],
    })
    const alerts = buildIncidentAlerts([svc], alertedMap(), NOW)
    expect(alerts).toHaveLength(0)
  })

  it('creates resolved alert only if previously alerted as new', () => {
    const svc = mockService({
      incidents: [inc({ id: 'inc1', title: 'Fixed', status: 'resolved', startedAt: recentDate, duration: '30m', impact: 'major' })],
    })

    // Not previously alerted → no resolved alert
    expect(buildIncidentAlerts([svc], alertedMap(), NOW)).toHaveLength(0)

    // Previously alerted → resolved alert
    const alerts = buildIncidentAlerts([svc], alertedMap({ inc1: ['openai'] }), NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].key).toBe('alerted:res:inc1')
    expect(alerts[0].title).toContain('Resolved (30m)')
  })

  // #1021 — a non-reliability advisory (usage-limits/quota, down-classified to impact:null upstream) must
  // not go out framed as a red outage; it's reframed informational (ℹ️/blue, no fallback, no tweet draft).
  it('#1021 reframes a usage-limits/quota advisory as informational (ℹ️/blue), not 🔴 New Incident', () => {
    const svc = mockService({
      status: 'operational',
      incidents: [inc({ id: 'adv1', title: 'Usage Limits Depleting Faster Than Expected', status: 'investigating', startedAt: recentDate, impact: null })],
    })
    const [a] = buildIncidentAlerts([svc], alertedMap(), NOW)
    expect(a.title.startsWith('ℹ️')).toBe(true)
    expect(a.title).toContain('Advisory')
    expect(a.title).not.toContain('New Incident')
    expect(a.color).toBe(0x5865F2)      // blurple (informational), not red
    expect(a.advisory).toBe(true)
    expect(a.fallbackText).toBe('')     // no "try X instead" — an advisory isn't an outage
    expect(a.key).toBe('alerted:new:adv1') // #1021 dedup key UNCHANGED (paired resolved still matches)
  })

  it('#1021 an outage-signal title still gets 🔴 New Incident even with an advisory word (outage wins)', () => {
    const svc = mockService({
      incidents: [inc({ id: 'out1', title: 'Elevated error rates — quota exceeded', status: 'investigating', startedAt: recentDate, impact: 'major' })],
    })
    const [a] = buildIncidentAlerts([svc], alertedMap(), NOW)
    expect(a.title).toContain('New Incident')
    expect(a.color).toBe(0xED4245)
    expect(a.advisory).toBeUndefined()
  })

  it('#1021 a resolved advisory clears as "ℹ️ Advisory cleared" with no downtime duration', () => {
    const svc = mockService({
      incidents: [inc({ id: 'adv1', title: 'Increased quota for all Pro tiers', status: 'resolved', startedAt: recentDate, duration: '72h 3m', impact: null })],
    })
    const [a] = buildIncidentAlerts([svc], alertedMap({ adv1: ['openai'] }), NOW)
    expect(a.title).toContain('Advisory cleared')
    expect(a.title).not.toContain('72h') // duration omitted — an advisory's up-time is not downtime
    expect(a.advisory).toBe(true)
  })

  it('#1021 buildTweetDrafts skips an advisory alert (no "X is having an outage" tweet for a quota notice)', () => {
    const svc = mockService({ // id 'openai' ∈ TWEET_DRAFT_SERVICES
      incidents: [inc({ id: 'adv1', title: 'Usage Limits Depleting', status: 'investigating', startedAt: recentDate, impact: null })],
    })
    const [a] = buildIncidentAlerts([svc], alertedMap(), NOW)
    expect(a.advisory).toBe(true)
    expect(buildTweetDrafts(a, [svc])).toEqual([])
  })

  it('#1021 buildTweetSearches + buildReplyDraft ALSO skip an advisory (no false "is X down" reply/search)', () => {
    // The motivating case: codex ∈ TWEET_SEARCH_TERMS + operational badge → a reply draft would otherwise
    // read "🔴 yes — Codex is down right now", factually false for a quota notice.
    const svc = mockService({ id: 'codex', name: 'Codex', provider: 'OpenAI', category: 'agent', status: 'operational',
      incidents: [inc({ id: 'adv1', title: 'Codex Usage Limits Depleting Faster Than Expected', status: 'investigating', startedAt: recentDate, impact: null })],
    })
    const [a] = buildIncidentAlerts([svc], alertedMap(), NOW)
    expect(a.advisory).toBe(true)
    expect(buildTweetSearches(a, [svc])).toEqual([]) // no "is codex down" search links
    expect(buildReplyDraft(a, [svc])).toBeNull()     // no false "Codex is down right now" reply
  })

  it('#1021 a REAL codex outage still gets its reply draft + search links (control)', () => {
    const svc = mockService({ id: 'codex', name: 'Codex', provider: 'OpenAI', category: 'agent', status: 'degraded',
      incidents: [inc({ id: 'out1', title: 'Elevated error rates on Codex', status: 'investigating', startedAt: recentDate, impact: 'major' })],
    })
    const [a] = buildIncidentAlerts([svc], alertedMap(), NOW)
    expect(a.advisory).toBeUndefined()
    expect(buildTweetSearches(a, [svc]).length).toBeGreaterThan(0)
    expect(buildReplyDraft(a, [svc])).not.toBeNull()
  })

  it('includes fallback text as separate field for degraded service', () => {
    const openai = mockService({
      id: 'openai', status: 'degraded',
      incidents: [inc({ id: 'inc1', title: 'Slow', status: 'investigating', startedAt: recentDate, impact: 'minor' })],
    })
    const claude = mockService({ id: 'claude', name: 'Claude API', aiwatchScore: 90 })
    const alerts = buildIncidentAlerts([openai, claude], alertedMap(), NOW)
    expect(alerts[0].description).toBe('Slow')
    expect(alerts[0].fallbackText).toContain('Suggested fallback')
  })

  it('omits fallback when service is operational (incident without outage)', () => {
    const openai = mockService({
      id: 'openai', status: 'operational',
      incidents: [inc({ id: 'inc1', title: 'Minor issue', status: 'investigating', startedAt: recentDate, impact: 'minor' })],
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
    const sharedIncident = inc({ id: 'shared1', title: 'Elevated errors', status: 'investigating', startedAt: recentDate, impact: 'major' })
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

  it('#781 — groups fallbacks PER CATEGORY for a shared multi-category incident (LLM + Coding Agent, not LLM-only)', () => {
    const sharedIncident = inc({ id: 'shared2', title: 'Opus errors', status: 'investigating', startedAt: recentDate, impact: 'major' })
    const claude = mockService({ id: 'claude', name: 'Claude API', category: 'api', status: 'degraded', incidents: [sharedIncident], aiwatchScore: 80 })
    const claudecode = mockService({ id: 'claude-code', name: 'Claude Code', category: 'agent', status: 'degraded', incidents: [sharedIncident], aiwatchScore: 70 })
    const openai = mockService({ id: 'openai', name: 'OpenAI API', category: 'api', status: 'operational', aiwatchScore: 90 })
    const cursor = mockService({ id: 'cursor', name: 'Cursor', category: 'agent', status: 'operational', aiwatchScore: 75 })

    const alerts = buildIncidentAlerts([claude, claudecode, openai, cursor], alertedMap(), NOW)
    const first = alerts.find(a => a.key === 'alerted:new:shared2')!
    // The incident spans api (Claude API) + agent (Claude Code), so the fallback now lists BOTH an LLM
    // alternative AND a Coding-Agent alternative (the old behavior wrongly showed LLM-only) — matching
    // the dashboard's per-category grouping (#781).
    expect(first.fallbackText).toContain('OpenAI API') // LLM group
    expect(first.fallbackText).toContain('Cursor')      // Coding Agent group (was excluded before)
    expect(first.fallbackText).toContain('LLM')
    expect(first.fallbackText).toContain('Coding Agent')
  })

  it('handles multiple incidents per service', () => {
    const svc = mockService({
      incidents: [
        inc({ id: 'inc1', title: 'Error 1', status: 'investigating', startedAt: recentDate, impact: 'major' }),
        inc({ id: 'inc2', title: 'Error 2', status: 'resolved', startedAt: recentDate, duration: '10m', impact: 'minor' }),
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
    const shared = inc({ id: 'oai-multi', title: 'Elevated errors on Codex and ChatGPT', status: 'investigating' as const, startedAt: recentDate, impact: 'major' as const })
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
  const regionSpecific: Incident = inc({
    id: 'pc1', title: 'Index unavailable', status: 'investigating',
    startedAt: recentDate, impact: 'major', componentNames: ['AWS us-east-1'],
  })

  it('buildRegionHint recommends the first healthy region for a region-specific outage', () => {
    const pinecone = mockService({ id: 'pinecone', name: 'Pinecone', status: 'degraded', incidents: [regionSpecific] })
    expect(buildRegionHint(pinecone)).toBe('📍 Try region: AWS US West')
  })

  it('buildRegionHint returns undefined for a non-region-aware service', () => {
    // mistral has no SERVICE_REGIONS entry → regionStatusOf returns null
    const mistral = mockService({ id: 'mistral', name: 'Mistral API', status: 'degraded',
      incidents: [inc({ id: 'm1', title: 'Errors', status: 'investigating', startedAt: recentDate, impact: 'major' })] })
    expect(buildRegionHint(mistral)).toBeUndefined()
  })

  it('buildRegionHint returns undefined for a region-AWARE but non-switchable service (#973)', () => {
    // openai names regions in incident text but exposes no selectable region endpoint, so the
    // Discord hint must stay silent — "📍 Try region: US West" was an unactionable instruction.
    const openai = mockService({ id: 'openai', name: 'OpenAI API', status: 'degraded',
      incidents: [inc({ id: 'o1', title: 'Elevated errors in us-east-1', status: 'investigating', startedAt: recentDate, impact: 'major' })] })
    expect(buildRegionHint(openai)).toBeUndefined()
  })

  it('buildRegionHint returns undefined for a global (non-region-specific) incident', () => {
    // No region in title/components → every region marked down via fallback → allDown → no recommendation
    const pinecone = mockService({ id: 'pinecone', name: 'Pinecone', status: 'down',
      incidents: [inc({ id: 'pc-global', title: 'Major outage', status: 'investigating', startedAt: recentDate, impact: 'critical' })] })
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
      inc({ id: 'pc-global', title: 'Major outage', status: 'investigating', startedAt: recentDate, impact: 'critical' }),
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
      inc({ id: 'pc-e', title: 'Outage', status: 'investigating', startedAt: recentDate, impact: 'major', componentNames: ['AWS us-east-1'] }),
      inc({ id: 'pc-w', title: 'Outage', status: 'investigating', startedAt: recentDate, impact: 'major', componentNames: ['AWS us-west-2'] }),
    ] })
    expect(buildRegionHint(pinecone)).toBe('📍 Try region: AWS EU West')
  })

  it('#641 suppresses the cross-service fallback when a region switch IS offered', () => {
    // Pinecone is region-SWITCHABLE (#973) AND fallback-eligible (un-excluded in #857). A
    // region-specific outage is solved by the cheaper same-provider region switch, so the
    // cross-service fallback (turbopuffer) must be suppressed to avoid redundant noise.
    const pinecone = mockService({ id: 'pinecone', name: 'Pinecone', provider: 'Pinecone', category: 'api', status: 'degraded', incidents: [
      inc({ id: 'pc-r', title: 'Elevated errors', status: 'investigating', startedAt: recentDate, impact: 'major', componentNames: ['AWS us-east-1'] }),
    ] })
    const turbopuffer = mockService({ id: 'turbopuffer', name: 'turbopuffer', provider: 'turbopuffer', category: 'api', status: 'operational', aiwatchScore: 95 })
    const alert = buildIncidentAlerts([pinecone, turbopuffer], alertedMap(), NOW).find(a => a.key === 'alerted:new:pc-r')
    expect(alert).toBeDefined()
    expect(alert!.regionText).toBe('📍 Try region: AWS US West')
    expect(alert!.fallbackText).toBe('') // suppressed despite turbopuffer being an operational same-tier fallback

    // Contrast — proves the assertion above tests SUPPRESSION, not the absence of any fallback for
    // pinecone. Same two services, but a GLOBAL incident (no region key) → no region switch to
    // offer → turbopuffer must surface. Without this, a future change that de-pairs turbopuffer
    // from pinecone would leave the `fallbackText === ''` assertion passing vacuously.
    const globalPinecone = mockService({ id: 'pinecone', name: 'Pinecone', provider: 'Pinecone', category: 'api', status: 'degraded', incidents: [
      inc({ id: 'pc-g', title: 'API authentication broken', status: 'investigating', startedAt: recentDate, impact: 'major' }),
    ] })
    const globalAlert = buildIncidentAlerts([globalPinecone, turbopuffer], alertedMap(), NOW).find(a => a.key === 'alerted:new:pc-g')
    expect(globalAlert!.regionText).toBeUndefined()
    expect(globalAlert!.fallbackText).toContain('turbopuffer')
  })

  it('#973 keeps the cross-service fallback for a region-AWARE but non-switchable service', () => {
    // The inverse of the case above, and the regression #973 fixed. OpenAI names us-east-1 in the
    // incident, so the pre-#973 code offered "📍 Try region: US West (us-west-2)" — an endpoint the
    // caller cannot select — AND suppressed the Claude fallback, which they CAN act on. Now the
    // region hint is silent and the fallback survives.
    const openai = mockService({ id: 'openai', name: 'OpenAI API', status: 'degraded', incidents: [
      inc({ id: 'oai-r', title: 'Elevated errors', status: 'investigating', startedAt: recentDate, impact: 'major', componentNames: ['us-east-1'] }),
    ] })
    const claude = mockService({ id: 'claude', name: 'Claude API', provider: 'Anthropic', status: 'operational', aiwatchScore: 95 })
    const alert = buildIncidentAlerts([openai, claude], alertedMap(), NOW).find(a => a.key === 'alerted:new:oai-r')
    expect(alert).toBeDefined()
    expect(alert!.regionText).toBeUndefined()
    expect(alert!.fallbackText).toContain('Claude API')
  })

  it('#641 still shows the cross-service fallback for a GLOBAL (non-region) incident', () => {
    // No region switch applies → the cross-service fallback is the only actionable alternative.
    const openai = mockService({ id: 'openai', name: 'OpenAI API', status: 'down', incidents: [
      inc({ id: 'oai-g', title: 'Major outage', status: 'investigating', startedAt: recentDate, impact: 'critical' }),
    ] })
    const claude = mockService({ id: 'claude', name: 'Claude API', provider: 'Anthropic', status: 'operational', aiwatchScore: 95 })
    const alert = buildIncidentAlerts([openai, claude], alertedMap(), NOW).find(a => a.key === 'alerted:new:oai-g')
    expect(alert).toBeDefined()
    expect(alert!.regionText).toBeUndefined()        // global → no region hint
    expect(alert!.fallbackText).toContain('Claude API') // fallback shown
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

  // #1292 — a synthesized (`status_history`-derived) incident is a per-DAY downtime bucket, not an
  // observed event. Neither of these two guards had ANY test: `grep status_history alerts.test.ts`
  // returned nothing before round 12, and a suppressed alert is the one failure here nobody would see.
  describe('#1292 — a synthesized incident never stands in for an observed event', () => {
    const NOW = Date.parse('2026-08-20T12:00:00.000Z')
    const derived = {
      id: 'bs-hist:1:2026-08-20', title: 'api.hconeai.com — recovered', status: 'resolved' as const,
      impact: 'minor' as const, startedAt: '2026-08-20T00:00:00.000Z',
      // A full-day bucket closes at the page-local anchor, which lands INSIDE the 15-minute
      // #394 race window — the exact coincidence that would silence a real alert.
      resolvedAt: '2026-08-20T11:55:00.000Z',
      duration: '11h 55m', timeline: [], derived: 'status_history' as const, derivedDay: '2026-08-20',
    }

    it('does not silence a REAL degraded alert via the #394 recently-resolved window', () => {
      const svc = mockService({ status: 'degraded', incidents: [derived] })
      const alerts = buildServiceAlerts([svc], new Map(), new Map(), NOW)
      expect(alerts.map((a) => a.key), 'the 🟠 must still fire').toEqual(['alerted:degraded:openai'])
    })

    it('CONTROL — a provider-published resolution in the same window DOES silence it', () => {
      const published = { ...derived, id: 'rss-1', derived: undefined, derivedDay: undefined }
      const svc = mockService({ status: 'degraded', incidents: [published] })
      expect(buildServiceAlerts([svc], new Map(), new Map(), NOW),
        'the guard must be what differs, not the fixture').toEqual([])
    })

    it('does not caption a 🟢 Recovered with a reconstructed day-bucket', () => {
      // For a service whose feed died, a synthesized row is the newest "resolved" for up to 30 days,
      // so today's recovery alert would quote a day bucket from weeks ago.
      const svc = mockService({ status: 'operational', incidents: [derived] })
      const alerts = buildServiceAlerts([svc], new Map([['openai', '2026-08-20T00:00:00.000Z']]), new Map(), NOW)
      const recovered = alerts.find((a) => a.key === 'alerted:recovered:openai')
      expect(recovered, 'the recovery alert itself must still fire').toBeDefined()
      expect(recovered!.description, 'but never quoting the synthesized title')
        .not.toContain('api.hconeai.com')
    })

    it('CONTROL — a provider-published resolution IS quoted', () => {
      const published = { ...derived, id: 'rss-1', derived: undefined, derivedDay: undefined }
      const svc = mockService({ status: 'operational', incidents: [published] })
      const alerts = buildServiceAlerts([svc], new Map([['openai', '2026-08-20T00:00:00.000Z']]), new Map(), NOW)
      expect(alerts.find((a) => a.key === 'alerted:recovered:openai')!.description)
        .toContain('api.hconeai.com')
    })
  })

  // #1233 — the decision that an unreadable source fires NO status-edge alert existed only as an
  // 11-line comment; the degraded arm could be rewritten as `!isHealthyStatus(svc.status)` — which
  // reads as a tidy-up — and start Discord-paging Tier 1 off a status page we failed to fetch.
  it('fires NO alert for an unreadable source — we alert on what we KNOW', () => {
    expect(buildServiceAlerts([mockService({ status: 'unknown' })], new Map(), new Map())).toEqual([])
  })

  it('stays ARMED through an unreadable spell: no 🟢 recovery until we can read `operational` again', () => {
    const armed = new Map([['openai', new Date().toISOString()]])
    // Losing sight of a service is not evidence it came back, so the down marker must survive and
    // no recovery may fire. This is the #1232 flap in the opposite direction.
    expect(buildServiceAlerts([mockService({ status: 'unknown' })], armed, new Map())).toEqual([])

    // Control: an actual `operational` read DOES fire the recovery the line above withholds.
    const recovered = buildServiceAlerts([mockService({ status: 'operational' })], armed, new Map())
    expect(recovered).toHaveLength(1)
    expect(recovered[0].key).toBe('alerted:recovered:openai')
  })

  it('suppresses status alert when ongoing incidents exist', () => {
    const svc = mockService({
      status: 'degraded',
      incidents: [inc({ id: 'inc1', title: 'Errors', status: 'investigating', startedAt: recentDate, impact: 'major' })],
    })
    const alerts = buildServiceAlerts([svc], new Map(), new Map())
    expect(alerts).toHaveLength(0)
  })

  it('suppresses down alert when ongoing incidents exist', () => {
    const svc = mockService({
      status: 'down',
      incidents: [inc({ id: 'inc1', title: 'Outage', status: 'identified', startedAt: recentDate, impact: 'critical' })],
    })
    const alerts = buildServiceAlerts([svc], new Map(), new Map())
    expect(alerts).toHaveLength(0)
  })

  it('does not suppress when all incidents are resolved without resolvedAt', () => {
    const svc = mockService({
      status: 'degraded',
      incidents: [inc({ id: 'inc1', title: 'Fixed', status: 'resolved', startedAt: recentDate, duration: '10m', impact: 'minor' })],
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
        incidents: [inc({ id: 'inc1', title: 'Fixed', status: 'resolved', startedAt: recentDate, resolvedAt, duration: '7m', impact: 'major' })],
      })
      expect(buildServiceAlerts([svc], new Map(), new Map(), NOW)).toHaveLength(0)
    })

    it('fires degraded alert when incident resolved more than 15min ago', () => {
      const resolvedAt = new Date(NOW - 16 * 60_000).toISOString()
      const svc = mockService({
        status: 'degraded',
        incidents: [inc({ id: 'inc1', title: 'Fixed', status: 'resolved', startedAt: recentDate, resolvedAt, duration: '7m', impact: 'major' })],
      })
      const alerts = buildServiceAlerts([svc], new Map(), new Map(), NOW)
      expect(alerts).toHaveLength(1)
      expect(alerts[0].key).toBe('alerted:degraded:openai')
    })

    it('does NOT suppress down alert during race window (high-urgency)', () => {
      const resolvedAt = new Date(NOW - 5 * 60_000).toISOString()
      const svc = mockService({
        status: 'down',
        incidents: [inc({ id: 'inc1', title: 'Fixed', status: 'resolved', startedAt: recentDate, resolvedAt, duration: '7m', impact: 'major' })],
      })
      const alerts = buildServiceAlerts([svc], new Map(), new Map(), NOW)
      expect(alerts).toHaveLength(1)
      expect(alerts[0].key).toBe('alerted:down:openai')
    })

    it('handles invalid resolvedAt without throwing — falls through to degraded fire', () => {
      const svc = mockService({
        status: 'degraded',
        incidents: [inc({ id: 'inc1', title: 'Fixed', status: 'resolved', startedAt: recentDate, resolvedAt: 'not-a-date', duration: '7m', impact: 'major' })],
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

  describe('#767 — service-status alerts restricted to a Tier-1 safety net', () => {
    it('does NOT emit a down alert for a NON-Tier-1 service (incident alerts are canonical)', () => {
      const svc = mockService({ id: 'assemblyai', name: 'AssemblyAI', provider: 'AssemblyAI', status: 'down' })
      expect(buildServiceAlerts([svc], new Map(), new Map())).toHaveLength(0)
    })

    it('does NOT emit a degraded alert for a NON-Tier-1 service', () => {
      const svc = mockService({ id: 'mistral', name: 'Mistral API', provider: 'Mistral AI', status: 'degraded' })
      expect(buildServiceAlerts([svc], new Map(), new Map())).toHaveLength(0)
    })

    it('does NOT emit a recovery alert for a NON-Tier-1 service even if a stale alerted-down map entry exists', () => {
      // Defensive: down/degraded are no longer emitted for non-Tier-1, so the map shouldn't carry
      // them — but if a stale entry lingers, the recovery must still be suppressed.
      const svc = mockService({ id: 'assemblyai', name: 'AssemblyAI', status: 'operational' })
      expect(buildServiceAlerts([svc], new Map([['assemblyai', '2026-03-24T00:00:00Z']]), new Map())).toHaveLength(0)
    })

    it('STILL emits a down alert for each Tier-1 service (claude/openai/gemini safety net)', () => {
      for (const [id, name] of [['claude', 'Claude API'], ['openai', 'OpenAI API'], ['gemini', 'Gemini API']] as const) {
        const svc = mockService({ id, name, status: 'down' })
        const alerts = buildServiceAlerts([svc], new Map(), new Map())
        expect(alerts, `${id} should still page`).toHaveLength(1)
        expect(alerts[0].key).toBe(`alerted:down:${id}`)
      }
    })

    it('Tier-1 down + non-Tier-1 down → only the Tier-1 alert fires', () => {
      const t1 = mockService({ id: 'claude', name: 'Claude API', status: 'down' })
      const nonT1 = mockService({ id: 'assemblyai', name: 'AssemblyAI', status: 'down' })
      const alerts = buildServiceAlerts([t1, nonT1], new Map(), new Map())
      expect(alerts).toHaveLength(1)
      expect(alerts[0].key).toBe('alerted:down:claude')
    })
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
        inc({ id: 'inc1', title: 'FLUX.1 Krea [dev] — down', status: 'investigating', startedAt: recentDate, impact: 'major' }),
        inc({ id: 'inc2', title: 'ZAI GLM 5 FP4 — down', status: 'investigating', startedAt: recentDate, impact: 'major' }),
        inc({ id: 'inc3', title: 'Kokoro-82M — down', status: 'investigating', startedAt: recentDate, impact: 'major' }),
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
        inc({ id: 'inc1', title: 'FLUX.1 Krea [dev]', status: 'resolved', startedAt: recentDate, duration: '13m', impact: 'major' }),
        inc({ id: 'inc2', title: 'ZAI GLM 5 FP4', status: 'resolved', startedAt: recentDate, duration: '15m', impact: 'major' }),
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

describe('mergeXaiRegionalAlerts (#686)', () => {
  const xaiNew = (incId: string, region: string, event: string): AlertCandidate => ({
    key: `alerted:new:${incId}`,
    title: '🔴 xAI API — New Incident',
    description: `[API (${region}.api.x.ai)] ${event}`,
    fallbackText: '👉 Suggested fallback: OpenAI',
    color: 0xed4245,
    url: 'https://ai-watch.dev/#xai',
    svcIds: ['xai'],
  })
  const xaiRes = (incId: string, region: string, event: string): AlertCandidate => ({
    key: `alerted:res:${incId}`,
    title: '🟢 xAI API — Incident Resolved (30m)',
    description: `[API (${region}.api.x.ai)] ${event}`,
    color: 0x57f287,
    url: 'https://ai-watch.dev/#xai',
    svcIds: ['xai'],
  })

  it('merges the SAME event across two regions into one alert listing both regions', () => {
    const result = mergeXaiRegionalAlerts([
      xaiNew('us1', 'us-east-1', 'Increased Error rate on Image Generation Endpoint'),
      xaiNew('eu1', 'eu-west-1', 'Increased Error rate on Image Generation Endpoint'),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('🔴 xAI API — New Incident (us-east-1, eu-west-1)')
    expect(result[0].description).toContain('us-east-1.api.x.ai') // each region's original title preserved
    expect(result[0].description).toContain('eu-west-1.api.x.ai')
    expect(result[0]._mergedKeys).toEqual(['alerted:new:us1', 'alerted:new:eu1'])
    expect(result[0].svcIds).toEqual(['xai'])
    expect(result[0].fallbackText).toContain('Suggested fallback')
  })

  it('does NOT merge two DISTINCT events (each in two regions → two merged alerts)', () => {
    const result = mergeXaiRegionalAlerts([
      xaiNew('a1', 'us-east-1', 'Increased Error rate on Image Generation Endpoint'),
      xaiNew('a2', 'eu-west-1', 'Increased Error rate on Image Generation Endpoint'),
      xaiNew('b1', 'us-east-1', 'Increased Failure Rate of Image Generation and Editing'),
      xaiNew('b2', 'eu-west-1', 'Increased Failure Rate of Image Generation and Editing'),
    ])
    expect(result).toHaveLength(2)
    expect(result.every((a) => a._mergedKeys?.length === 2)).toBe(true)
    expect(result.some((a) => a.description.includes('Image Generation Endpoint'))).toBe(true)
    expect(result.some((a) => a.description.includes('Failure Rate'))).toBe(true)
  })

  it('merges resolved per-region alerts (duration dropped, regions listed)', () => {
    const result = mergeXaiRegionalAlerts([
      xaiRes('us1', 'us-east-1', 'Increased Error rate on Image Generation Endpoint'),
      xaiRes('eu1', 'eu-west-1', 'Increased Error rate on Image Generation Endpoint'),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('🟢 xAI API — Incident Resolved (us-east-1, eu-west-1)')
    expect(result[0]._mergedKeys).toEqual(['alerted:res:us1', 'alerted:res:eu1'])
  })

  it('passes a single xAI alert through unchanged (no _mergedKeys)', () => {
    const result = mergeXaiRegionalAlerts([xaiNew('us1', 'us-east-1', 'Some event')])
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('🔴 xAI API — New Incident')
    expect(result[0]._mergedKeys).toBeUndefined()
  })

  it('does not merge a non-region-tagged xAI alert with region-tagged ones', () => {
    const untagged: AlertCandidate = {
      key: 'alerted:new:c',
      title: '🔴 xAI API — New Incident',
      description: 'Whole-service degradation',
      color: 0xed4245,
      url: 'https://ai-watch.dev/#xai',
      svcIds: ['xai'],
    }
    const result = mergeXaiRegionalAlerts([
      xaiNew('us1', 'us-east-1', 'Event A'),
      xaiNew('eu1', 'eu-west-1', 'Event A'),
      untagged,
    ])
    expect(result).toHaveLength(2) // the 2 region-tagged merge; the untagged stays separate
    expect(result.find((a) => a.description === 'Whole-service degradation')).toBeDefined()
    expect(result.find((a) => a._mergedKeys)?._mergedKeys).toEqual(['alerted:new:us1', 'alerted:new:eu1'])
  })

  it('leaves non-xAI alerts untouched', () => {
    const result = mergeXaiRegionalAlerts([
      { key: 'alerted:new:o', title: '🔴 OpenAI API — New Incident', description: 'x', color: 0xed4245, url: '' },
      xaiNew('us1', 'us-east-1', 'E'),
      xaiNew('eu1', 'eu-west-1', 'E'),
    ])
    expect(result).toHaveLength(2)
    expect(result.find((a) => a.title.includes('OpenAI'))).toBeDefined()
  })

  it('returns the original array when ≤1 xAI alert present', () => {
    const alerts: AlertCandidate[] = [
      { key: 'alerted:new:o', title: '🔴 OpenAI API — New Incident', description: 'x', color: 0xed4245, url: '' },
    ]
    expect(mergeXaiRegionalAlerts(alerts)).toBe(alerts)
  })

  it('handles a mixed new + resolved batch (both collapse paths fire in one call)', () => {
    const result = mergeXaiRegionalAlerts([
      xaiNew('n1', 'us-east-1', 'Image gen errors'),
      xaiNew('n2', 'eu-west-1', 'Image gen errors'),
      xaiRes('r1', 'us-east-1', 'Latency spike'),
      xaiRes('r2', 'eu-west-1', 'Latency spike'),
    ])
    expect(result).toHaveLength(2)
    const newAlert = result.find((a) => a.title.startsWith('🔴'))!
    const resAlert = result.find((a) => a.title.startsWith('🟢'))!
    expect(newAlert._mergedKeys).toEqual(['alerted:new:n1', 'alerted:new:n2'])
    expect(resAlert._mergedKeys).toEqual(['alerted:res:r1', 'alerted:res:r2'])
  })

  it('integration: collapses two region alerts from buildIncidentAlerts into one', () => {
    const xai = mockService({
      id: 'xai',
      name: 'xAI API',
      status: 'degraded',
      category: 'api',
      incidents: [
        inc({ id: 'us1', title: '[API (us-east-1.api.x.ai)] Increased Error rate on Image Generation Endpoint', status: 'investigating', startedAt: recentDate, impact: 'minor' }),
        inc({ id: 'eu1', title: '[API (eu-west-1.api.x.ai)] Increased Error rate on Image Generation Endpoint', status: 'investigating', startedAt: recentDate, impact: 'minor' }),
      ],
    })
    const alerts = buildIncidentAlerts([xai], alertedMap(), NOW)
    expect(alerts).toHaveLength(2)
    const merged = mergeXaiRegionalAlerts(alerts)
    expect(merged).toHaveLength(1)
    expect(merged[0].title).toBe('🔴 xAI API — New Incident (us-east-1, eu-west-1)')
    expect(merged[0]._mergedKeys).toEqual(['alerted:new:us1', 'alerted:new:eu1'])
    expect(merged[0].svcIds).toEqual(['xai'])
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
      expect(isFlapSuppressible('fireworks', config, mkInc(), NOW)).toBe(true)
    })

    it('returns false for opted-out services (flag absent or false)', () => {
      expect(isFlapSuppressible('fireworks', {}, mkInc(), NOW)).toBe(false)
      expect(isFlapSuppressible('fireworks', { flapSuppression: false }, mkInc(), NOW)).toBe(false)
    })

    it('returns false for `major` impact (real outages never suppressed) but true for `minor` flaps (#565)', () => {
      expect(isFlapSuppressible('fireworks', config, mkInc({ impact: 'major' }), NOW)).toBe(false)
      // #564/#565 maps BetterStack "— down" flaps to `minor` — these MUST stay suppressible.
      expect(isFlapSuppressible('fireworks', config, mkInc({ impact: 'minor', title: 'X — down' }), NOW)).toBe(true)
    })

    it('returns false for titles without the " — recovered" suffix', () => {
      expect(isFlapSuppressible('fireworks', config, mkInc({ title: 'API Outage' }), NOW)).toBe(false)
    })

    it('Tier-1 guard: never suppresses claude / openai / gemini even if flag set', () => {
      // Defense-in-depth: a configuration mistake enabling flapSuppression on a Tier-1
      // service would silently swallow real outage alerts. Hard-coded exclusion.
      expect(isFlapSuppressible('claude', config, mkInc(), NOW)).toBe(false)
      expect(isFlapSuppressible('openai', config, mkInc(), NOW)).toBe(false)
      expect(isFlapSuppressible('gemini', config, mkInc(), NOW)).toBe(false)
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
          inc({ id: 'flap2-down', title: 'X — down', status: 'investigating', impact: null, startedAt: recentDate }),
          // Resolved half of the same flap (would normally fire alerted:res if alertedNewIds had it)
          inc({ id: 'flap2-res', title: 'X — recovered', status: 'resolved', impact: null, startedAt: recentDate, duration: '5m' }),
        ],
      })
      const suppressed = new Set(['flap2-down', 'flap2-res'])
      const alerts = buildIncidentAlerts([svc], alertedMap({ 'flap2-res': ['fireworks'] }), NOW, suppressed)
      expect(alerts).toHaveLength(0)
    })

    it('does not affect non-suppressed incidents on the same service', () => {
      const svc = mockService({
        incidents: [
          inc({ id: 'suppressed', title: 'X — down', status: 'investigating', impact: null, startedAt: recentDate }),
          inc({ id: 'real', title: 'Actual Outage', status: 'investigating', impact: 'major', startedAt: recentDate }),
        ],
      })
      const alerts = buildIncidentAlerts([svc], alertedMap(), NOW, new Set(['suppressed']))
      expect(alerts).toHaveLength(1)
      expect(alerts[0].key).toBe('alerted:new:real')
    })
  })
})

describe('first-seen confirmation gate (#633)', () => {
  const mkInc = (overrides: Partial<Incident> = {}): Incident => inc({
    id: 'inc1',
    title: 'Web endpoints — down',
    status: 'investigating',
    impact: null,
    startedAt: new Date(NOW - 60_000).toISOString(),
    timeline: [],
    ...overrides,
  })
  const config = { flapSuppression: true }
  const NOW = 1_700_000_000_000
  // first sight = no pending marker yet
  const firstSight = { alreadyAlerted: false, firstSeenMs: null, nowMs: NOW }

  describe('pendingNewKey + TTL', () => {
    it('scopes the marker to the incident id', () => {
      expect(pendingNewKey('flashduty:abc123')).toBe('pending:new:flashduty:abc123')
    })
    it('TTL comfortably outlasts the ~2-cycle hold window (#835, write-once marker)', () => {
      expect(PENDING_NEW_TTL_S).toBe(1800)
      expect(PENDING_NEW_TTL_S * 1000).toBeGreaterThan(FLAP_HOLD_MS * 2)
    })
  })

  describe('shouldHoldNewIncident (#835 — ~2-cycle duration hold)', () => {
    it('HOLDS a flap-shaped new incident on its first sight (monitor-flap service)', () => {
      expect(shouldHoldNewIncident('modal', config, mkInc(), firstSight)).toBe(true)
    })

    it('HOLDS the real `minor`-impact phantom shape (Modal "Web endpoints — down", #633/#565)', () => {
      const inc = mkInc({ status: 'investigating', impact: 'minor', title: 'Web endpoints — down' })
      expect(shouldHoldNewIncident('modal', config, inc, firstSight)).toBe(true)
    })

    it('STILL HOLDS within the window — surviving ONE cycle is no longer enough (#835)', () => {
      // first-seen ~5min ago (one */5 cycle) → still inside the ~9min window → keep holding.
      const oneCycleAgo = { alreadyAlerted: false, firstSeenMs: NOW - 5 * 60 * 1000, nowMs: NOW }
      expect(shouldHoldNewIncident('modal', config, mkInc(), oneCycleAgo)).toBe(true)
    })

    it('FIRES once first-seen ≥ FLAP_HOLD_MS (survived ~2 cycles)', () => {
      const twoCyclesAgo = { alreadyAlerted: false, firstSeenMs: NOW - (FLAP_HOLD_MS + 1000), nowMs: NOW }
      expect(shouldHoldNewIncident('modal', config, mkInc(), twoCyclesAgo)).toBe(false)
    })

    it('a KV read error (firstSeenMs=0) does NOT hold — fail-not-hold, a real alert beats a phantom', () => {
      expect(shouldHoldNewIncident('modal', config, mkInc(), { alreadyAlerted: false, firstSeenMs: 0, nowMs: NOW })).toBe(false)
    })

    it('never re-holds an already-alerted incident (a later cron re-fire)', () => {
      expect(shouldHoldNewIncident('modal', config, mkInc(), { alreadyAlerted: true, firstSeenMs: null, nowMs: NOW })).toBe(false)
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
        incidents: [inc({ id: 'flap-blip', title: 'Web endpoints — recovered', status: 'resolved', impact: null, startedAt: recentDate, duration: '3m' })],
      })
      const alerts = buildIncidentAlerts([recovered], alertedMap(), NOW, new Set(['flap-blip']))
      expect(alerts).toHaveLength(0)
    })

    it('~2-cycle hold→confirm: composes shouldHoldNewIncident → suppressedIncIds → buildIncidentAlerts like index.ts (#835)', () => {
      // Drives the SAME two real functions the cron wires together, simulating the pending:new marker
      // transition (firstSeen stamped on cycle 1, then time advancing across */5 cycles). Proves the
      // cross-cycle contract: a flap must survive ~2 cycles, not one, before it fires.
      const inc: Incident = { id: 'flap-x', title: 'Web endpoints — down', status: 'investigating', impact: null, startedAt: recentDate, duration: null, timeline: [] }
      const svc = mockService({ id: 'modal', status: 'down', incidents: [inc] })
      const config = { flapSuppression: true }
      const t0 = 1_700_000_000_000

      // Cycle 1 (first sight, no marker) → held + stamp firstSeen=t0.
      let firstSeenMs: number | null = null
      const s1 = new Set<string>()
      if (shouldHoldNewIncident('modal', config, inc, { alreadyAlerted: false, firstSeenMs, nowMs: t0 })) { s1.add(inc.id); if (firstSeenMs === null) firstSeenMs = t0 }
      expect(s1.has('flap-x')).toBe(true)
      expect(buildIncidentAlerts([svc], alertedMap(), t0, s1)).toHaveLength(0) // silent

      // Cycle 2 (~5min later, marker=t0) → still inside the ~9min window → STILL held (the #835 change).
      const s2 = new Set<string>()
      if (shouldHoldNewIncident('modal', config, inc, { alreadyAlerted: false, firstSeenMs, nowMs: t0 + 5 * 60 * 1000 })) s2.add(inc.id)
      expect(s2.has('flap-x')).toBe(true)
      expect(buildIncidentAlerts([svc], alertedMap(), t0 + 5 * 60 * 1000, s2)).toHaveLength(0) // still silent

      // Cycle 3 (~10min later) → age ≥ FLAP_HOLD_MS → NOT held → fires.
      const s3 = new Set<string>()
      if (shouldHoldNewIncident('modal', config, inc, { alreadyAlerted: false, firstSeenMs, nowMs: t0 + 10 * 60 * 1000 })) s3.add(inc.id)
      expect(s3.size).toBe(0)
      expect(buildIncidentAlerts([svc], alertedMap(), t0 + 10 * 60 * 1000, s3).map(a => a.key)).toEqual(['alerted:new:flap-x'])
    })

    it('incId stability: a churned id is treated as a fresh first-sight (re-held) — documents the gate dependency', () => {
      // The gate keys on pendingNewKey(inc.id); if the feed re-issues a NEW id for the same flap
      // between cycles, the cycle-2 pending lookup misses and the incident is held again. BetterStack
      // RSS ids are stable guids (parsers/betterstack.ts), so this degenerate case shouldn't occur —
      // this test pins the assumption so a future unstable-id source is caught by intent.
      const config = { flapSuppression: true }
      const churnedInc: Incident = { id: 'flap-y', title: 'Web endpoints — down', status: 'investigating', impact: null, startedAt: recentDate, duration: null, timeline: [] }
      // pending:new was written for 'flap-x' on cycle 1; cycle 2 surfaces 'flap-y' → its marker is absent (firstSeenMs null → fresh hold).
      expect(shouldHoldNewIncident('modal', config, churnedInc, { alreadyAlerted: false, firstSeenMs: null, nowMs: NOW })).toBe(true)
    })
  })
})

describe('short-incident hold (#792)', () => {
  // Langfuse-class: a normal-titled, short, `minor` incident that backdates its resolution, so the
  // */5 cron first catches it as it's already resolving → New+Resolved Discord double-alert while the
  // live dashboard never reflected it. Unlike #633's flap gate, this holds ANY non-major new incident
  // (no " — down/recovered" title required) on a `holdShortIncidents` service, one cron cycle.
  const mkInc = (overrides: Partial<Incident> = {}): Incident => inc({
    id: 'lf-inc1',
    title: '[EU] Elevated ingestion times',
    status: 'investigating',
    impact: 'minor',
    startedAt: new Date(NOW - 60_000).toISOString(),
    timeline: [],
    ...overrides,
  })
  const config = { holdShortIncidents: true }
  const firstSight = { alreadyAlerted: false, firstSeenMs: null, nowMs: NOW }
  const confirmed = { alreadyAlerted: false, firstSeenMs: NOW - (FLAP_HOLD_MS + 1000), nowMs: NOW }  // survived ~2 cycles

  describe('isShortIncidentHoldable', () => {
    it('holds a NORMAL-titled minor incident on an opted-in service (no flap title needed)', () => {
      expect(isShortIncidentHoldable('langfuse', config, mkInc())).toBe(true)
    })

    it('holds null-impact too — any non-major qualifies', () => {
      expect(isShortIncidentHoldable('langfuse', config, mkInc({ impact: null }))).toBe(true)
    })

    it('does NOT hold `major` impact — a real broad outage alerts immediately', () => {
      expect(isShortIncidentHoldable('langfuse', config, mkInc({ impact: 'major' }))).toBe(false)
    })

    it('does NOT hold `critical` impact either — no title guard here, so both severe levels bypass', () => {
      // Langfuse's statuspage feed maps Atlassian `critical` → 'critical' (parsers/statuspage.ts), and
      // this path (unlike isFlapNotice) has no "— down/recovered" title screen, so `critical` must be
      // excluded explicitly or the most-severe incident would be delayed a cycle.
      expect(isShortIncidentHoldable('langfuse', config, mkInc({ impact: 'critical' }))).toBe(false)
    })

    it('does NOT hold services without the flag (no regression for everyone else)', () => {
      expect(isShortIncidentHoldable('langfuse', {}, mkInc())).toBe(false)
      expect(isShortIncidentHoldable('langfuse', { holdShortIncidents: false }, mkInc())).toBe(false)
    })

    it('Tier-1 guard: never holds claude / openai / gemini even with the flag', () => {
      expect(isShortIncidentHoldable('claude', config, mkInc())).toBe(false)
      expect(isShortIncidentHoldable('openai', config, mkInc())).toBe(false)
      expect(isShortIncidentHoldable('gemini', config, mkInc())).toBe(false)
    })
  })

  describe('shouldHoldNewIncident — broadened gate', () => {
    it('HOLDS a normal-titled minor incident on its first sight (the Langfuse double-alert fix)', () => {
      expect(shouldHoldNewIncident('langfuse', config, mkInc(), firstSight)).toBe(true)
    })

    it('FIRES once the incident survived ~2 cycles (first-seen ≥ FLAP_HOLD_MS → genuinely ongoing)', () => {
      expect(shouldHoldNewIncident('langfuse', config, mkInc(), confirmed)).toBe(false)
    })

    it('does NOT hold `major` — alerts immediately even on a hold service', () => {
      expect(shouldHoldNewIncident('langfuse', config, mkInc({ impact: 'major' }), firstSight)).toBe(false)
    })

    it('does NOT hold resolved incidents (resolved path gated by alertedNewMap)', () => {
      expect(shouldHoldNewIncident('langfuse', config, mkInc({ status: 'resolved' }), firstSight)).toBe(false)
    })

    it('never re-holds an already-alerted incident', () => {
      expect(shouldHoldNewIncident('langfuse', config, mkInc(), { alreadyAlerted: true, firstSeenMs: null, nowMs: NOW })).toBe(false)
    })

    it('does NOT hold a service carrying neither flap nor short-incident flag', () => {
      expect(shouldHoldNewIncident('langfuse', {}, mkInc(), firstSight)).toBe(false)
    })

    it('does NOT widen the net for flapSuppression-ONLY services — a normal-titled minor stays immediate', () => {
      // Regression guard: the OR with isFlapSuppressible must NOT make existing flap services
      // (together/huggingface/modal/luma; fireworks left this group in #1198) start holding
      // ordinary, normal-titled minor incidents. Only the "— down/recovered" flap shape is held
      // for them; a real incident fires now.
      const flapOnly = { flapSuppression: true }
      expect(shouldHoldNewIncident('modal', flapOnly, mkInc({ title: '[EU] Elevated ingestion times', impact: 'minor' }), firstSight)).toBe(false)
    })

    it('Tier-1 guard at the composed level: never holds claude / openai / gemini even with the flag', () => {
      expect(shouldHoldNewIncident('claude', config, mkInc(), firstSight)).toBe(false)
      expect(shouldHoldNewIncident('openai', config, mkInc(), firstSight)).toBe(false)
      expect(shouldHoldNewIncident('gemini', config, mkInc(), firstSight)).toBe(false)
    })
  })

  describe('held short incident produces no phantom pair (buildIncidentAlerts integration)', () => {
    it('a held Langfuse blip that self-resolves inside the window emits neither new nor recovered', () => {
      // Cycle 1: held (suppressedIncIds), no alerted:new written. Cycle 2: status resolved but never
      // in alertedNewMap → buildIncidentAlerts emits NO recovered (alertedNewMap.has guard). Net: silent.
      const recovered = mockService({
        id: 'langfuse',
        status: 'operational',
        incidents: [inc({ id: 'lf-blip', title: '[EU] Elevated ingestion times', status: 'resolved', impact: 'minor', startedAt: recentDate, duration: '19m' })],
      })
      const alerts = buildIncidentAlerts([recovered], alertedMap(), NOW, new Set(['lf-blip']))
      expect(alerts).toHaveLength(0)
    })

    it('~2-cycle hold→confirm: a genuinely ongoing Langfuse incident alerts once it survives the window (#835)', () => {
      const ongoing: Incident = { id: 'lf-real', title: '[EU] Elevated ingestion times', status: 'investigating', impact: 'minor', startedAt: recentDate, duration: null, timeline: [] }
      const svc = mockService({ id: 'langfuse', status: 'degraded', incidents: [ongoing] })
      const t0 = 1_700_000_000_000

      // Cycle 1: first sight → held + stamp firstSeen=t0 → silent.
      let firstSeenMs: number | null = null
      const s1 = new Set<string>()
      if (shouldHoldNewIncident('langfuse', config, ongoing, { alreadyAlerted: false, firstSeenMs, nowMs: t0 })) { s1.add(ongoing.id); if (firstSeenMs === null) firstSeenMs = t0 }
      expect(s1.has('lf-real')).toBe(true)
      expect(buildIncidentAlerts([svc], alertedMap(), t0, s1)).toHaveLength(0)

      // Cycle 2 (~5min): still inside window → still held → silent.
      const s2 = new Set<string>()
      if (shouldHoldNewIncident('langfuse', config, ongoing, { alreadyAlerted: false, firstSeenMs, nowMs: t0 + 5 * 60 * 1000 })) s2.add(ongoing.id)
      expect(buildIncidentAlerts([svc], alertedMap(), t0 + 5 * 60 * 1000, s2)).toHaveLength(0)

      // Cycle 3 (~10min): age ≥ FLAP_HOLD_MS → NOT held → fires.
      const s3 = new Set<string>()
      if (shouldHoldNewIncident('langfuse', config, ongoing, { alreadyAlerted: false, firstSeenMs, nowMs: t0 + 10 * 60 * 1000 })) s3.add(ongoing.id)
      expect(buildIncidentAlerts([svc], alertedMap(), t0 + 10 * 60 * 1000, s3).map(a => a.key)).toEqual(['alerted:new:lf-real'])
    })
  })

  describe('Mistral opt-in (#929)', () => {
    // status.mistral.ai (Instatus, Nuxt) auto-posts frequent short "○○ API Degraded" MEDIUM (→ minor)
    // flaps that self-resolve in seconds/minutes and get pruned, so each fired a phantom "New Incident"
    // alert (the 2026-07-03 AI Registry Prompts/Skills case). Mistral now opts into the #792 hold.
    const mistralFlap = (overrides: Partial<Incident> = {}): Incident => inc({
      id: 'mistral-reg-1',
      title: 'AI Registry Prompts API Degraded',
      status: 'investigating',
      impact: 'minor', // Nuxt severity MEDIUM → mapInstatusImpact → 'minor'
      startedAt: new Date(NOW - 60_000).toISOString(),
      timeline: [],
      ...overrides,
    })

    it('the real SERVICES config opts Mistral into holdShortIncidents', () => {
      const s = SERVICES.find((x) => x.id === 'mistral')
      expect(s, 'mistral missing from SERVICES').toBeDefined()
      expect(s!.holdShortIncidents, 'mistral must opt into the #792/#929 short-incident hold').toBe(true)
    })

    it('holds a Registry-shaped minor flap on first sight, using the real config', () => {
      const cfg = SERVICES.find((x) => x.id === 'mistral')!
      expect(shouldHoldNewIncident('mistral', cfg, mistralFlap(), firstSight)).toBe(true)
    })

    it('fires once the flap survives ~2 cycles (a genuine longer incident, e.g. the 120h Fine Tuning)', () => {
      const cfg = SERVICES.find((x) => x.id === 'mistral')!
      expect(shouldHoldNewIncident('mistral', cfg, mistralFlap(), confirmed)).toBe(false)
    })

    it('does NOT hold a `major` Mistral incident — a real broad outage alerts immediately', () => {
      const cfg = SERVICES.find((x) => x.id === 'mistral')!
      expect(shouldHoldNewIncident('mistral', cfg, mistralFlap({ impact: 'major' }), firstSight)).toBe(false)
    })
  })

  describe('Fireworks incident.io migration (#1198)', () => {
    // #1198 — Fireworks moved off BetterStack (whose "<model> — down/recovered" title shape
    // flapSuppression's isFlapNotice matched) onto incident.io, whose real titles carry no such
    // suffix ("Service Degradation for one of our models on Serverless", confirmed live 2026-08-02). Without
    // this coverage, flapSuppression would be silently inert for fireworks and every per-model blip
    // (observed live 2026-08-02: 18 incidents/7d, 8-41min each) would fire an unheld Discord New+Resolved pair —
    // exactly the phantom-alert failure #633/#835/#792 exist to prevent. fireworks now opts into
    // holdShortIncidents instead (the mistral/langfuse mechanism), which holds on `impact` alone.
    const fireworksBlip = (overrides: Partial<Incident> = {}): Incident => inc({
      id: 'fireworks-blip-1',
      title: 'Service Degradation for one of our models on Serverless',
      status: 'investigating',
      impact: 'minor', // real incident.io impact, not BetterStack's hardcoded null
      startedAt: new Date(NOW - 60_000).toISOString(),
      timeline: [],
      ...overrides,
    })

    it('the real SERVICES config opts fireworks into holdShortIncidents, NOT flapSuppression', () => {
      const s = SERVICES.find((x) => x.id === 'fireworks')
      expect(s, 'fireworks missing from SERVICES').toBeDefined()
      expect(s!.holdShortIncidents, 'fireworks must opt into the #792/#1198 short-incident hold').toBe(true)
      expect(s!.flapSuppression, 'flapSuppression would be inert — incident.io titles have no "— down/recovered" suffix').toBeFalsy()
    })

    it('a real incident.io title does not match isFlapNotice\'s "— down/recovered" regex (proving flapSuppression would have been inert)', () => {
      // Direct proof of the title-shape claim: isFlapSuppressible short-circuits on `!config.flapSuppression`
      // before ever reaching isFlapNotice, so testing it against the REAL (flapSuppression-less) fireworks
      // config would pass for the wrong reason regardless of title shape. Prove the title claim in isolation
      // (and via a throwaway flapSuppression:true config below) instead of relying on that config gap.
      expect(isFlapNotice(fireworksBlip())).toBe(false)
      expect(isFlapSuppressible('fireworks', { flapSuppression: true }, fireworksBlip(), NOW)).toBe(false)
    })

    it('a real incident.io-titled blip is NOT flap-suppressible (real config has no flapSuppression) but IS short-incident-holdable', () => {
      const cfg = SERVICES.find((x) => x.id === 'fireworks')!
      expect(isFlapSuppressible('fireworks', cfg, fireworksBlip(), NOW)).toBe(false)
      expect(isShortIncidentHoldable('fireworks', cfg, fireworksBlip())).toBe(true)
    })

    it('holds a real-shaped Fireworks blip on first sight, using the real config', () => {
      const cfg = SERVICES.find((x) => x.id === 'fireworks')!
      expect(shouldHoldNewIncident('fireworks', cfg, fireworksBlip(), firstSight)).toBe(true)
    })

    it('fires once the blip survives ~2 cycles (a genuine longer incident)', () => {
      const cfg = SERVICES.find((x) => x.id === 'fireworks')!
      expect(shouldHoldNewIncident('fireworks', cfg, fireworksBlip(), confirmed)).toBe(false)
    })

    it('does NOT hold a `major` Fireworks incident — a real broad outage alerts immediately', () => {
      const cfg = SERVICES.find((x) => x.id === 'fireworks')!
      expect(shouldHoldNewIncident('fireworks', cfg, fireworksBlip({ impact: 'major' }), firstSight)).toBe(false)
    })
  })
})

describe('shouldHoldForAiAnalysis (#882 — Discord AI-hold on the push path)', () => {
  const NOW = 1_700_000_000_000
  // Base: an out-of-NEVER_AI_HELD service (mistral), AI not ready, not skipped, first sight.
  const base = { svcId: 'mistral', aiReady: false, analysisSkipped: false, firstSeenMs: null as number | null, nowMs: NOW }

  it('HOLDS a hold-eligible new incident on first sight when AI is not ready', () => {
    expect(shouldHoldForAiAnalysis({ ...base })).toBe(true)
  })

  it('HOLDS while still inside the window (one */5 cycle after first-seen)', () => {
    expect(shouldHoldForAiAnalysis({ ...base, firstSeenMs: NOW - 5 * 60 * 1000 })).toBe(true)
  })

  it('RELEASES (fail-open) once first-seen ≥ AI_HOLD_MS — sends AI-less rather than lose the alert', () => {
    expect(shouldHoldForAiAnalysis({ ...base, firstSeenMs: NOW - (AI_HOLD_MS + 1000) })).toBe(false)
  })

  it('RELEASES exactly at the AI_HOLD_MS boundary (strict `<` window is exclusive)', () => {
    expect(shouldHoldForAiAnalysis({ ...base, firstSeenMs: NOW - AI_HOLD_MS })).toBe(false)
  })

  it('RELEASES the moment AI is ready (KV backfilled or inline succeeded)', () => {
    expect(shouldHoldForAiAnalysis({ ...base, aiReady: true })).toBe(false)
  })

  it('NEVER holds when analysis was skipped (merged / no-model / generic) — AI will never come', () => {
    expect(shouldHoldForAiAnalysis({ ...base, analysisSkipped: true })).toBe(false)
  })

  it('NEVER holds a NEVER_AI_HELD service — the alert ships at cron cadence', () => {
    for (const svcId of NEVER_AI_HELD) {
      expect(shouldHoldForAiAnalysis({ ...base, svcId }), svcId).toBe(false)
    }
  })

  // #1148 — the regression: chatgpt/claudeai are phone-push-worthy (#778) yet were held up to
  // AI_HOLD_MS because the gate read TIER1_IDS. The live 2026-07-23 ChatGPT event lagged the
  // provider's post by ~17min, far more than the ≤5min cron floor accounts for.
  it('NEVER holds the consumer apps (chatgpt / claudeai) — push-urgency and alert-urgency agree', () => {
    expect(shouldHoldForAiAnalysis({ ...base, svcId: 'chatgpt' })).toBe(false)
    expect(shouldHoldForAiAnalysis({ ...base, svcId: 'claudeai' })).toBe(false)
  })

  // Since #1148 the exemption lives in its own set, so two containments carry the promises made
  // elsewhere: Tier-1 is still never held (#767/#778), and holding a push-scope alert would delay
  // the phone push (the cron `continue`s before both). The second is by construction (the spread);
  // this pins it against a refactor that inlines the list, and pins the first outright.
  it('keeps TIER1_IDS ⊆ PUSH_SCOPE ⊆ NEVER_AI_HELD — neither promise can drift', () => {
    for (const id of TIER1_IDS) expect(PUSH_SCOPE.has(id), `TIER1 ${id}`).toBe(true)
    for (const id of PUSH_SCOPE) expect(NEVER_AI_HELD.has(id), `PUSH ${id}`).toBe(true)
  })

  // #1148 — the coding agents.
  it('NEVER holds the four coding agents (claudecode / codex / cursor / copilot)', () => {
    for (const svcId of ['claudecode', 'codex', 'cursor', 'copilot']) {
      expect(shouldHoldForAiAnalysis({ ...base, svcId }), svcId).toBe(false)
    }
  })

  // windsurf/junie are agents too and are deliberately NOT exempt — the set is a judgement call, so
  // its boundary is pinned rather than left to drift into "every agent".
  it('still HOLDS outside the set (windsurf / junie / mistral) — narrowed, not removed', () => {
    for (const svcId of ['windsurf', 'junie', 'mistral']) {
      expect(shouldHoldForAiAnalysis({ ...base, svcId }), svcId).toBe(true)
    }
  })

  it('a KV read error (firstSeenMs=0) does NOT hold — fail-open, mirrors shouldHoldNewIncident', () => {
    expect(shouldHoldForAiAnalysis({ ...base, firstSeenMs: 0 })).toBe(false)
  })

  it('the fail-open window is ~2 */5 cron cycles (one retry before shipping AI-less)', () => {
    expect(AI_HOLD_MS).toBe(10 * 60 * 1000)
    expect(AI_HOLD_MS).toBeGreaterThan(5 * 60 * 1000) // survives at least one full cron cycle
  })
})

describe('pendingAiKey (#882)', () => {
  it('scopes the AI-hold marker to the incident id, distinct from pending:new', () => {
    expect(pendingAiKey('mistral-ocr-123')).toBe('pending:ai:mistral-ocr-123')
    expect(pendingAiKey('x')).not.toBe(pendingNewKey('x'))
  })
})

// #983 — Twelve Labs' Statuspage auto-monitor opens a brand-new incident per component blip under one
// fixed title, and Statuspage stamps `impact: 'major'` whenever the affected sub-component reads
// `major_outage`. The four incidents below are the REAL 2026-07-09 (PDT) burst. Before the fix, none
// of them was hold-eligible (no flag on the service; and `holdShortIncidents` would still have bailed
// on the three `major` ones) → 4 New + 4 Resolved operator alerts for a 6–16m machine-emitted blip.
describe('auto-monitor tagged incidents (#983)', () => {
  const AM_NOW = 1_752_100_000_000
  const mkAm = (overrides: Partial<Incident> = {}): Incident => inc({
    id: 'tl-1',
    title: 'Some API features are experiencing issues',
    status: 'investigating',
    impact: 'major',
    startedAt: new Date(AM_NOW - 60_000).toISOString(),
    autoMonitor: true,
    ...overrides,
  })

  describe('isShortIncidentHoldable', () => {
    it('holds a `major` autoMonitor incident — impact is component-derived, not editorial', () => {
      expect(isShortIncidentHoldable('twelvelabs', {}, mkAm())).toBe(true)
    })

    it('holds without needing holdShortIncidents — the tag is its own opt-in', () => {
      expect(isShortIncidentHoldable('twelvelabs', { holdShortIncidents: false }, mkAm())).toBe(true)
    })

    it('holds the `minor` member of the same burst', () => {
      expect(isShortIncidentHoldable('twelvelabs', {}, mkAm({ impact: 'minor' }))).toBe(true)
    })

    it('never holds `critical` even when tagged — the escape hatch for a genuine broad outage', () => {
      expect(isShortIncidentHoldable('twelvelabs', {}, mkAm({ impact: 'critical' }))).toBe(false)
    })

    it('never holds Tier-1 even when tagged', () => {
      expect(isShortIncidentHoldable('claude', {}, mkAm())).toBe(false)
    })

    it('leaves an untagged `major` incident alone (no regression for everyone else)', () => {
      expect(isShortIncidentHoldable('langfuse', { holdShortIncidents: true }, mkAm({ autoMonitor: undefined }))).toBe(false)
    })
  })

  describe('isFlapNotice / isFlapSuppressible', () => {
    const config = { flapSuppression: true }

    it('treats a tagged `major` incident as a flap despite no "— down" suffix', () => {
      expect(isFlapNotice(mkAm())).toBe(true)
    })

    it('still refuses `critical`', () => {
      expect(isFlapNotice(mkAm({ impact: 'critical' }))).toBe(false)
    })

    it('untagged `major` with no flap suffix is still not a flap', () => {
      expect(isFlapNotice(mkAm({ autoMonitor: undefined }))).toBe(false)
    })

    it('preserves the BetterStack suffix path for untagged minor incidents', () => {
      expect(isFlapNotice(inc({ id: 'm', title: 'Web endpoints — down', status: 'investigating', impact: 'minor', startedAt: recentDate }))).toBe(true)
    })

    it('the critical-first reorder: an UNTAGGED `critical` "— down" incident is no longer a flap', () => {
      // Behavior change on the pre-existing BetterStack path. Unreachable today (mapBetterStackImpact
      // only emits minor/major), but pinned so a future parser that CAN emit `critical` can't have its
      // most severe incident silently swallowed by the 60-min window.
      expect(isFlapNotice(inc({ id: 'c', title: 'Web endpoints — down', status: 'investigating', impact: 'critical', startedAt: recentDate }))).toBe(false)
    })

    it('is suppressible on twelvelabs (flapSuppression is on) and keyed by the shared title', () => {
      expect(isFlapSuppressible('twelvelabs', config, mkAm(), AM_NOW)).toBe(true)
      // The whole burst shares one normalized title → one 60-min suppression window.
      expect(flapSuppressionKey('twelvelabs', mkAm({ id: 'tl-2' })))
        .toBe(flapSuppressionKey('twelvelabs', mkAm({ id: 'tl-3', impact: 'minor' })))
    })
  })

  // The exposure #983 introduced and this guard closes: enabling flapSuppression on a service whose
  // `major` incidents are suppressible means a REAL sustained outage reusing the machine title could
  // have had BOTH its New and Resolved dropped for up to an hour.
  describe('FLAP_SUPPRESSION_ESCAPE_MS — a long incident is never a flap', () => {
    const config = { flapSuppression: true }
    const longAgo = new Date(AM_NOW - (FLAP_SUPPRESSION_ESCAPE_MS + 60_000)).toISOString()

    it('an ONGOING tagged incident past the escape window alerts despite an active flap window', () => {
      expect(isFlapSuppressible('twelvelabs', config, mkAm({ startedAt: longAgo }), AM_NOW)).toBe(false)
    })

    it('its RESOLVED half escapes too — an escaped New must never lose its Resolved', () => {
      const resolved = mkAm({ status: 'resolved', startedAt: longAgo, resolvedAt: new Date(AM_NOW).toISOString() })
      expect(isFlapSuppressible('twelvelabs', config, resolved, AM_NOW)).toBe(false)
    })

    it('a short resolved blip is still suppressed (the burst members)', () => {
      const blip = mkAm({ status: 'resolved', startedAt: new Date(AM_NOW - 16 * 60_000).toISOString(), resolvedAt: new Date(AM_NOW).toISOString() })
      expect(isFlapSuppressible('twelvelabs', config, blip, AM_NOW)).toBe(true)
    })

    it('generalizes to the pre-existing BetterStack flap services', () => {
      const longFlap = inc({ id: 'mf', title: 'Web endpoints — down', status: 'investigating', impact: 'minor', startedAt: longAgo })
      expect(isFlapSuppressible('modal', config, longFlap, AM_NOW)).toBe(false)
      const shortFlap = inc({ id: 'mf2', title: 'Web endpoints — down', status: 'investigating', impact: 'minor', startedAt: new Date(AM_NOW - 60_000).toISOString() })
      expect(isFlapSuppressible('modal', config, shortFlap, AM_NOW)).toBe(true)
    })

    it('a backdated first sight on a flapSuppression-only service alerts immediately (modal/together/huggingface/luma)', () => {
      // These services have flapSuppression but NOT holdShortIncidents and carry no tag, so the flap
      // branch is their only path into the hold. Past the escape window it closes → no hold → alert.
      const backdated = inc({ id: 'mb', title: 'Web endpoints — down', status: 'investigating', impact: 'minor', startedAt: longAgo })
      expect(shouldHoldNewIncident('modal', config, backdated, { alreadyAlerted: false, firstSeenMs: null, nowMs: AM_NOW })).toBe(false)
      // ...while a fresh one on the same service is still held on first sight (unchanged behavior).
      const fresh = inc({ id: 'mf3', title: 'Web endpoints — down', status: 'investigating', impact: 'minor', startedAt: new Date(AM_NOW - 60_000).toISOString() })
      expect(shouldHoldNewIncident('modal', config, fresh, { alreadyAlerted: false, firstSeenMs: null, nowMs: AM_NOW })).toBe(true)
    })

    describe('incidentRunMs', () => {
      it('measures to resolvedAt when resolved, else to now', () => {
        expect(incidentRunMs(mkAm({ startedAt: new Date(AM_NOW - 5 * 60_000).toISOString() }), AM_NOW)).toBe(5 * 60_000)
        expect(incidentRunMs(mkAm({ startedAt: new Date(AM_NOW - 60 * 60_000).toISOString(), resolvedAt: new Date(AM_NOW - 50 * 60_000).toISOString() }), AM_NOW)).toBe(10 * 60_000)
      })

      it('FAILS OPEN on an unparseable startedAt — Infinity → escapes suppression → the alert ships', () => {
        // The direction matters: returning 0 here would pin a real outage below the escape threshold on
        // every cron cycle and mute it for the whole 60-min window, with no trail. Dropping a real
        // alert is worse than one phantom (#835 rule).
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        expect(incidentRunMs(mkAm({ startedAt: 'not-a-date' }), AM_NOW)).toBe(Number.POSITIVE_INFINITY)
        expect(isFlapSuppressible('twelvelabs', { flapSuppression: true }, mkAm({ startedAt: 'not-a-date' }), AM_NOW)).toBe(false)
        expect(warn).toHaveBeenCalled()
        warn.mockRestore()
      })

      it('an unparseable resolvedAt degrades to measuring against now, not to 0', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const started = new Date(AM_NOW - 45 * 60_000).toISOString()
        expect(incidentRunMs(mkAm({ startedAt: started, resolvedAt: 'garbage' }), AM_NOW)).toBe(45 * 60_000)
        expect(warn).toHaveBeenCalled()
        warn.mockRestore()
      })

      it('a future startedAt (clock skew) clamps to 0 and stays suppressible — self-corrects as now advances', () => {
        expect(incidentRunMs(mkAm({ startedAt: new Date(AM_NOW + 60_000).toISOString() }), AM_NOW)).toBe(0)
        expect(isFlapSuppressible('twelvelabs', { flapSuppression: true }, mkAm({ startedAt: new Date(AM_NOW + 60_000).toISOString() }), AM_NOW)).toBe(true)
      })
    })
  })

  describe('shouldHoldNewIncident — the burst as it actually arrived', () => {
    const firstSight = { alreadyAlerted: false, firstSeenMs: null, nowMs: AM_NOW }

    it('holds every member of the burst on first sight', () => {
      for (const impact of ['major', 'minor'] as const) {
        expect(shouldHoldNewIncident('twelvelabs', {}, mkAm({ impact }), firstSight)).toBe(true)
      }
    })

    it('the 6m `minor` blip resolves inside the hold window → never alerts', () => {
      const midWindow = { alreadyAlerted: false, firstSeenMs: AM_NOW - 6 * 60_000, nowMs: AM_NOW }
      expect(shouldHoldNewIncident('twelvelabs', {}, mkAm({ impact: 'minor' }), midWindow)).toBe(true)
    })

    it('a 14m incident outlives the window → confirms and alerts once', () => {
      const outlived = { alreadyAlerted: false, firstSeenMs: AM_NOW - (FLAP_HOLD_MS + 1000), nowMs: AM_NOW }
      expect(shouldHoldNewIncident('twelvelabs', {}, mkAm(), outlived)).toBe(false)
    })

    it('a tagged `critical` incident alerts immediately, never held', () => {
      expect(shouldHoldNewIncident('twelvelabs', {}, mkAm({ impact: 'critical' }), firstSight)).toBe(false)
    })
  })

  // The actual user-visible bug: 4 New + 4 Resolved Discord messages. The predicates above are only
  // half the story — the Resolved half is gated by `alertedNewMap.has` inside buildIncidentAlerts, not
  // by any predicate. Compose the same three functions index.ts wires together.
  describe('buildIncidentAlerts integration — the reported 4 New + 4 Resolved', () => {
    const burst = (status: Incident['status']) => [
      mkAm({ id: 'kqk7gdf0h84l', impact: 'minor', status, startedAt: new Date(AM_NOW - 6 * 60_000).toISOString() }),
      mkAm({ id: 'qyc0cyhlqctg', impact: 'major', status, startedAt: new Date(AM_NOW - 5 * 60_000).toISOString() }),
      mkAm({ id: 'qkkqnhkfs69j', impact: 'major', status, startedAt: new Date(AM_NOW - 4 * 60_000).toISOString() }),
      mkAm({ id: '7wk40blkybtq', impact: 'major', status, startedAt: new Date(AM_NOW - 3 * 60_000).toISOString() }),
    ]

    it('first sight: every member is held → ZERO New alerts (was 4)', () => {
      const incidents = burst('investigating')
      const suppressed = new Set<string>()
      for (const i of incidents) {
        if (shouldHoldNewIncident('twelvelabs', {}, i, { alreadyAlerted: false, firstSeenMs: null, nowMs: AM_NOW })) suppressed.add(i.id)
      }
      expect(suppressed.size).toBe(4)
      const svc = mockService({ id: 'twelvelabs', status: 'down', incidents })
      expect(buildIncidentAlerts([svc], alertedMap(), AM_NOW, suppressed)).toHaveLength(0)
    })

    it('the burst self-resolves inside the hold window → ZERO Resolved alerts (was 4)', () => {
      // Never entered alertedNewMap (their New was held), so the resolved branch is skipped entirely.
      const incidents = burst('resolved').map((i) => ({ ...i, resolvedAt: new Date(AM_NOW).toISOString(), duration: '11m' }))
      const svc = mockService({ id: 'twelvelabs', status: 'operational', incidents })
      const suppressed = new Set(incidents.map((i) => i.id))
      expect(buildIncidentAlerts([svc], alertedMap(), AM_NOW, suppressed)).toHaveLength(0)
      // ...and still zero even if the cron had NOT re-suppressed them this cycle: alertedNewMap gates it.
      expect(buildIncidentAlerts([svc], alertedMap(), AM_NOW, new Set())).toHaveLength(0)

      // Positive control — the two zeros above must come from the alertedNewMap gate, NOT from
      // buildIncidentAlerts being unable to emit a Resolved for a tagged incident at all. Had these
      // incidents actually alerted New in a prior cycle, all four Resolved alerts DO fire.
      const roster = alertedMap(Object.fromEntries(incidents.map((i) => [i.id, ['twelvelabs']])))
      const resolvedAlerts = buildIncidentAlerts([svc], roster, AM_NOW, new Set())
      expect(resolvedAlerts).toHaveLength(4)
      expect(resolvedAlerts.every((a) => a.key.startsWith('alerted:res:'))).toBe(true)
    })

    it('an incident that outlives the hold fires exactly ONE New alert', () => {
      const survivor = mkAm({ id: 'tl-long' })
      const svc = mockService({ id: 'twelvelabs', status: 'down', incidents: [survivor] })
      const held = shouldHoldNewIncident('twelvelabs', {}, survivor, { alreadyAlerted: false, firstSeenMs: AM_NOW - (FLAP_HOLD_MS + 1000), nowMs: AM_NOW })
      expect(held).toBe(false)
      const alerts = buildIncidentAlerts([svc], alertedMap(), AM_NOW, new Set())
      expect(alerts).toHaveLength(1)
      expect(alerts[0].key).toBe('alerted:new:tl-long')
    })

    it('a REAL sustained outage under the machine title still alerts even inside an active flap window', () => {
      // The regression this guards: escape window → not suppressible → the cron never adds it to
      // suppressedIncIds, so its New alert ships.
      const real = mkAm({ id: 'tl-real', startedAt: new Date(AM_NOW - 45 * 60_000).toISOString() })
      expect(isFlapSuppressible('twelvelabs', { flapSuppression: true }, real, AM_NOW)).toBe(false)
      const svc = mockService({ id: 'twelvelabs', status: 'down', incidents: [real] })
      const alerts = buildIncidentAlerts([svc], alertedMap(), AM_NOW, new Set())
      expect(alerts.map((a) => a.key)).toEqual(['alerted:new:tl-real'])
    })
  })

  describe('the real twelvelabs SERVICES config', () => {
    const cfg = SERVICES.find((s) => s.id === 'twelvelabs')!

    it('opts into both the tag and the 60-min flap-suppression window', () => {
      expect(cfg.autoMonitorTitles?.length).toBeGreaterThan(0)
      expect(cfg.flapSuppression).toBe(true)
    })

    it('matches the machine-emitted title but NOT the provider human-written ones', () => {
      const matches = (title: string) => cfg.autoMonitorTitles!.some((re) => re.test(title))
      expect(matches('Some API features are experiencing issues')).toBe(true)
      // Real Twelve Labs incidents from the same page — must stay ungrouped + alert immediately.
      expect(matches('Search API failure')).toBe(false)
      expect(matches('API server failure')).toBe(false)
      expect(matches('Analyze Disruption')).toBe(false)
      expect(matches('Youtube video upload not working')).toBe(false)
      // Anchored: a longer human title that merely CONTAINS the phrase must not match.
      expect(matches('Some API features are experiencing issues after the migration')).toBe(false)
    })
  })
})
