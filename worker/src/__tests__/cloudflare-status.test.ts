import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCloudflareStatusSummary } from '../parsers/cloudflare-status'
import { fetchService, mergeRetainedIncidentHistory, retainMigratedIncidentHistory, SERVICES } from '../services'
import { calculateAIWatchScore } from '../score'
import { PROBE_TARGETS } from '../probe'
import { prunePhantomIncidents, PHANTOM_PRUNE_AFTER_MISSED_RUNS } from '../monthly-archive'
import type { Incident, ServiceStatus } from '../types'

const REPLICATE = 'fvgfcmy66tdr'
const replicate = SERVICES.find((service) => service.id === 'replicate')!

function summary(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    result: {
      components: [{ id: REPLICATE, name: 'Replicate', status: 'operational' }],
      active_incidents: [],
      ...overrides,
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('#1384 Cloudflare Status v3 parser', () => {
  it('uses the declared component status and only active incidents explicitly attached to it', () => {
    const parsed = parseCloudflareStatusSummary(summary({
      components: [{ id: REPLICATE, name: 'Replicate', status: 'degraded_performance' }],
      active_incidents: [
        {
          id: 'ours', name: 'Replicate API errors', status: 'identified', impact: 'major',
          created_at: '2026-09-10T01:00:00.000Z', starts_at: '2026-09-10T01:00:00.000Z',
          components: [{ id: REPLICATE, name: 'Replicate' }],
          last_update: { status: 'identified', message: 'Investigating', created_at: '2026-09-10T01:05:00.000Z' },
        },
        {
          // This is the real migration trap: a global Cloudflare incident can mention Replicate in
          // prose while carrying no Replicate component. It must never land on this service card.
          id: 'not-ours', name: 'Replicate elevated error rate', status: 'identified', impact: 'minor',
          created_at: '2026-09-10T01:00:00.000Z', components: [],
        },
      ],
    }), [REPLICATE])

    expect(parsed).toMatchObject({ ok: true })
    if (!parsed.ok) return
    expect(parsed.summary.status).toBe('degraded')
    expect(parsed.summary.incidents).toHaveLength(1)
    expect(parsed.summary.incidents[0]).toMatchObject({
      id: 'cloudflare:ours', title: 'Replicate API errors', impact: 'major',
      componentIds: [REPLICATE], componentNames: ['Replicate'],
    })
  })

  it('rejects a success envelope when the configured component disappears', () => {
    expect(parseCloudflareStatusSummary(summary({ components: [] }), [REPLICATE]))
      .toEqual({ ok: false, reason: 'cloudflare-component-missing' })
  })

  it('rejects an unknown component vocabulary instead of treating it as operational', () => {
    expect(parseCloudflareStatusSummary(summary({
      components: [{ id: REPLICATE, name: 'Replicate', status: 'new-unrecognized-state' }],
    }), [REPLICATE])).toEqual({ ok: false, reason: 'cloudflare-component-status-unreadable' })
  })
})

describe('#1384 Cloudflare Status v3 Worker wiring', () => {
  it('publishes current component health without manufacturing uptime', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(summary({
      components: [{ id: REPLICATE, name: 'Replicate', status: 'degraded_performance' }],
    })), { status: 200 })))

    const service = await fetchService(replicate, undefined, undefined, {})
    expect(service.status).toBe('degraded')
    expect(service.incidents).toEqual([])
    expect(service.uptime30d).toBeNull()
    expect(service.incidentSourceStale).toBeUndefined()
  })

  it('does NOT read announced maintenance as an outage', async () => {
    // This fixture previously stood in for "current component health" and asserted `degraded`,
    // pinning the one mapping that disagrees with every other source in this repo: `statuspage.ts`
    // has no case for `under_maintenance` (→ operational), `incident-io.ts` weights it 0,
    // `flashduty.ts` maps it to operational, `impact-weights.ts` scores it 0, and CLAUDE.md excludes
    // announced maintenance from uptime. The live v3 summary carries `active_maintenances`, so a
    // scheduled window is a reachable state — and `degraded` there means /is-replicate-down answers
    // "yes", a status-edge Discord alert fires, and fallbacks are recommended for a planned window.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(summary({
      components: [{ id: REPLICATE, name: 'Replicate', status: 'under_maintenance' }],
    })), { status: 200 })))

    const service = await fetchService(replicate, undefined, undefined, {})
    expect(service.status).toBe('operational')
    // And it is not being smuggled in as an incident either.
    expect(service.incidents).toEqual([])
  })

  it('keeps Replicate scoreable from its existing direct-probe summary after the source migration', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(summary()), { status: 200 })))

    const service = await fetchService(replicate, undefined, undefined, {})
    expect(PROBE_TARGETS.some((target) => target.id === 'replicate')).toBe(true)
    const score = calculateAIWatchScore(service, 30, {
      // Existing production summary observed during the migration verification.
      // The source move must not reset this valid direct-probe history.
      kind: 'available', summary: { p50: 307, p95: 503, cvCombined: 0.52, validDays: 7 },
    })

    expect(score).toMatchObject({ score: 80, confidence: 'medium' })
    expect(score.metrics.uptimePct).toBeNull()
  })

  it('retains recent pre-migration incidents for the live score and is-down consumers', () => {
    const legacy = {
      id: 'legacy-replicate-incident', title: 'Limited H100 capacity', startedAt: '2026-08-20T00:00:00.000Z',
      resolvedAt: '2026-08-20T01:30:00.000Z', durationMin: 90, finalStatus: 'resolved' as const, impact: 'major' as const,
    }
    const tooOld = { ...legacy, id: 'too-old', startedAt: '2026-08-01T00:00:00.000Z' }
    const live = [{
      id: 'cloudflare:active', title: 'Current Replicate incident', status: 'investigating' as const, impact: 'minor' as const,
      startedAt: '2026-09-10T00:00:00.000Z', resolvedAt: null, duration: null, timeline: [],
    }]

    const incidents = mergeRetainedIncidentHistory(live, [legacy, tooOld], '2026-08-12T00:00:00.000Z')

    expect(incidents.map((incident) => incident.id)).toEqual(['cloudflare:active', 'legacy-replicate-incident'])
    expect(incidents.find((incident) => incident.id === legacy.id)).toMatchObject({ duration: '1h 30m', status: 'resolved' })
    const score = calculateAIWatchScore({
      id: 'replicate', name: 'Replicate', provider: 'Replicate', category: 'api', status: 'operational', latency: null,
      uptime30d: null, lastChecked: '2026-09-11T00:00:00.000Z', incidents,
    }, 30, { kind: 'available', summary: { p50: 307, p95: 503, cvCombined: 0.52, validDays: 7 } }, {
      startISO: '2026-08-12T00:00:00.000Z', endISO: '2026-09-12T00:00:00.000Z',
    })
    expect(score.metrics.affectedDays30d).toBe(2)
    expect(score.breakdown.incidents).toBeLessThan(25)
    expect(score.breakdown.recovery).toBeLessThan(15)
  })

  it('forwards a retained entry that was still open at migration time, as ongoing', () => {
    // Round-3 review found this entry's exposure under-documented; round-4 review found that
    // EXCLUDING it (a since-reverted attempt) is the worse defect — see the docblock above
    // `mergeRetainedIncidentHistory`. Forwarding it unconditionally is the accepted trade: a stale
    // 'investigating' status is self-correcting (bounded by `retainIncidentHistoryUntil`), whereas
    // dropping it would un-attribute — reproduced in the next test — into a false public withdrawal.
    const stillOpenAtMigration = {
      id: 'still-open-at-migration', title: 'Ongoing at cutover', startedAt: '2026-08-25T00:00:00.000Z',
      resolvedAt: null, durationMin: 0, finalStatus: 'investigating' as const, impact: 'major' as const,
    }
    const live = [{
      id: 'cloudflare:active', title: 'Current Replicate incident', status: 'investigating' as const, impact: 'minor' as const,
      startedAt: '2026-09-10T00:00:00.000Z', resolvedAt: null, duration: null, timeline: [],
    }]

    const incidents = mergeRetainedIncidentHistory(live, [stillOpenAtMigration], '2026-08-12T00:00:00.000Z')

    expect(incidents.map((incident) => incident.id)).toEqual(['cloudflare:active', 'still-open-at-migration'])
    expect(incidents.find((i) => i.id === 'still-open-at-migration')).toMatchObject({ status: 'investigating', resolvedAt: null })
  })

  it('a still-open retained entry survives repeated phantom-pruning — never a false withdrawal', () => {
    // Round-4 review repro, reproduced here rather than only described: excluding an unresolved
    // retained entry from the merged live list (a since-reverted change) removed the one thing that
    // kept it `seen` by `prunePhantomIncidents` (monthly-archive.ts). Once genuinely absent from the
    // live list for `PHANTOM_PRUNE_AFTER_MISSED_RUNS` consecutive cycles — guard 3 satisfied by ANY
    // earlier-starting live incident — the accumulator entry is deleted and a public "Incident
    // Withdrawn" notice fires, a claim that is actively false: the provider withdrew nothing, AIWatch
    // just stopped reading their page.
    //
    // Round-6 review found the FIRST version of this fixture supplied guard 3's "earlier live
    // incident" via a SECOND bridged row — which round 5's fix now excludes from guard 3 anyway, so
    // the test no longer isolated what it claims to (a mutation removing the `liveIds` inclusion left
    // the whole worker suite green). Guard 3 here is instead satisfied by a genuinely NATIVE live
    // incident that never goes through the bridge at all, so the ONLY thing left protecting
    // `stillOpenAtMigration` from pruning is its own presence in `liveIds` — the round-4 invariant.
    const stillOpenAtMigration = {
      id: 'still-open-at-migration', title: 'Ongoing at cutover', startedAt: '2026-09-12T00:00:00.000Z',
      resolvedAt: null, durationMin: 0, finalStatus: 'investigating' as const, impact: 'major' as const,
    }
    const nativeEarlierLive: Incident = {
      id: 'cloudflare:native-earlier', title: 'Native earlier outage', status: 'resolved', impact: 'minor',
      startedAt: '2026-09-01T00:00:00.000Z', resolvedAt: '2026-09-01T01:00:00.000Z', duration: '1h', timeline: [],
    }
    const cutoffISO = '2026-08-12T00:00:00.000Z'
    const mergedLive = mergeRetainedIncidentHistory([nativeEarlierLive], [stillOpenAtMigration], cutoffISO)
    // Guard 3 is satisfied by `nativeEarlierLive` alone (not `retainedBridge`-tagged) — so the ONLY
    // thing keeping the phantom prune off `stillOpenAtMigration` is guard 2 (its id is present in
    // `liveIds` at all, despite also being `retainedBridge`-tagged).
    expect(mergedLive.map((i) => i.id)).toContain('still-open-at-migration')
    expect(mergedLive.map((i) => i.id)).toContain('cloudflare:native-earlier')

    let data = {
      lastUpdated: '2026-09-12T00:00:00.000Z',
      services: { replicate: {
        count: 1, totalMinutes: 0, longestMinutes: 0, dates: [], durations: {},
        incidentIds: ['still-open-at-migration'],
        incidents: [stillOpenAtMigration],
      } },
    }
    const services: ServiceStatus[] = [{
      id: 'replicate', name: 'Replicate', provider: 'Replicate', category: 'api' as const, status: 'operational' as const,
      latency: null, uptime30d: null, lastChecked: '2026-09-12T00:00:00.000Z', incidents: mergedLive,
    }]

    // PHANTOM_PRUNE_AFTER_MISSED_RUNS consecutive cycles, same as the real cron.
    for (let i = 0; i < PHANTOM_PRUNE_AFTER_MISSED_RUNS + 1; i++) {
      data = prunePhantomIncidents(data, services, []) as typeof data
    }

    expect(data.services.replicate.incidentIds).toContain('still-open-at-migration')
    expect(data.services.replicate.incidents?.find((e) => e.id === 'still-open-at-migration')).toBeDefined()
  })

  it('a resolved bridged row does not fabricate feed reach for an UNRELATED native incident', () => {
    // Round-5 review finding, reproduced directly. `prunePhantomIncidents`'s guard 3 trusts the live
    // list's earliest start as proof of how far the CURRENT feed actually reaches. A `retainedBridge`
    // row is real, but it comes from AIWatch's own PRIOR collection under the retiring source, not
    // from this cycle's (often much shallower) new-source feed — so if it counted as evidence, an
    // ordinary bridged resolved row (started weeks ago) would satisfy guard 3 for a completely
    // unrelated, genuinely-unresolved NATIVE incident that had simply aged out of the new source's
    // shallow window, and that native incident would be falsely pruned + announced withdrawn.
    const nativeUnresolved = {
      id: 'cloudflare:native-unresolved', title: 'Native Cloudflare incident', startedAt: '2026-09-08T00:00:00.000Z',
      resolvedAt: null, durationMin: 0, finalStatus: 'investigating' as const, impact: 'major' as const,
    }
    const oldBridgedResolved = {
      id: 'legacy-old-resolved', title: 'Old resolved outage', startedAt: '2026-08-20T00:00:00.000Z',
      resolvedAt: '2026-08-20T01:00:00.000Z', durationMin: 60, finalStatus: 'resolved' as const, impact: 'minor' as const,
    }
    const cutoffISO = '2026-08-12T00:00:00.000Z'
    // This cycle: Cloudflare's shallow feed no longer carries `native-unresolved` at all (it aged out
    // of `recent_incidents`' ~4-day reach) — only the bridge's older resolved row is present.
    const mergedLive = mergeRetainedIncidentHistory([], [oldBridgedResolved], cutoffISO)
    expect(mergedLive.map((i) => i.id)).toEqual(['legacy-old-resolved'])

    let data = {
      lastUpdated: '2026-09-12T00:00:00.000Z',
      services: { replicate: {
        count: 1, totalMinutes: 0, longestMinutes: 0, dates: [], durations: {},
        incidentIds: ['cloudflare:native-unresolved'],
        incidents: [nativeUnresolved],
      } },
    }
    const services: ServiceStatus[] = [{
      id: 'replicate', name: 'Replicate', provider: 'Replicate', category: 'api' as const, status: 'operational' as const,
      latency: null, uptime30d: null, lastChecked: '2026-09-12T00:00:00.000Z', incidents: mergedLive,
    }]

    for (let i = 0; i < PHANTOM_PRUNE_AFTER_MISSED_RUNS + 1; i++) {
      data = prunePhantomIncidents(data, services, []) as typeof data
    }

    expect(data.services.replicate.incidentIds).toContain('cloudflare:native-unresolved')
    expect(data.services.replicate.incidents?.find((e) => e.id === 'cloudflare:native-unresolved')).toBeDefined()
  })

  it('loads the prior archive plus current accumulator during Replicate’s finite migration bridge', async () => {
    // Both RESOLVED — kept that way so this test stays about the archive+accumulator KV-loading
    // wiring only. A still-open entry is NOT excluded (see 'forwards a retained entry that was still
    // open at migration time, as ongoing' above) — a prior version of this comment claimed otherwise.
    const prior = {
      period: '2026-08', services: { replicate: { incidentList: [{
        id: 'august', title: 'August outage', startedAt: '2026-08-20T00:00:00.000Z', resolvedAt: '2026-08-20T01:00:00.000Z',
        durationMin: 60, finalStatus: 'resolved', impact: 'minor',
      }] } },
    }
    const current = { lastUpdated: '2026-09-11T00:00:00.000Z', services: { replicate: { incidents: [{
      id: 'september', title: 'September outage', startedAt: '2026-09-05T00:00:00.000Z', resolvedAt: '2026-09-05T02:00:00.000Z',
      durationMin: 120, finalStatus: 'resolved', impact: 'major',
    }] } } }
    const kv = { get: vi.fn(async (key: string) => {
      if (key === 'archive:monthly:2026-08') return JSON.stringify(prior)
      if (key === 'incidents:monthly:2026-09') return JSON.stringify(current)
      return null
    }) }
    const services: ServiceStatus[] = [{
      id: 'replicate', name: 'Replicate', provider: 'Replicate', category: 'api' as const, status: 'operational' as const,
      latency: null, uptime30d: null, lastChecked: '2026-09-11T00:00:00.000Z', incidents: [],
    }]

    await retainMigratedIncidentHistory(services, kv as unknown as KVNamespace, new Date('2026-09-11T00:00:00.000Z'))

    expect(kv.get).toHaveBeenCalledWith('archive:monthly:2026-08')
    expect(kv.get).toHaveBeenCalledWith('incidents:monthly:2026-09')
    expect(services[0].incidents.map((incident) => incident.id)).toEqual(['september', 'august'])
  })

  it('marks an unreadable v3 response stale after the shared failure threshold', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, result: {} }), { status: 200 })))
    const tracking = {}
    await fetchService(replicate, undefined, undefined, tracking)
    await fetchService(replicate, undefined, undefined, tracking)
    const service = await fetchService(replicate, undefined, undefined, tracking)

    expect(service).toMatchObject({ status: 'unknown', sourceUnknown: true, incidentSourceStale: true })
    expect(service.uptime30d).toBeNull()
  })
})

// ── resolutions (#1384 review) ──────────────────────────────────────────────────────────────────
// The parser originally read only `active_incidents`, on the reasoning that v3's history starts at
// migration and AIWatch's own records are the historical source. That is true about BACKFILL and
// false about RESOLUTION: Cloudflare moves an incident out of `active_incidents` the moment it
// resolves, and active entries carry no `resolved_at` at all — verified against the live payload,
// whose active entries expose only `components, created_at, id, impact, last_update, name,
// starts_at, status, type, updated_at`. So no cron cycle could ever observe a terminal state.
describe('#1384 an incident that resolved is observed as resolved', () => {
  const ACTIVE = {
    id: 'abc123', name: 'Replicate API errors', status: 'investigating', impact: 'major',
    created_at: '2026-09-10T01:00:00Z', starts_at: '2026-09-10T01:00:00Z',
    components: [{ id: REPLICATE, name: 'Replicate' }],
    last_update: { status: 'investigating', message: 'looking', display_at: '2026-09-10T01:05:00Z' },
  }
  const RESOLVED = {
    ...ACTIVE, status: 'resolved',
    resolved_at: '2026-09-10T03:00:00Z', ends_at: '2026-09-10T03:00:00Z',
    last_update: { status: 'resolved', message: 'fixed', display_at: '2026-09-10T03:00:00Z' },
  }

  it('carries resolvedAt and a duration once the entry moves to recent_incidents', () => {
    const r = parseCloudflareStatusSummary(
      summary({ active_incidents: [], recent_incidents: [RESOLVED] }), [REPLICATE],
    )
    expect(r.ok).toBe(true)
    const inc = (r as { summary: { incidents: Incident[] } }).summary.incidents[0]
    expect(inc.status).toBe('resolved')
    expect(inc.resolvedAt).toBe('2026-09-10T03:00:00Z')
    expect(inc.duration, 'a resolved incident must carry a duration, or the archive banks 0 minutes').not.toBeNull()
  })

  it('does not double-count an entry present in BOTH lists, and the resolved copy wins', () => {
    // The hand-over window. Keeping the active copy would re-open a closed thread on the next cycle.
    const r = parseCloudflareStatusSummary(
      summary({ active_incidents: [ACTIVE], recent_incidents: [RESOLVED] }), [REPLICATE],
    )
    const incs = (r as { summary: { incidents: Incident[] } }).summary.incidents
    expect(incs).toHaveLength(1)
    expect(incs[0].status).toBe('resolved')
    expect(incs[0].resolvedAt).not.toBeNull()
  })

  it('still refuses history for components we do not configure — the backfill worry', () => {
    // `recent_incidents` is Cloudflare-wide. Reading it must not import another product's history.
    const other = { ...RESOLVED, id: 'zzz', components: [{ id: 'someothercomponent', name: 'Workers' }] }
    const r = parseCloudflareStatusSummary(
      summary({ active_incidents: [], recent_incidents: [other] }), [REPLICATE],
    )
    expect((r as { summary: { incidents: Incident[] } }).summary.incidents).toEqual([])
  })

  it('tolerates a payload with no recent_incidents key at all', () => {
    // Absent must not fail the whole read — the active side is still usable.
    const r = parseCloudflareStatusSummary(summary({ active_incidents: [ACTIVE] }), [REPLICATE])
    expect(r.ok).toBe(true)
    expect((r as { summary: { incidents: Incident[] } }).summary.incidents).toHaveLength(1)
  })
})

// ── an unreadable incident must not read as a quiet page (#1384 review) ─────────────────────────
describe('#1384 a malformed incident entry refuses the read', () => {
  const OURS = {
    id: 'abc', name: 'Replicate API errors', status: 'investigating', impact: 'major',
    created_at: '2026-09-10T01:00:00Z',
    components: [{ id: REPLICATE, name: 'Replicate' }],
  }

  it('REFUSES when a required field on an attributed entry is missing or retyped', () => {
    // Before this, `parseIncidentEntry` returned null for both "not ours" and "could not read it",
    // and the caller dropped both — so a renamed `impact` published `operational` with an empty
    // incident list while an outage was posted. The component path already fails to `unreadable`
    // for the same class of drift.
    for (const bad of [
      { ...OURS, impact: undefined },
      { ...OURS, impact: 3 },
      { ...OURS, status: undefined },
      { ...OURS, name: undefined },
      { ...OURS, id: undefined },
    ]) {
      const r = parseCloudflareStatusSummary(summary({ active_incidents: [bad] }), [REPLICATE])
      expect(r, `${JSON.stringify(bad).slice(0, 60)} must refuse`).toEqual({
        ok: false, reason: 'cloudflare-incident-unreadable',
      })
    }
  })

  it('does NOT let a FOREIGN entry\'s drift refuse our read', () => {
    // The order finding. This page carries 472 components and one is ours, so a renamed field on any
    // unrelated Cloudflare product must not take Replicate down — and "down" here is worse than it
    // sounds: the wiring's failure ramp publishes `operational` with no incidents for two cycles
    // before it reaches `unknown`, which is the same fail-open the refusal exists to close.
    const foreignBroken = {
      id: 'zzz', name: 'SSL provisioning delays', status: 'investigating',
      created_at: '2026-09-10T01:00:00Z',
      components: [{ id: 'someothercomponent', name: 'SSL Certificate Provisioning' }],
      // impact renamed — exactly the drift that refused the whole read before
    }
    const r = parseCloudflareStatusSummary(summary({
      active_incidents: [OURS, foreignBroken],
    }), [REPLICATE])
    expect(r.ok, 'a foreign entry we cannot read is not ours to judge').toBe(true)
    const incs = (r as { summary: { incidents: Incident[] } }).summary.incidents
    expect(incs.map((i) => i.id)).toEqual(['cloudflare:abc'])
  })

  it('treats an entry whose components cannot be read at all as not-ours, not unreadable', () => {
    // Attribution is decided on `components` alone. If that field is missing or the wrong type there
    // is no way to tell whose entry it is, and claiming it is ours would re-open the same hole.
    for (const shape of [{ ...OURS, components: 'Replicate' }, { ...OURS, components: undefined }]) {
      const r = parseCloudflareStatusSummary(summary({ active_incidents: [shape] }), [REPLICATE])
      expect(r.ok, JSON.stringify(shape).slice(0, 50)).toBe(true)
      expect((r as { summary: { incidents: Incident[] } }).summary.incidents).toEqual([])
    }
  })

  it('attributes by id ALONE — a renamed/missing component `name` must not un-attribute a correctly-attributed incident', () => {
    // Round-3 review repro. `attribution` used to filter `components` down to entries carrying a
    // string `name` BEFORE checking any id against `componentIds` — so a component matching our id
    // but missing/renaming its `name` (`display_name` here, a plausible real-world drift) was dropped
    // from that filtered array, the id check saw nothing to test, and the whole entry read as
    // 'not-ours': `ok: true, incidents: []`, a green badge over a real, correctly-attributed outage.
    // Attribution needs only `id`; `name` is display-only and must never gate it.
    const r = parseCloudflareStatusSummary(summary({
      active_incidents: [{
        id: 'renamed-name-field', name: 'Replicate API errors', status: 'investigating', impact: 'major',
        created_at: '2026-09-10T01:00:00Z',
        components: [{ id: REPLICATE, display_name: 'Replicate' }],
      }],
    }), [REPLICATE])
    expect(r.ok).toBe(true)
    const incs = (r as { summary: { incidents: Incident[] } }).summary.incidents
    expect(incs.map((i) => i.id)).toEqual(['cloudflare:renamed-name-field'])
  })

  it('still SKIPS a well-formed entry that names another product, without failing', () => {
    // The feed is Cloudflare-wide: most entries are someone else's, and that is not a failure.
    const r = parseCloudflareStatusSummary(summary({
      active_incidents: [{ ...OURS, id: 'zzz', components: [{ id: 'otherthing', name: 'Workers' }] }],
    }), [REPLICATE])
    expect(r.ok).toBe(true)
    expect((r as { summary: { incidents: Incident[] } }).summary.incidents).toEqual([])
  })

  it('publishes `unknown` rather than a green badge when an incident is unreadable', () => {
    // The wiring half: the reason reaches recordParseFailure and sourceUnknown like every sibling.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(summary({
      active_incidents: [{ ...OURS, impact: undefined }],
    })), { status: 200 })))
    return fetchService(replicate, undefined, undefined, {}).then((service) => {
      expect(service.sourceUnknown).toBe(true)
      expect(service.incidents).toEqual([])
    })
  })
})
