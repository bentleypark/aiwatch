// #1125 — the #992 new-component detector must see the SAME component list the status path does, and
// must not ask the operator to "decide whether to track" something AIWatch already tracks.
//
// It did neither. `pageComponents` was built straight off `summary.json`'s components, but on
// `status.openai.com` (incident.io) summary.json serves only part of the page's components and which
// part rotates as the provider adds more (25 of the 34 in components.json when measured 2026-07-28).
// Two consequences, both observed:
//   • a component AIWatch ALREADY tracks false-alerts as new the moment it rotates into the window
//     (`Images` 2026-07-22, `Sora` 2026-07-27 — both in openai's statusComponentIds, asserted below), and
//   • a component that never enters the window can never alert at all — the miss the detector exists
//     to prevent, and one nothing would ever surface.
// The status path already knew (#606 Cat B `componentsUrl` → `pickBreakdownComponents`); only the
// detector was left on the narrow view. The fix routes both through that one precedence rule AND
// filters the alert against `TRACKED_COMPONENT_IDS`.
//
// The durable-KV blast radius is why the failure branches are tested as heavily as the happy path:
// what `buildPageComponents` returns is written to `component-seen:{apiUrl}`, a key with no TTL, and
// the detector fires once per component ever. Anything wrong that gets recorded stays wrong — but only
// the id/name validation guards that: a narrower list only DELAYS a correct alert (the filter means
// whatever it later reports is genuinely untracked), but an `undefined` id recorded as `null` can
// never be matched again, so it would alert every cron tick forever.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildPageComponents, fetchPageComponents, pickBreakdownComponents, fetchService, SERVICES, TRACKED_COMPONENT_IDS } from '../services'
import { diffPageComponents, partitionFirstSeen } from '../utils'
import { UPSTREAM_FEEDS } from '../upstream-feed'

const SERVICES_SRC = readFileSync(join(__dirname, '..', 'services.ts'), 'utf8')
const INDEX_SRC = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')

const OPENAI = SERVICES.find((s) => s.id === 'openai')!
const PAGE = OPENAI.apiUrl!
const OTHER_PAGE = 'https://status.claude.com/api/v2/summary.json'

const CHAT = '01JMXBRMFE6N2NNT7DG6XZQ6PW' // "Chat Completions" — openai's PRIMARY badge component
const SORA = '01K9G527YRPY1EFRMHTKB5BKT5' // "Sora"             — the 2026-07-27 false alert
const IMAGES = '01JMXBRMFE4MAP2BHSJNZ787WX' // "Images"         — the 2026-07-22 false alert
const UNTRACKED = 'zz-not-in-any-service-config' // a genuinely new, untracked component, in BOTH lists
const LATE = 'zz-untracked-and-superset-only' // untracked AND components.json-only: the delayed alert

const comp = (id: string, name: string, status = 'operational') => ({ id, name, status })

// summary.json's rotating view: Images rotated in, Chat Completions + Sora fell out.
const SUMMARY_SUBSET = [comp(IMAGES, 'Images'), comp(UNTRACKED, 'Ads API')]
// components.json: the superset.
const COMPONENTS_SUPERSET = [comp(CHAT, 'Chat Completions'), comp(SORA, 'Sora'), comp(IMAGES, 'Images'), comp(UNTRACKED, 'Ads API'), comp(LATE, 'Ads API v2')]

const ok = (components: unknown) => ({ ok: true as const, components })
const pageMap = (componentsFetch?: { ok: true; components: unknown } | { ok: false }) =>
  new Map([[PAGE, { summary: { components: SUMMARY_SUBSET }, componentsFetch }]])

/** The components of the one page under test. */
const comps = (map: Parameters<typeof buildPageComponents>[0]) => buildPageComponents(map)[PAGE]

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })
const warnText = () => warn.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')

// The ULID fixtures above are only meaningful if they really are ids AIWatch tracks — otherwise every
// "already tracked" assertion below is vacuous and would stay green if the config dropped them.
describe('fixture premises (#1125)', () => {
  it.each([['Chat Completions', CHAT], ['Sora', SORA], ['Images', IMAGES]])(
    '%s is a component openai badges AND displays', (_name, id) => {
      expect(OPENAI.statusComponentIds).toContain(id)
      expect(OPENAI.displayComponentIds).toContain(id)
      expect(TRACKED_COMPONENT_IDS.has(id)).toBe(true)
    })

  it.each([['in both lists', UNTRACKED], ['components.json-only', LATE]])(
    'the stand-in for a new component (%s) is tracked by NO service', (_label, id) => {
      expect(TRACKED_COMPONENT_IDS.has(id)).toBe(false)
    })
})

describe('buildPageComponents source precedence (#1125)', () => {
  it('serves the componentsUrl superset, not summary.json\'s subset', () => {
    const ids = comps(pageMap(ok(COMPONENTS_SUPERSET))).map((c) => c.id)
    // The two ids summary.json omitted this cycle are exactly what the old source could not see.
    expect(ids).toContain(CHAT)
    expect(ids).toContain(SORA)
    expect(ids).toHaveLength(5)
  })

  it('carries names through — the alert body names the component, not just its ULID', () => {
    expect(comps(pageMap(ok(COMPONENTS_SUPERSET)))).toContainEqual({ id: SORA, name: 'Sora' })
  })

  it('falls back to summary.json for a page that configures no componentsUrl', () => {
    // The normal case for 40+ pages — not a failure, and it must stay silent.
    expect(comps(pageMap(undefined)).map((c) => c.id)).toEqual([IMAGES, UNTRACKED])
    expect(warnText()).toBe('')
  })

  it.each([
    ['an empty array', ok([])],
    ['a value that survived extraction but is not an array', ok('oops')],
  ])('falls back to summary.json when components.json served %s', (_label, componentsFetch) => {
    // Costs delay, not correctness: whatever a narrower list later reports as new is filtered against
    // TRACKED_COMPONENT_IDS, so it can only ever be a component AIWatch genuinely does not track.
    expect(comps(pageMap(componentsFetch)).map((c) => c.id)).toEqual([IMAGES, UNTRACKED])
  })

  it('keeps every page separate — one page\'s components never leak into another', () => {
    const map = new Map<string, { summary?: { components?: Array<{ id: string; name: string; status: string }> }; componentsFetch?: { ok: true; components: unknown } | { ok: false } }>([
      [PAGE, { summary: { components: SUMMARY_SUBSET }, componentsFetch: ok(COMPONENTS_SUPERSET) }],
      [OTHER_PAGE, { summary: { components: [comp('k8w3r06qmzrp', 'Claude API')] } }],
    ])
    const out = buildPageComponents(map)
    expect(Object.keys(out).sort()).toEqual([PAGE, OTHER_PAGE].sort())
    expect(out[PAGE]).toHaveLength(5)
    expect(out[OTHER_PAGE]).toEqual([{ id: 'k8w3r06qmzrp', name: 'Claude API' }])
  })


  it('omits a page that carries no components at all — absent ≠ emptied', () => {
    // The detector iterates this record, so an omitted page is skipped for the cycle, not diffed.
    expect(buildPageComponents(new Map([[PAGE, { summary: { components: [] } }]]))).toEqual({})
    expect(buildPageComponents(new Map([[PAGE, {}]]))).toEqual({})
  })
})

describe('buildPageComponents drops entries it cannot record (#1125)', () => {
  it.each([
    ['an id under a renamed key', [{ component_id: 'X', name: 'Renamed' }]],
    ['a non-string id', [{ id: 42, name: 'Numeric' }]],
    ['an empty id', [{ id: '', name: 'Blank' }]],
    ['a missing name', [{ id: 'ok-id' }]],
    ['a bare string entry', ['just-an-id']],
  ])('drops an entry with %s rather than recording it', (_label, payload) => {
    // JSON.stringify writes an undefined id as null, which no later seen.has() can match — so recording
    // one would turn "fires once, ever" into an alert every cron tick, naming `undefined`. A DROPPED
    // entry is simply not "seen": it alerts once, correctly, when the payload shape recovers.
    // Nothing in components.json is recordable here, so the page falls back to summary.json's list
    // rather than dropping out of the detector entirely (that list was well-formed the whole time).
    expect(comps(pageMap(ok(payload))).map((c) => c.id)).toEqual([IMAGES, UNTRACKED])
    expect(warnText()).toContain('without a string id/name')
    expect(warnText()).toContain('none recordable — falling back to summary.json')
  })

  it('never claims a components.json fallback for a page that has no components.json', () => {
    // The list already WAS summary.json's, so re-validating it changes nothing and the fallback line
    // would assert a source that was never read — the "log asserts something untrue" class.
    const summaryOnly = new Map([[PAGE, { summary: { components: [{ id: 42, name: 'Numeric' }] as never } }]])
    expect(buildPageComponents(summaryOnly)).toEqual({})
    expect(warnText()).toContain('without a string id/name')
    expect(warnText()).not.toContain('falling back to summary.json')
  })

  it('drops the page only when the summary fallback is ALSO unusable', () => {
    // The fallback needs something to fall back TO. With no summary list the page is genuinely
    // unrecordable this cycle, and an absent page is simply skipped (not diffed) by the detector.
    const noSummary = new Map([[PAGE, { summary: { components: [] }, componentsFetch: ok([{ id: 42, name: 'Numeric' }]) }]])
    expect(buildPageComponents(noSummary)).toEqual({})
  })

  it('names what it dropped — this warn is the only trace of a component the detector will never see', () => {
    buildPageComponents(pageMap(ok([{ id: 42, name: 'Numeric' }])))
    expect(warnText()).toContain('Numeric')
  })

  it('keeps the well-formed entries when only some are malformed', () => {
    const mixed = [comp(CHAT, 'Chat Completions'), { id: 42, name: 'Numeric' }]
    expect(comps(pageMap(ok(mixed)))).toEqual([{ id: CHAT, name: 'Chat Completions' }])
  })

  it('is silent on a fully well-formed page — the warning must mean something', () => {
    comps(pageMap(ok(COMPONENTS_SUPERSET)))
    expect(warnText()).toBe('')
  })
})

// The function whose entire purpose is observability: four failure branches, each of which silently
// reverts #1125 (the detector drops to summary.json's narrower list) if it stops logging.
describe('fetchPageComponents outcomes (#1125)', () => {
  const URL = 'https://status.openai.com/api/v2/components.json'
  const stub = (impl: (url: string) => Promise<Response>) => vi.stubGlobal('fetch', vi.fn(impl))

  it('reads a non-empty array as ok', async () => {
    stub(async () => new Response(JSON.stringify({ components: COMPONENTS_SUPERSET }), { status: 200 }))
    expect(await fetchPageComponents(URL)).toEqual({ ok: true, components: COMPONENTS_SUPERSET })
    expect(warnText()).toBe('')
  })

  it.each([
    ['the fetch rejects', async () => { throw new Error('boom') }, 'fetch failed'],
    ['the response is not ok', async () => new Response('', { status: 503 }), 'HTTP 503'],
    ['the body is not JSON', async () => new Response('<html>nope</html>', { status: 200 }), 'parse failed'],
    ['the payload carries no components array', async () => new Response(JSON.stringify({ page: {} }), { status: 200 }), 'no components array'],
    ['the payload carries an EMPTY array', async () => new Response(JSON.stringify({ components: [] }), { status: 200 }), 'an EMPTY array'],
  ])('reports not-ok AND warns when %s', async (_label, impl, expected) => {
    stub(impl as (url: string) => Promise<Response>)
    expect(await fetchPageComponents(URL)).toEqual({ ok: false })
    expect(warnText()).toContain(expected)
  })
})

describe('the false alerts this fixes, end to end (#1125)', () => {
  // `seen` as it stands once the page has been watched a full cycle under the FIXED source.
  const seenFull = COMPONENTS_SUPERSET.map((c) => c.id)
  const current = () => comps(pageMap(ok(COMPONENTS_SUPERSET)))

  it('an already-tracked component rotating into summary.json no longer reads as new', () => {
    expect(diffPageComponents(current(), seenFull).newComponents).toEqual([])
  })

  it('the narrow source WOULD have flagged it — the defect itself, replayed through the real fn', () => {
    // Both sides come from buildPageComponents, so this fails if either sourcing branch regresses:
    // `seen` from the summary-only page (what production accumulated), `current` from the superset.
    const seenNarrow = comps(pageMap(undefined)).map((c) => c.id)
    const flagged = diffPageComponents(current(), seenNarrow).newComponents
    expect(flagged.map((c) => c.id).sort()).toEqual([CHAT, SORA, LATE].sort())
    // …that is the burst the deploy would have produced. The filter absorbs every TRACKED one and
    // leaves only the component nobody has decided about yet.
    const { alertable, absorbed } = partitionFirstSeen(flagged, TRACKED_COMPONENT_IDS)
    expect(absorbed.map((c) => c.id).sort()).toEqual([CHAT, SORA].sort())
    expect(alertable.map((c) => c.id)).toEqual([LATE])
  })

  it('a GENUINELY new, untracked component still alerts — the fix must not mute the detector', () => {
    const seenBefore = seenFull.filter((id) => id !== UNTRACKED)
    const flagged = diffPageComponents(current(), seenBefore).newComponents
    expect(partitionFirstSeen(flagged, TRACKED_COMPONENT_IDS).alertable).toEqual([{ id: UNTRACKED, name: 'Ads API' }])
  })

  it('a new component OUTSIDE summary.json\'s window now reaches the detector at all (the silent miss)', () => {
    const seenBefore = seenFull.filter((id) => id !== CHAT)
    expect(diffPageComponents(current(), seenBefore).newComponents.map((c) => c.id)).toEqual([CHAT])
  })

  it('DELAY, not silence: a component the narrow list missed still alerts once the source widens', () => {
    // This is the claim the whole design rests on — that dropping every degraded/deferral mechanism
    // costs only lateness. Cycle 1 runs on summary.json's window (components.json unreadable) and
    // records what it saw; cycle 2 reads the superset and must ALERT on the untracked component that
    // was invisible in cycle 1. If this ever fails, a narrow list means a permanent miss, and the
    // justification for deleting those mechanisms is gone with it.
    const cycle1 = comps(pageMap({ ok: false }))
    expect(cycle1.map((c) => c.id)).not.toContain(LATE)
    const { nextSeen } = diffPageComponents(cycle1, null) // bootstrap off the narrow list
    const { alertable } = partitionFirstSeen(diffPageComponents(current(), nextSeen).newComponents, TRACKED_COMPONENT_IDS)
    expect(alertable).toEqual([{ id: LATE, name: 'Ads API v2' }])
  })
})

describe('partitionFirstSeen (#1125)', () => {
  it('drops every id AIWatch already reads, keeps the rest', () => {
    const flagged = [{ id: CHAT, name: 'Chat Completions' }, { id: UNTRACKED, name: 'Ads API' }]
    const { alertable, absorbed } = partitionFirstSeen(flagged, TRACKED_COMPONENT_IDS)
    expect(alertable).toEqual([{ id: UNTRACKED, name: 'Ads API' }])
    expect(absorbed).toEqual([{ id: CHAT, name: 'Chat Completions' }])
  })

  it('leaves nothing to alert when every first-seen component is tracked — the deploy burst', () => {
    const burst = [{ id: CHAT, name: 'Chat Completions' }, { id: SORA, name: 'Sora' }, { id: IMAGES, name: 'Images' }]
    expect(partitionFirstSeen(burst, TRACKED_COMPONENT_IDS).alertable).toEqual([])
  })

  // Per FIELD, assert the set is a SUPERSET of everything that field contributes across all SERVICES.
  // Picking one representative id each is what let two of these pass while their spread was deleted:
  // openai's primary ULID is simultaneously its statusComponentId, a statusComponentIds member, a
  // displayComponentIds member AND its incidentIoComponentId, so it proves nothing about any of them.
  // A superset assertion cannot go stale as config moves between fields.
  it.each([
    ['statusComponentId', (s: typeof SERVICES[number]) => s.statusComponentId ? [s.statusComponentId] : []],
    ['statusComponentIds', (s: typeof SERVICES[number]) => s.statusComponentIds ?? []],
    ['displayComponentIds', (s: typeof SERVICES[number]) => s.displayComponentIds ?? []],
    ['incidentIoComponentId', (s: typeof SERVICES[number]) => {
      const c = s.incidentIoComponentId
      return Array.isArray(c) ? c : c ? [c] : []
    }],
    ['incidentIoGroupId', (s: typeof SERVICES[number]) => s.incidentIoGroupId ? [s.incidentIoGroupId] : []],
  ])('includes every id contributed by %s', (field, pick) => {
    const ids = SERVICES.flatMap(pick)
    expect(ids.length, `no service configures ${field} — the assertion would be vacuous`).toBeGreaterThan(0)
    for (const id of ids) expect(TRACKED_COMPONENT_IDS.has(id), `${field}: ${id}`).toBe(true)
  })

  it('includes every id contributed by UPSTREAM_FEEDS (#1072, non-carded)', () => {
    const ids = UPSTREAM_FEEDS.flatMap((f) => f.componentIds)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(TRACKED_COMPONENT_IDS.has(id), id).toBe(true)
  })
})

describe('fetchService reuses the prefetched components (#1125)', () => {
  const summary = {
    status: { indicator: 'none', description: 'All Systems Operational' },
    components: SUMMARY_SUBSET,
    incidents: [],
  }
  const componentsCalls = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((c) => String(c[0]).includes('components.json'))

  const stubFetch = (componentsBody?: unknown) => {
    const spy = vi.fn(async (url: string) => {
      if (String(url).includes('components.json')) {
        return componentsBody === undefined
          ? new Response('', { status: 500 })
          : new Response(JSON.stringify({ components: componentsBody }), { status: 200 })
      }
      // The no-prefetch case fetches summary.json (and incidents.json) itself, so both must parse.
      if (String(url).includes('summary.json')) return new Response(JSON.stringify(summary), { status: 200 })
      if (String(url).endsWith('.json')) return new Response(JSON.stringify({ incidents: [] }), { status: 200 })
      return new Response('', { status: 200 })
    })
    vi.stubGlobal('fetch', spy)
    return spy
  }

  it('does NOT re-fetch components.json when the prefetch already read it', async () => {
    const spy = stubFetch()
    const svc = await fetchService(OPENAI, { summary: summary as never, incidents: null, latency: 100, componentsFetch: ok(COMPONENTS_SUPERSET) })
    expect(componentsCalls(spy)).toHaveLength(0)
    // …and the breakdown still resolves off the superset, so the saved fetch cost nothing.
    expect(svc.components?.map((c) => c.id)).toContain(SORA)
  })

  it('re-fetches when the prefetch could not read it — the badge must never ride the narrow list', async () => {
    const spy = stubFetch(COMPONENTS_SUPERSET)
    const svc = await fetchService(OPENAI, { summary: summary as never, incidents: null, latency: 100, componentsFetch: { ok: false } })
    expect(componentsCalls(spy)).toHaveLength(1)
    expect(svc.components?.map((c) => c.id)).toContain(SORA)
  })

  it('re-fetches when there is no prefetch entry for the page at all', async () => {
    const spy = stubFetch(COMPONENTS_SUPERSET)
    await fetchService(OPENAI, undefined)
    expect(componentsCalls(spy)).toHaveLength(1)
  })


})

describe('prefetch + alert wiring (#1125)', () => {
  // buildPageComponents and partitionFirstSeen being green proves nothing about whether production
  // calls them: the prefetch fetch and the cron's alert branch are not reachable from a unit test
  // without standing up 45 pages of network and the Workers cron entry point. #966/#1032 — a green
  // pure fn that production doesn't call is this repo's recurring shipped bug.
  it('fetchAllServices builds pageComponents through buildPageComponents', () => {
    expect(SERVICES_SRC).toMatch(/pageComponents\s*=\s*buildPageComponents\(prefetchMap\)/)
  })

  it('the prefetch reads a page\'s componentsUrl and stores the OUTCOME on the prefetch entry', () => {
    expect(SERVICES_SRC).toMatch(/const componentsFetch = componentsUrl \? fetchPageComponents\(componentsUrl\)/)
    expect(SERVICES_SRC).toMatch(/prefetchMap\.set\(apiUrl,\s*\{[^}]*componentsFetch: await componentsFetch[^}]*\}\)/)
  })

  it('starts that fetch OUTSIDE the summary/incidents Promise.all — latency must stay the page\'s own', () => {
    // Inside it, a slow components.json would inflate the published response time for every service
    // on the page; after it, it would serialize onto the prefetch every service waits on.
    const prefetchBody = SERVICES_SRC.slice(SERVICES_SRC.indexOf('const prefetchMap = new Map'))
    const started = prefetchBody.indexOf('fetchPageComponents(componentsUrl)')
    const awaited = prefetchBody.indexOf('const [summaryRes, incidentsRes] = await Promise.all')
    // Assert both are present before comparing: indexOf returns -1 for a missing anchor, and -1 is
    // less than any real offset — so a bare `<` would read "the call moved out of the prefetch
    // entirely" as a pass, which is how this test first shipped.
    expect(started, 'components fetch not started in the prefetch').toBeGreaterThan(-1)
    expect(awaited, 'summary/incidents Promise.all not found in the prefetch').toBeGreaterThan(-1)
    expect(started).toBeLessThan(awaited)
    // The other half, and the one that actually protects the number: `latency` is computed before the
    // components fetch is awaited. Move that await up and a slow components.json inflates the published
    // response time for every service on the page, without either anchor above moving.
    const measured = prefetchBody.indexOf('const latency = Date.now() - start')
    const consumed = prefetchBody.indexOf('await componentsFetch')
    expect(measured, 'latency measurement not found in the prefetch').toBeGreaterThan(-1)
    expect(consumed, 'components fetch never awaited in the prefetch').toBeGreaterThan(-1)
    expect(measured).toBeLessThan(consumed)
  })

  it('the cron filters the alert through partitionFirstSeen before sending', () => {
    expect(INDEX_SRC).toMatch(/const \{ alertable, absorbed \} = partitionFirstSeen\(newComponents, TRACKED_COMPONENT_IDS\)/)
    expect(INDEX_SRC).toMatch(/formatNewComponentAlert\([^;]*\balertable\b/)
  })

  it('records an all-already-tracked page — the UNION, not the old set — instead of re-evaluating forever', () => {
    // Persisting anything other than nextSeen (e.g. `seen`) would leave the branch recomputing and
    // re-writing the identical set every cron tick, which is what it exists to stop. The log follows
    // the write and is gated on it, so it can never claim a record that does not exist.
    const branch = INDEX_SRC.slice(INDEX_SRC.indexOf('if (alertable.length === 0)'), INDEX_SRC.indexOf('if (absorbed.length > 0)'))
    expect(branch).toMatch(/if \(await kvPut\(env\.STATUS_CACHE, `component-seen:\$\{apiUrl\}`, JSON\.stringify\(nextSeen\)\)\)/)
    expect(branch.indexOf('console.warn')).toBeGreaterThan(branch.indexOf('kvPut'))
  })

  it('names the components it absorbed — nothing else records what was silently suppressed', () => {
    const loop = INDEX_SRC.slice(INDEX_SRC.indexOf('const { alertable, absorbed }'), INDEX_SRC.indexOf('const pageSvcs'))
    expect(loop).toMatch(/absorbed\.map\(/)
  })


  it('at least one service configures a componentsUrl — otherwise the whole path is dead code', () => {
    expect(SERVICES.filter((s) => s.componentsUrl).length).toBeGreaterThan(0)
  })

  it('every componentsUrl on a shared page agrees — one fetch per page serves every service on it', () => {
    // The prefetch fetches ONE componentsUrl per apiUrl (first match). If two services sharing a page
    // pointed at different components.json URLs, the second would silently get the first's list.
    const byPage = new Map<string, Set<string>>()
    for (const s of SERVICES.filter((s) => s.componentsUrl && s.apiUrl)) {
      byPage.set(s.apiUrl!, (byPage.get(s.apiUrl!) ?? new Set()).add(s.componentsUrl!))
    }
    for (const [apiUrl, urls] of byPage) {
      expect(urls.size, `${apiUrl} has ${urls.size} distinct componentsUrl values`).toBe(1)
    }
  })
})
