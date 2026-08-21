import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchService, fetchAllServices, SERVICES, withUnreadFeedFlag, isStatuspageSummary } from '../services'
import { hasReliableScoreData } from '../../../src/utils/serviceReliability'
import { mockKV, TEST_TIMEOUT_MS, decayedTracking } from './helpers/unreadable-source'

// #1268 — a status page that no longer exists must not be scored as "0 incidents".
//
// Character.AI's Statuspage was DELETED. Statuspage serves that as `302 → /page-deleted → 200 HTML`,
// so `summaryRes.ok` is true and the #689 `dead-source` branch (which keys on a 4xx via
// `classifyStatusPageFailure`) never runs. The SyntaxError from `.json()` fell into the catch at the
// bottom of `fetchServiceUntagged`, which flags `sourceUnknown` and nothing else — and `sourceUnknown`
// is wired to the alert holds, not to scoring. The service therefore kept publishing
// `incidents: []` → `incidents30d: 0` → a full 25/25 + 15/15, and ranked at 75 ("good") on a probe
// worth 5.1/20 (observed in production 2026-08-20).
//
// The gate that should have excluded it is `incidentSourceStale` (the #591 field every ranking surface
// reads), and the fix sets it from the OBSERVATION alone: the response we got was not the API.
//
// It is deliberately NOT driven off `ServiceConfig.statusSourceDeactivated`, which was tried first and
// rejected. That flag is a hand-written claim about the outside world, and its only job is alert
// suppression (`shouldSuppressSourceDeadAlert`, `deactivatedSourceIds`) — an operator saying "stop
// paging me", not a measurement. Sourcing a published data claim from it inverts the dependency: the
// page could come back and the config would keep asserting it was gone until somebody edited a
// TypeScript literal. What the reader is told about a status source has to be derived from tracking
// that source, which is the whole point of the product.
//
// Drives the real `fetchService` entry point (the `instatus-parse-failure-status.test.ts` harness
// pattern) rather than a hand-assembled imitation: the defect was never in a helper, it was in which
// branch reached the flag, and a pure-function test cannot see a branch.

const characterai = SERVICES.find((s) => s.id === 'characterai')!
const claudeai = SERVICES.find((s) => s.id === 'claudeai')!

/** The tracking blob one strike short of the crossing, so THIS call is the third. Required by every
 *  assertion about `incidentSourceStale`: the flag follows the unreadable-source VERDICT
 *  (`status === 'unknown'`), not the first failed read — see `withUnreadFeedFlag`. A bare `{}` store
 *  leaves the service on strike 1, which is deliberately unflagged. */
const crossed = (id: string) => ({ [id]: { failCount: 2, failCountAt: new Date().toISOString() } })

/** What `status.character.ai/api/v2/summary.json` actually serves today: the Statuspage tombstone. */
const DELETED_PAGE_HTML = '<!DOCTYPE html><html><head><title>Statuspage - Statuspage deleted</title></head><body></body></html>'

/** Every fetch answers 200 with HTML — the crux. The URL is *reachable*, so nothing keys off the HTTP
 *  status, and the body is simply not the API any more. */
function stubDeletedPage() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(DELETED_PAGE_HTML, { status: 200 })))
}

/** A structurally VALID, fully healthy Statuspage payload — i.e. the page working perfectly. The
 *  control for every assertion below: the guard must key on the BODY we got back, nothing else. */
function stubHealthyPage(componentId: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('summary.json')) {
      return new Response(JSON.stringify({
        page: { id: 'p', name: 'Status', updated_at: new Date().toISOString() },
        status: { indicator: 'none', description: 'All Systems Operational' },
        components: [{ id: componentId, name: 'Service', status: 'operational' }],
        incidents: [],
      }), { status: 200 })
    }
    if (String(url).includes('incidents.json')) return new Response(JSON.stringify({ incidents: [] }), { status: 200 })
    return new Response('<html></html>', { status: 200 })
  }))
}

afterEach(() => vi.unstubAllGlobals())

describe('#1268 — the real service, through the real entry point', () => {
  it('premise — the config facts this file leans on still hold', () => {
    // Both are load-bearing and both can be edited away without any test naming them, which would turn
    // the assertions below vacuous rather than red. `statusSourceDeactivated` is what the 'no config to
    // un-set' case below is contrasting against, and its own comment says "REMOVE when the page comes
    // back"; the apiUrl shape is what makes `stubHealthyPage`'s Atlassian payload the right control, so
    // re-pointing this service at Instatus/incident.io must fail HERE, naming the cause.
    expect(characterai.statusSourceDeactivated, 'the contrast this file draws needs the flag present').toBe(true)
    expect(characterai.apiUrl, 'stubHealthyPage serves an Atlassian summary').toMatch(/\/api\/v2\/summary\.json$/)
  })

  it('characterai is stale-marked when its page serves the tombstone', async () => {
    stubDeletedPage()
    const svc = await fetchService(characterai, undefined, undefined, crossed('characterai'))
    expect(svc.incidentSourceStale).toBe(true)
  })

  it('and is NOT stale-marked once its page serves the API again — no config to un-set', async () => {
    // The reason the config flag was rejected. Recovery has to be automatic: the same fetch that
    // observes a readable source is what clears the claim. `statusSourceDeactivated` stays true on this
    // service (it still suppresses the dead-source alert), so this failing would mean the config had
    // captured the published state again.
    stubHealthyPage(characterai.statusComponentId!)
    const svc = await fetchService(characterai, undefined, undefined, {})
    expect(svc.incidentSourceStale).toBeUndefined()
  })
})

describe('#1268 — a 200 with a non-JSON body is an unread feed, not an indeterminate one', () => {
  it('flags incidentSourceStale for an UNDECLARED service whose API returns 200 HTML', async () => {
    // claudeai carries no config flag of any kind, so only the observation can set this. This is the
    // half that covers the next provider to delete a status page before anyone notices and declares it.
    stubDeletedPage()
    const svc = await fetchService(claudeai, undefined, undefined, crossed('claudeai'))
    expect(svc.incidentSourceStale).toBe(true)
  })

  it('publishes NO incidents — an unread feed is not an empty one', async () => {
    // The whole point. `incidents: []` here is indistinguishable in shape from a quiet month, which is
    // why the flag beside it has to be what score.ts reads.
    stubDeletedPage()
    const svc = await fetchService(claudeai, undefined, undefined, crossed('claudeai'))
    expect(svc.incidents).toEqual([])
    expect(svc.incidentSourceStale).toBe(true)
  })

  it('keeps the #714 indeterminate hold on the BADGE — status is not degraded on the first one', async () => {
    // A 200 HTML body can be a bot interstitial, so the badge verdict stays on the existing ramp.
    // Ranking eligibility does not: the two are decided separately, and coupling them is the bug.
    stubDeletedPage()
    const svc = await fetchService(claudeai, undefined, undefined, {})
    expect({ status: svc.status, sourceUnknown: svc.sourceUnknown }).toEqual({ status: 'operational', sourceUnknown: true })
  })

  it('the flag FOLLOWS the strike counter — strike 1 is deliberately unflagged', async () => {
    // Round 3 inverted this. It previously asserted the opposite, on the reasoning that "we did not read
    // the feed" is certain on cycle one. True, but the flag is not scoping-only: `incidentSourceStale`
    // also flips the CACHED is-down SEO page ("AIWatch can't currently read X's status source"), blanks
    // the uptime the Instatus/OnlineOrNot return preserves from an independent successful fetch, and is
    // stamped durably into the month-end archive. A single transient 5xx across a 45-service parallel
    // fetch is common (status-determination.md, #1233), so keying on the first read would defeat the
    // flap suppression the three-strike ramp exists for — one unlucky timeout at archive time would
    // mark a service stale for the whole month.
    stubDeletedPage()
    const below = await fetchService(claudeai, undefined, undefined, {})
    const past = await fetchService(claudeai, undefined, undefined, crossed('claudeai'))
    expect({ status: below.status, stale: below.incidentSourceStale }).toEqual({ status: 'operational', stale: undefined })
    expect({ status: past.status, stale: past.incidentSourceStale }).toEqual({ status: 'unknown', stale: true })
    // Both cycles still record that the READ failed — only the durable claim waits for the crossing.
    expect(below.sourceUnknown).toBe(true)
  })

  it('both doors of the verdict are pinned — a first failure is not flagged, an ongoing one still is', async () => {
    // `shouldDegrade` is `next >= threshold || stillUnrecovered`, so the three-strike crossing is one of
    // TWO ways `status` becomes `unknown`. An earlier version of this file's docstring claimed the
    // crossing was the only one; it is not, and the claim went unverified. Both doors are asserted here
    // so the gate is anchored to measured behaviour rather than to a description of it.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 503 })))
    // Door 0 — a genuine first failure of a source with no history: NOT flagged.
    const first = await fetchService(claudeai, undefined, undefined, {})
    expect({ status: first.status, stale: first.incidentSourceStale })
      .toEqual({ status: 'operational', stale: undefined })
    // Door 2 — mid-outage: the counter has DECAYED to zero, but `failSince` says nothing has succeeded
    // for hours. #1232 exists to keep this `unknown` rather than letting it lapse back to green, and the
    // flag must follow it. `decayedTracking` is the shared fixture for exactly this state.
    const ongoing = await fetchService(claudeai, undefined, undefined, JSON.parse(decayedTracking(['claudeai'])['tracking:state']))
    expect({ status: ongoing.status, stale: ongoing.incidentSourceStale })
      .toEqual({ status: 'unknown', stale: true })
  })

  it('a VALID JSON payload is untouched — the guard reads the body, not the shape of the URL', async () => {
    stubHealthyPage(claudeai.statusComponentId!)
    const svc = await fetchService(claudeai, undefined, undefined, crossed('claudeai'))
    expect(svc.incidentSourceStale).toBeUndefined()
    expect(svc.sourceUnknown).toBeUndefined()
  })
})

// ── The other half of the same regression: the BADGE ─────────────────────────────────────────────
//
// #1268 — while the Statuspage answered 401 the #689 4xx path set `sourceDead`, the pass below it set
// `probeConfirmed`, and the detail card explained the green pill ("the status page is inactive, but its
// API still responds to our direct probe"). Once the deleted page answered `302 → 200 text/html` the 4xx
// path stopped firing: the fetch leg now returns `unknown`, and Phase-1 cross-validation overrides it
// back to `operational` on a healthy probe. Same green, same reason — but the override recorded nothing,
// so every surface rendered a bare pill for a source we had stopped being able to read.
//
// Driven through `fetchAllServices`, because the defect is in the ORCHESTRATOR: `fetchService` alone
// returns `unknown` and looks correct in isolation, which is why a per-service test cannot see this.
describe('#1268 — a probe-backed green records that the probe is what backed it', () => {
  /** characterai probing HEALTHY, as production does (HTTP 200, ~2.9s). Own fixture rather than the
   *  shared `probeFixture` helper, which is hard-wired to `claude`. */
  const healthyProbes = () => {
    const now = Date.now()
    return Array.from({ length: 8 }, (_, i) => ({
      t: new Date(now - (35 - i * 5) * 60_000).toISOString(),
      data: { characterai: { status: 200, rtt: 2883 } },
    }))
  }
  /** The blob one strike short of the crossing, so this call is the third. */
  const crossing = () => ({ 'tracking:state': JSON.stringify({ characterai: { failCount: 2, failCountAt: new Date().toISOString() } }) })

  const publish = async (probes: ReturnType<typeof healthyProbes> | never[]) => {
    stubDeletedPage()
    const { raw } = await fetchAllServices(mockKV(crossing()) as never, probes as never)
    return raw.find((s) => s.id === 'characterai')!
  }

  it('overrides the unreadable-source verdict to operational, and marks it probeConfirmed', async () => {
    const svc = await publish(healthyProbes())
    expect({ status: svc.status, probeConfirmed: svc.probeConfirmed }).toEqual({ status: 'operational', probeConfirmed: true })
    // The override does not make the source readable — the ranking gate stays shut.
    expect(svc.incidentSourceStale).toBe(true)
  }, TEST_TIMEOUT_MS)

  it('control — with NO probe data the verdict stands as unknown and nothing is confirmed', async () => {
    // Also the reason this had to be tested here and not against a local dev worker: local KV holds no
    // `probe:24h`, so the whole cross-validation phase is skipped and the bug is invisible there.
    const svc = await publish([])
    expect({ status: svc.status, probeConfirmed: svc.probeConfirmed }).toEqual({ status: 'unknown', probeConfirmed: undefined })
  }, TEST_TIMEOUT_MS)

  it('control — an UNHEALTHY probe neither overrides the verdict nor marks it confirmed', async () => {
    // The control that matters: the other two cases pass because the Phase-1 loop never runs at all
    // (empty `degradedFromFetch`, or no probe snapshots), so they cannot see a mark hoisted above the
    // `isProbeHealthy` check INSIDE the loop. This one enters the loop and takes a different arm.
    // The reason is the flag's own truth, not a rendered consequence: a provenance field that says "a
    // healthy probe confirms reachability" must not travel beside a probe that is failing.
    stubDeletedPage()
    const now = Date.now()
    const failing = Array.from({ length: 8 }, (_, i) => ({
      t: new Date(now - (35 - i * 5) * 60_000).toISOString(),
      data: { characterai: { status: 503, rtt: 2883 } },
    }))
    const { raw } = await fetchAllServices(mockKV(crossing()) as never, failing as never)
    const svc = raw.find((s) => s.id === 'characterai')!
    expect(svc.probeConfirmed).toBeUndefined()
    expect(svc.status).not.toBe('operational')
  }, TEST_TIMEOUT_MS)

  it('control — a readable page with the same healthy probe is not marked (no over-application)', async () => {
    stubHealthyPage(characterai.statusComponentId!)
    const { raw } = await fetchAllServices(mockKV(crossing()) as never, healthyProbes() as never)
    const svc = raw.find((s) => s.id === 'characterai')!
    expect(svc.probeConfirmed).toBeUndefined()
  }, TEST_TIMEOUT_MS)
})

// ── The CLASS, not the instance ───────────────────────────────────────────────────────────────────
//
// #1268 round 2 — the first cut set `incidentSourceStale` on the one branch that produced the reported
// bug. That left the class open: `score.ts` reads the live `service.incidents` array and has no
// source-liveness input at all (grep it for `incidentSourceStale` — no hits), so EVERY return that
// publishes `incidents: []` because the read failed is scored as a clean 30-day window. Nine returns
// set `sourceUnknown`; one set the flag. The 5xx return sits a few branches above the one that was fixed, and
// the Instatus/OnlineOrNot parse-failure return carries services that rank in the HIGH-confidence table.
//
// So the flag is now tied to `sourceUnknown` at a choke point (`withUnreadFeedFlag`), and these tests
// drive the failure MODES rather than the branches — a new branch inherits the invariant for free.
describe('#1268 — every unread feed is flagged, whatever shape the failure took', () => {
  const modes: Array<[string, () => void]> = [
    ['a 5xx status page', () => vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 503 })))],
    ['a thrown fetch (TLS/connection)', () => vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Network connection lost.') }))],
    // The three below all answer 200 with VALID JSON, so nothing throws and the old SyntaxError test
    // waved them through — `resolveSvcStatus` then falls back to the `none` indicator and
    // `parseIncidents` returns [], i.e. a fabricated-operational verdict with an empty incident list.
    ['a JSON gateway error envelope', () => vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"Not Found"}', { status: 200 })))],
    ['an empty JSON object', () => vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))],
    ['a JSON null body', () => vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 200 })))],
  ]

  for (const [label, stub] of modes) {
    it(`flags ${label}`, async () => {
      stub()
      const svc = await fetchService(claudeai, undefined, undefined, crossed('claudeai'))
      expect(svc.incidents).toEqual([])
      expect(svc.incidentSourceStale, `${label} left an unread feed unflagged`).toBe(true)
    })
  }

  it('the 5xx case is the reported number, and it no longer ranks', async () => {
    // Not a generic assertion: 75 is the score the issue reports. `uptime30d` null -> `medium`
    // confidence -> (25 + 15 + probe)/60x100. The point is that this arrives from a DIFFERENT branch
    // than the deleted page, so fixing only that branch would have left the same 75 one 503 away.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 503 })))
    const svc = await fetchService(characterai, undefined, undefined, crossed('characterai'))
    expect(svc.incidentSourceStale).toBe(true)
    expect(hasReliableScoreData({ ...svc, scoreConfidence: 'medium', aiwatchScore: 75 })).toBe(false)
  })

  it('a readable page is never flagged — the invariant keys on the read, not on pessimism', async () => {
    stubHealthyPage(claudeai.statusComponentId!)
    const svc = await fetchService(claudeai, undefined, undefined, crossed('claudeai'))
    expect(svc.incidentSourceStale).toBeUndefined()
    expect(svc.sourceUnknown).toBeUndefined()
  })
})

describe('#1268 — withUnreadFeedFlag / isStatuspageSummary', () => {
  it('withUnreadFeedFlag sets the flag exactly when the source was unread', () => {
    type Flags = { sourceUnknown?: boolean; incidentSourceStale?: boolean; status?: string }
    expect(withUnreadFeedFlag<Flags>({ sourceUnknown: true, status: 'unknown' }).incidentSourceStale).toBe(true)
    // Strike 1: the read failed, but the verdict has not crossed — deliberately unflagged.
    expect(withUnreadFeedFlag<Flags>({ sourceUnknown: true, status: 'operational' }).incidentSourceStale).toBeUndefined()
    expect(withUnreadFeedFlag<Flags>({ sourceUnknown: false, status: 'unknown' }).incidentSourceStale).toBeUndefined()
    expect(withUnreadFeedFlag<Flags>({}).incidentSourceStale).toBeUndefined()
    // An already-flagged value is untouched (the choke point must be idempotent — it runs on every
    // return, including ones that set the flag from config).
    // Asserted as IDENTITY, not as the value: re-setting `true` to `true` is unobservable, so the
    // value form stayed green with the `!svc.incidentSourceStale` clause deleted.
    const alreadyFlagged: Flags = { sourceUnknown: true, status: 'unknown', incidentSourceStale: true }
    expect(withUnreadFeedFlag(alreadyFlagged)).toBe(alreadyFlagged)
  })

  it('withUnreadFeedFlag returns the SAME object when it changes nothing', () => {
    // So the choke point cannot silently break `fetchService`'s identity-preserving return.
    const svc = { sourceUnknown: false as const, status: 'operational' }
    expect(withUnreadFeedFlag(svc)).toBe(svc)
  })

  it('isStatuspageSummary accepts any documented top-level key and rejects non-payloads', () => {
    // Permissive on purpose: a provider adding or dropping ONE field must not make us call a live page
    // unreadable. incident.io global pages serve `{components: []}` through the v2 compat API, which is
    // why `components` alone has to be enough.
    for (const ok of [{ page: {} }, { status: {} }, { components: [] }, { incidents: [] }]) {
      expect(isStatuspageSummary(ok), JSON.stringify(ok)).toBe(true)
    }
    for (const bad of [null, undefined, 'a string', 42, [], {}, { message: 'Not Found' }]) {
      expect(isStatuspageSummary(bad), JSON.stringify(bad ?? null)).toBe(false)
    }
  })
})

// ── The path production actually takes ────────────────────────────────────────────────────────────
//
// #1268 round 3 — every test above calls `fetchService(cfg, undefined, …)`, i.e. the direct-fetch
// branch. `fetchAllServices` prefetches EVERY service that configures an `apiUrl`, so for an Atlassian
// service the `if (prefetched)` branch is what runs and the guarded `else` is the fallback. The suite
// was therefore structurally blind to the branch production uses, and the round-2 guard sat entirely in
// the branch it skips — `debugging_fix_the_called_path_not_the_tested_twin`.
//
// The deleted page survived only because an HTML body makes the prefetch's own `.json()` throw, so the
// entry is dropped and the direct fetch runs. A body that is valid JSON and merely is not a summary was
// cached and consumed as a real reading. Measured before the fix:
//   fetchService(…, undefined, …) with `{}`  ->  { status: 'operational', sourceUnknown: true, stale: true }
//   fetchAllServices           with `{}`  ->  { status: 'operational' }                    // no flags
describe('#1268 — the prefetched branch is guarded too', () => {
  const crossedKV = () => mockKV({ 'tracking:state': JSON.stringify(crossed('characterai')) })

  const viaOrchestrator = async (body: string) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))
    const { raw } = await fetchAllServices(crossedKV() as never, [])
    return raw.find((s) => s.id === 'characterai')!
  }

  it('a valid-JSON non-summary does not survive the prefetch', async () => {
    const svc = await viaOrchestrator('{}')
    expect({ sourceUnknown: svc.sourceUnknown, stale: svc.incidentSourceStale })
      .toEqual({ sourceUnknown: true, stale: true })
  }, TEST_TIMEOUT_MS)

  it('nor does a shape-valid gateway error envelope', async () => {
    // `{"status":"error"}` is the commonest JSON error-envelope shape there is, and a key-PRESENCE
    // predicate waved it through: `summaryData.status?.indicator` is undefined -> `normalizeStatus`
    // defaults to operational, `parseIncidents` -> []. A fabricated all-clear, from the code added to
    // prevent one.
    const svc = await viaOrchestrator('{"status":"error","message":"Not Found"}')
    expect({ sourceUnknown: svc.sourceUnknown, stale: svc.incidentSourceStale })
      .toEqual({ sourceUnknown: true, stale: true })
  }, TEST_TIMEOUT_MS)

  it('a real summary DOES survive the prefetch (the guard is not a blanket reject)', async () => {
    // The control that keeps the predicate honest: if it rejected real payloads, every service would
    // fall through to a direct re-fetch and the tests above would still pass.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('summary.json')) {
        return new Response(JSON.stringify({
          page: { id: 'p', name: 'Status', updated_at: new Date().toISOString() },
          status: { indicator: 'none', description: 'All Systems Operational' },
          components: [{ id: characterai.statusComponentId, name: 'Character.AI', status: 'operational' }],
          incidents: [],
        }), { status: 200 })
      }
      if (String(url).includes('incidents.json')) return new Response(JSON.stringify({ incidents: [] }), { status: 200 })
      return new Response('<html></html>', { status: 200 })
    }))
    const { raw } = await fetchAllServices(crossedKV() as never, [])
    const svc = raw.find((s) => s.id === 'characterai')!
    expect({ sourceUnknown: svc.sourceUnknown, stale: svc.incidentSourceStale })
      .toEqual({ sourceUnknown: undefined, stale: undefined })
  }, TEST_TIMEOUT_MS)
})

describe('#1268 — isStatuspageSummary rejects error envelopes by SHAPE', () => {
  // Key presence was not enough: each of these carries a documented top-level key with the wrong value.
  it.each([
    ['{"status":"error","message":"Not Found"}'],
    ['{"status":404}'],
    ['{"status":"ok"}'],
    ['{"page":null}'],
    ['{"components":null}'],
  ])('rejects %s', (body) => {
    expect(isStatuspageSummary(JSON.parse(body))).toBe(false)
  })

  it.each([
    ['{"page":{"id":"x"}}'],
    ['{"status":{"indicator":"none"}}'],
    ['{"components":[]}'],
    ['{"incidents":[]}'],
  ])('accepts %s', (body) => {
    expect(isStatuspageSummary(JSON.parse(body))).toBe(true)
  })
})

// ── incidents.json: an unreadable supplement must not destroy the readable summary ────────────────
//
// #1268 — this endpoint's contract IS its `incidents` array; summary.json carries only the ACTIVE ones
// (`fetchService`'s own note). A guard that accepted any object let an error envelope become
// `rawIncData`, which SKIPS the `parseIncidents(summaryData)` fallback — throwing away the active
// incidents summary.json had successfully returned. An empty list during a live outage: worse than the
// defect this issue is about, and self-identified in the comment with nothing pinning it.
//
// Both legs are covered because both parse this body: the prefetch (the path production takes) and the
// direct fetch (the fallback).
describe('#1268 — a readable summary survives an unreadable incidents.json', () => {
  const LIVE_INCIDENT = {
    id: 'inc-live', name: 'Elevated error rates', status: 'investigating', impact: 'major',
    created_at: new Date().toISOString(), started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), resolved_at: null, incident_updates: [],
  }
  /** summary.json is healthy AND carries a live incident; incidents.json answers 200 with `body`. */
  const stubSplit = (body: string) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('incidents.json')) return new Response(body, { status: 200 })
    if (String(url).includes('summary.json')) {
      return new Response(JSON.stringify({
        page: { id: 'p', name: 'Status', updated_at: new Date().toISOString() },
        status: { indicator: 'major', description: 'Partial System Outage' },
        components: [{ id: characterai.statusComponentId, name: 'Character.AI', status: 'major_outage' }],
        incidents: [LIVE_INCIDENT],
      }), { status: 200 })
    }
    return new Response('<html></html>', { status: 200 })
  }))

  it.each([
    ['a JSON error envelope', '{"message":"Not Found"}'],
    ['an object with no incidents array', '{"status":"error"}'],
    ['a bare JSON array', '[]'],
    ['an HTML body', '<html>nope</html>'],
  ])('keeps the live incident when incidents.json returns %s', async (_label, body) => {
    stubSplit(body)
    const svc = await fetchService(characterai, undefined, undefined, {})
    expect(svc.incidents.map((i) => i.id), 'the summary.json incident must survive').toContain('inc-live')
    // And it is NOT stale: the summary parsed, so the feed WAS read — incidents.json only widens it.
    expect(svc.incidentSourceStale).toBeUndefined()
  })

  it('the same holds through the prefetch, which parses this body independently', async () => {
    stubSplit('{"message":"Not Found"}')
    const { raw } = await fetchAllServices(mockKV() as never, [])
    const svc = raw.find((s) => s.id === 'characterai')!
    expect(svc.incidents.map((i) => i.id)).toContain('inc-live')
  }, TEST_TIMEOUT_MS)

  it('control — a well-formed incidents.json is still preferred over the summary list', async () => {
    // Without this the guard could reject everything and the tests above would pass for free, while the
    // service silently lost its full 30-day history (the part the Score actually consumes).
    stubSplit(JSON.stringify({ incidents: [LIVE_INCIDENT, { ...LIVE_INCIDENT, id: 'inc-old', status: 'resolved', resolved_at: new Date().toISOString() }] }))
    const svc = await fetchService(characterai, undefined, undefined, {})
    expect(svc.incidents.map((i) => i.id)).toContain('inc-old')
  })
})

// ── The two round-2/3 behaviours that were still unpinned ─────────────────────────────────────────
describe('#1268 — probeConfirmed stays a true provenance flag', () => {
  it('a READABLE page reporting degraded with no incident is not marked, even with a healthy probe', async () => {
    // `isReadSuspect` is `(unknown|degraded) && incidents.length === 0`, so a page we read perfectly
    // that reports `degraded` while naming no incident enters the Phase-1 loop too. Dropping the
    // `sourceUnknown` gate would put "a healthy probe confirms reachability despite an unreadable
    // source" on the wire for a source we read fine. No arm of the earlier controls can observe this:
    // one never enters the loop, the other takes the isProbeFailing branch.
    // Only claude.ai's page reports degraded; every other page is healthy. Answering degraded for ALL
    // of them trips `detectPlatformOutage`'s 70% quorum, which holds the whole roster operational and
    // the subject never reaches Phase 1 — the margin `HEALTHY_SUMMARY`'s comment in the shared helper
    // documents. The first version of this test did exactly that and passed vacuously.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('summary.json')) {
        const degraded = u.includes('status.claude.com')
        return new Response(JSON.stringify({
          page: { id: 'p', name: 'Status', updated_at: new Date().toISOString() },
          status: { indicator: degraded ? 'minor' : 'none', description: degraded ? 'Degraded Performance' : 'All Systems Operational' },
          components: degraded ? [{ id: claudeai.statusComponentId, name: 'claude.ai', status: 'degraded_performance' }] : [],
          incidents: [],
        }), { status: 200 })
      }
      if (u.includes('incidents.json')) return new Response(JSON.stringify({ incidents: [] }), { status: 200 })
      return new Response('<html></html>', { status: 200 })
    }))
    const now = Date.now()
    const healthy = Array.from({ length: 8 }, (_, i) => ({
      t: new Date(now - (35 - i * 5) * 60_000).toISOString(),
      data: { claudeai: { status: 200, rtt: 120 } },
    }))
    const { raw } = await fetchAllServices(mockKV() as never, healthy as never)
    const svc = raw.find((s) => s.id === 'claudeai')!
    // Premise, asserted rather than assumed: the earlier controls passed because their fixture never
    // entered the loop at all, which is the vacuity this test exists to avoid repeating.
    expect(svc.status, 'premise: the page reported degraded and we read it').toBe('operational')
    expect(svc.sourceUnknown, 'premise: this page was read fine').toBeUndefined()
    expect(svc.incidents.length, 'premise: no incident named').toBe(0)
    expect(svc.probeConfirmed).toBeUndefined()
  }, TEST_TIMEOUT_MS)
})

// ── The widest failure path of all ────────────────────────────────────────────────────────────────
//
// #1268 — when the batch loop itself throws, `fetchAllServices` builds a stand-in literal for every
// service left. This block previously carried a comment claiming the literal was "not reachable from a
// test" because `fetchService` catches everything internally and its promise never rejects. The
// mechanism half was right; the conclusion was wrong, and it was an unverified claim about testability
// sitting where it would guide the next edit. The loop's own `Promise.allSettled` is a spy-able global.
//
// Worth knowing what this path looks like: the fill-in fires for the WHOLE roster at once, so
// `detectPlatformOutage`'s 70% quorum trips immediately and flips the Atlassian services back to
// `operational`. The badge goes green across the board, and `incidentSourceStale` is the only thing
// between that and a full-roster fabricated ranking — which is the argument for making it unconditional
// here rather than inheriting the config flag.
describe('#1268 — the fetchAllServices fill-in literal', () => {
  it('is stale regardless of config, because it stands in for a result nobody got', async () => {
    const realAllSettled = Promise.allSettled.bind(Promise)
    let calls = 0
    // `services.ts` has exactly ONE `Promise.allSettled` — the batch loop — and the roster spans
    // several batches. Letting the first resolve and faulting the second exercises the fill-in for the
    // remaining services while the earlier ones return normally, which is the real shape.
    vi.spyOn(Promise, 'allSettled').mockImplementation(((arr: never) =>
      ++calls >= 2 ? Promise.reject(new Error('batch loop blew up')) : realAllSettled(arr)) as never)
    try {
      stubDeletedPage()
      const { raw } = await fetchAllServices(mockKV() as never, [])
      // `claudeai` carries NO config `incidentSourceStale`, which is what makes this discriminate:
      // reverting to the old config-conditional spread leaves it unflagged.
      const svc = raw.find((s) => s.id === 'claudeai')!
      expect(svc.sourceUnknown, 'premise: this is the stand-in literal').toBe(true)
      expect(svc.incidentSourceStale).toBe(true)
      // Deliberately NOT asserting `status: 'unknown'` — see the quorum note above; it is `operational`
      // here, and that is exactly why the flag has to carry the weight.
    } finally {
      vi.restoreAllMocks()
    }
  }, TEST_TIMEOUT_MS)
})
