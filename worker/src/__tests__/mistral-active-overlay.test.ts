import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchService, SERVICES } from '../services'
import { MISTRAL_ACTIVE_OVERLAY_KV_KEY, MISTRAL_OVERLAY_RESOLVED_KV_KEY, MISTRAL_PUBLIC_SAMPLE_KV_KEY } from '../mistral-public-api'
import { countsAsUptimeOk } from '../utils'
import { accumulateMonthlyIncidents } from '../monthly-archive'
import { mockKV } from './helpers/unreadable-source'
import type { Incident } from '../types'

// #1510 Slice 2 — the WIRING half, mirroring `rootly-feed-wiring.test.ts`'s pattern for the scrape
// feed (`grep -n "fetchService reads the Rootly feed" worker/src/__tests__/rootly-feed-wiring.test.ts`).
// Drives the real `fetchService` entry point: config → KV read → filterIncidents →
// worstUnresolvedImpact → badge.

const mistral = SERVICES.find((s) => s.id === 'mistral')!

function incident(over: Partial<Incident> = {}): Incident {
  return {
    id: 'inc-1',
    title: 'Elevated error rates on Mistral Small 4',
    status: 'investigating',
    impact: 'critical',
    startedAt: '2026-09-29T12:48:01.000Z',
    resolvedAt: null,
    duration: null,
    timeline: [],
    ...over,
  }
}

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-09-29T13:00:00Z'), toFake: ['Date'] }))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('#1510 Slice 2 — fetchService overlays status from the active-incident KV when the scrape feed is absent', () => {
  it('critical impact raises the badge to down', async () => {
    const kv = mockKV({ [MISTRAL_ACTIVE_OVERLAY_KV_KEY]: JSON.stringify([incident({ impact: 'critical' })]) })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('down')
    expect(svc.incidents.map((i) => i.id)).toEqual(['inc-1'])
    // Round 7 review finding: `liveIncidentsActiveOnly` (worker/src/types.ts) is what
    // `prunePhantomIncidents` (#975, monthly-archive.ts) reads to avoid a false withdrawal for an
    // incident that merely resolved upstream — the round-6 test for THAT only built the flag by hand
    // via a fixture, never asserting `fetchService` actually sets it on the real overlay return path.
    expect(svc.liveIncidentsActiveOnly).toBe(true)
  })

  it('consequence worth stating: a critical overlay counts as a real outage for the daily uptime/Score counter — the absent-feed state was always `unknown` before (an "ok" sample, `grep -n countsAsUptimeOk worker/src/utils.ts`), so this is the first time Mistral can produce a genuine "down" uptime sample while its scrape feed is absent', async () => {
    const kv = mockKV({ [MISTRAL_ACTIVE_OVERLAY_KV_KEY]: JSON.stringify([incident({ impact: 'critical' })]) })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(countsAsUptimeOk(svc.status, svc.incidents)).toBe(false)
  })

  it('major impact also raises the badge to down', async () => {
    const kv = mockKV({ [MISTRAL_ACTIVE_OVERLAY_KV_KEY]: JSON.stringify([incident({ impact: 'major' })]) })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('down')
  })

  it('minor impact degrades, not downs', async () => {
    const kv = mockKV({ [MISTRAL_ACTIVE_OVERLAY_KV_KEY]: JSON.stringify([incident({ impact: 'minor' })]) })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('degraded')
  })

  it('impact none/null does not raise the status — stays unknown, never operational (#1233)', async () => {
    const kv = mockKV({ [MISTRAL_ACTIVE_OVERLAY_KV_KEY]: JSON.stringify([incident({ impact: null })]) })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('unknown')
  })

  it('an empty active-incident list stays unknown, never operational (#1233)', async () => {
    const kv = mockKV({ [MISTRAL_ACTIVE_OVERLAY_KV_KEY]: '[]' })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('unknown')
  })

  it('an absent overlay key (same as absent feed, pre-#1510) still publishes unknown without throwing', async () => {
    const kv = mockKV()
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('unknown')
    expect(svc.sourceUnknown).toBe(true)
  })

  it('a resolved incident does not raise the status — only UNRESOLVED incidents count', async () => {
    const kv = mockKV({
      [MISTRAL_ACTIVE_OVERLAY_KV_KEY]: JSON.stringify([
        incident({ impact: 'critical', status: 'resolved', resolvedAt: '2026-09-29T12:50:00.000Z' }),
      ]),
    })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('unknown')
  })

  it('a title matching incidentExclude (e.g. Vibe) is filtered out before the impact is read — the #1481 guard applies here too', async () => {
    const kv = mockKV({
      [MISTRAL_ACTIVE_OVERLAY_KV_KEY]: JSON.stringify([
        incident({ id: 'vibe-1', title: 'Vibe Code Web is unable to provision a sandbox', impact: 'critical' }),
      ]),
    })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('unknown')
    expect(svc.incidents).toEqual([])
  })

  it('a corrupt overlay value falls through to unknown instead of throwing', async () => {
    const kv = mockKV({ [MISTRAL_ACTIVE_OVERLAY_KV_KEY]: '{not json' })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('unknown')
  })

  it('a malformed element (hand edit, older/future writer) is dropped, not trusted into filterIncidents', async () => {
    // Round 1 review finding: an unvalidated element with no `title` threw inside `filterIncidents`,
    // and the throw was caught upstream as a transient fetch failure — which can publish a green
    // `operational` pill for a feed-ONLY service instead of `unknown`.
    const kv = mockKV({ [MISTRAL_ACTIVE_OVERLAY_KV_KEY]: JSON.stringify([{ id: 'x' }]) })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('unknown')
    expect(svc.incidents).toEqual([])
  })

  it('a mix of one malformed and one valid element keeps the valid one', async () => {
    const kv = mockKV({
      [MISTRAL_ACTIVE_OVERLAY_KV_KEY]: JSON.stringify([{ id: 'x' }, incident({ impact: 'critical' })]),
    })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('down')
    expect(svc.incidents.map((i) => i.id)).toEqual(['inc-1'])
  })

  it('a live scrape feed (mistral:feed) takes priority — the overlay is never consulted', async () => {
    const kv = mockKV({
      'mistral:feed': JSON.stringify({
        fetchedAt: new Date().toISOString(),
        feed: {
          fetchedAt: new Date().toISOString(),
          components: mistral.displayComponentIds!.map((id) => ({ id, name: `Component ${id.slice(0, 4)}`, status: 'Operational' })),
          incidents: [],
          coverage: { listed: 0, fetched: 0 },
          uptime: mistral.displayComponentIds!.map((id) => ({ componentId: id, barCount: 91, unreadBars: 0, coverage: { impacted: 0, fetched: 0 }, days: [] })),
        },
      }),
      // A critical active incident sitting in the overlay — must be ignored while the feed is fresh.
      [MISTRAL_ACTIVE_OVERLAY_KV_KEY]: JSON.stringify([incident({ impact: 'critical' })]),
    })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('operational')
    // A readable scrape feed's live list DOES include recently-resolved entries (`grep -n
    // "normalizeRootlyIncidents" worker/src/parsers/rootly.ts`), so it is never active-only — the
    // flag must not leak onto this path.
    expect(svc.liveIncidentsActiveOnly).toBeUndefined()
  })

  // #1510 Slice 2's required pin: a page-wide `status.json` indicator must never reach the badge.
  // Seeds an AGGRESSIVE indicator (major) on `mistral:public-sample` — a key `readMistralActiveOverlay`
  // does not read today — alongside a null-impact active-incident list, so a future change that starts
  // threading that indicator into the overlay (the exact regression #1510 rules out) turns this red.
  it('no page-wide indicator can reach the badge — only a specific incident impact can', async () => {
    // `mistral:public-sample` only ever carries the shape `recordPublicApiSample` actually writes
    // (`grep -n "listsAnIncident" worker/src/mistral-public-api.ts`: it skips unless an incident is
    // LISTED), so this fixture lists one — with impact `null`, same as the active-overlay incident.
    const kv = mockKV({
      [MISTRAL_ACTIVE_OVERLAY_KV_KEY]: JSON.stringify([incident({ impact: null, status: 'monitoring' })]),
      [MISTRAL_PUBLIC_SAMPLE_KV_KEY]: JSON.stringify({
        capturedAt: '2026-09-29T13:00:00.000Z',
        statusJson: JSON.stringify({ status: { indicator: 'major' }, incidents: [{ impact: null }] }),
        incidentsJson: JSON.stringify({ incidents: [{ impact: null }] }),
      }),
    })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('unknown')
  })

  // #1510's own "Known limit" (`grep -n "KNOWN LIMIT" worker/src/services.ts`): Rootly's public
  // incident schema carries no component field, so `filterIncidents`' title-only `incidentExclude`
  // cannot tell a title naming no excluded surface from one whose BODY affects only a non-API
  // surface — pinned here against the real 2026-09-29 incident, accepted rather than fixed.
  it('a critical incident with a generic title still raises the badge, even when its body names only non-API surfaces — known limit, see services.ts', async () => {
    const kv = mockKV({
      [MISTRAL_ACTIVE_OVERLAY_KV_KEY]: JSON.stringify([{
        id: 'fcc64184-7c9a-45d8-9fb4-e2c862f7e195',
        title: 'Elevated error rate on some of our services',
        status: 'monitoring',
        impact: 'critical',
        startedAt: '2026-09-29T12:48:01.000Z',
        resolvedAt: null,
        duration: null,
        timeline: [{ stage: 'investigating', text: 'We identified an elevated error rate on some of our surfaces (Vibe, Studio, Settings page). Investigations are ongoing', at: '2026-09-29T12:54:01.000Z' }],
      }]),
    })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('down')
  })
})

// #1510 Part E — the 2026-10-23 shape: the overlay published an incident, it left `incidents.json`, and
// the card dropped it with no end recorded.
describe('#1510 Part E — fetchService publishes overlay-resolved incidents while the scrape feed is absent', () => {
  const ended = incident({ id: 'ended', impact: 'minor', status: 'resolved', resolvedAt: null, duration: null })
  const stored = (...incidents: unknown[]) => JSON.stringify(incidents.map((i) => ({ incident: i, endSeenAt: '2026-09-29T12:58:00.000Z' })))

  it('with no active incident: stays unknown and lists the resolved incident', async () => {
    const kv = mockKV({ [MISTRAL_ACTIVE_OVERLAY_KV_KEY]: '[]', [MISTRAL_OVERLAY_RESOLVED_KV_KEY]: stored(ended) })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('unknown')
    expect(svc.sourceUnknown).toBe(true)
    expect(svc.incidents).toEqual([ended])
    expect(svc.liveIncidentsActiveOnly).toBe(true)
  })

  it('with the active key expired too: still lists the resolved incident', async () => {
    const kv = mockKV({ [MISTRAL_OVERLAY_RESOLVED_KV_KEY]: stored(ended) })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('unknown')
    expect(svc.incidents.map((i) => i.id)).toEqual(['ended'])
  })

  it('with an active incident: the badge comes from the active one, and both are listed', async () => {
    const kv = mockKV({ [MISTRAL_ACTIVE_OVERLAY_KV_KEY]: JSON.stringify([incident({ impact: 'critical' })]), [MISTRAL_OVERLAY_RESOLVED_KV_KEY]: stored(ended) })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('down')
    expect(svc.incidents.map((i) => i.id)).toEqual(['inc-1', 'ended'])
  })

  it('an id that is active again is listed once, as active', async () => {
    const kv = mockKV({ [MISTRAL_ACTIVE_OVERLAY_KV_KEY]: JSON.stringify([incident({ id: 'ended', impact: 'minor' })]), [MISTRAL_OVERLAY_RESOLVED_KV_KEY]: stored(ended) })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.incidents).toHaveLength(1)
    expect(svc.incidents[0].status).toBe('investigating')
  })

  it('an entry in the resolved list that is not resolved is not listed', async () => {
    const kv = mockKV({ [MISTRAL_OVERLAY_RESOLVED_KV_KEY]: stored({ ...ended, status: 'investigating' }) })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('unknown')
    expect(svc.incidents).toEqual([])
  })

  it('a malformed stored resolved entry is dropped, not trusted into filterIncidents', async () => {
    const kv = mockKV({ [MISTRAL_OVERLAY_RESOLVED_KV_KEY]: JSON.stringify([{ incident: { ...ended, title: 42 }, endSeenAt: '2026-09-29T12:58:00.000Z' }, { incident: ended }, { incident: ended, endSeenAt: 'x' }, ended, { incident: ended, endSeenAt: '2026-09-29T12:58:00.000Z' }]) })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('unknown')
    expect(svc.incidents.map((i) => i.id)).toEqual(['ended'])
  })

  it('a resolved incident whose title matches incidentExclude is not listed', async () => {
    const kv = mockKV({ [MISTRAL_OVERLAY_RESOLVED_KV_KEY]: stored({ ...ended, title: 'Vibe is down' }) })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.incidents).toEqual([])
  })

  it('a readable scrape feed takes priority — the resolved list is never consulted', async () => {
    const kv = mockKV({
      'mistral:feed': JSON.stringify({
        fetchedAt: new Date().toISOString(),
        feed: {
          fetchedAt: new Date().toISOString(),
          components: mistral.displayComponentIds!.map((id) => ({ id, name: `Component ${id.slice(0, 4)}`, status: 'Operational' })),
          incidents: [],
          coverage: { listed: 0, fetched: 0 },
          uptime: mistral.displayComponentIds!.map((id) => ({ componentId: id, barCount: 91, unreadBars: 0, coverage: { impacted: 0, fetched: 0 }, days: [] })),
        },
      }),
      [MISTRAL_OVERLAY_RESOLVED_KV_KEY]: stored(ended),
    })
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.incidents).toEqual([])
  })
})

describe('#1510 Part E — the monthly accumulator records the end, and the feed\'s later value wins', () => {
  const card = (incidents: Incident[]) => [{ id: 'mistral', name: 'Mistral API', provider: 'Mistral AI', category: 'api', status: 'unknown', latency: null, uptime30d: null, lastChecked: '2026-09-29T14:00:00.000Z', incidents }] as never

  it('monitoring (overlay) → resolved with no end (overlay) → resolved at the feed\'s own time', () => {
    const open = incident({ status: 'monitoring', impact: 'minor' })
    const overlayEnd = { ...open, status: 'resolved' as const, resolvedAt: null, duration: null }
    const feedEnd = { ...open, status: 'resolved' as const, resolvedAt: '2026-09-29T13:30:00.000Z', duration: '42m' }

    let acc = accumulateMonthlyIncidents(null, card([open]), '2026-09', null)
    expect(acc.services.mistral.incidents![0]).toMatchObject({ finalStatus: 'monitoring', resolvedAt: null, durationMin: 0 })

    acc = accumulateMonthlyIncidents(acc, card([overlayEnd]), '2026-09', null)
    expect(acc.services.mistral.incidents![0]).toMatchObject({ finalStatus: 'resolved', resolvedAt: null, durationMin: 0 })

    acc = accumulateMonthlyIncidents(acc, card([feedEnd]), '2026-09', null)
    expect(acc.services.mistral.incidents![0]).toMatchObject({ finalStatus: 'resolved', resolvedAt: '2026-09-29T13:30:00.000Z', durationMin: 42 })
    expect(acc.services.mistral.count).toBe(1)
  })
})
