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
import { computeIncidentIoUptime } from '../parsers/incident-io'
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
    const svc = await fetchService(OPENAI, { summary: summary as never, incidents: null, latency: 100, componentsFetch: ok(COMPONENTS_SUPERSET) }, undefined, {})
    expect(componentsCalls(spy)).toHaveLength(0)
    // …and the breakdown still resolves off the superset, so the saved fetch cost nothing.
    expect(svc.components?.map((c) => c.id)).toContain(SORA)
  })

  it('re-fetches when the prefetch could not read it — the badge must never ride the narrow list', async () => {
    const spy = stubFetch(COMPONENTS_SUPERSET)
    const svc = await fetchService(OPENAI, { summary: summary as never, incidents: null, latency: 100, componentsFetch: { ok: false } }, undefined, {})
    expect(componentsCalls(spy)).toHaveLength(1)
    expect(svc.components?.map((c) => c.id)).toContain(SORA)
  })

  it('re-fetches when there is no prefetch entry for the page at all', async () => {
    const spy = stubFetch(COMPONENTS_SUPERSET)
    await fetchService(OPENAI, undefined, undefined, {})
    expect(componentsCalls(spy)).toHaveLength(1)
  })


})

// #1175 — the same narrow view, one layer down: chatgpt badges a worst-of over its statusComponentIds
// but configured no componentsUrl, so it resolved them against summary.json's rotating window and
// `resolveSvcStatus` treats a partial resolve as the whole answer — an outage on one of the rest left
// the card green. These ride the REAL chatgpt config: drop its
// componentsUrl and 'reddens the card' below fails, as does the wiring guard further down.
describe('a badge component outside summary.json\'s window (#1175)', () => {
  const CHATGPT = SERVICES.find((s) => s.id === 'chatgpt')!
  const VOICE = '01JMXBNJXGGT5SR5DB9J7GYY48' // "Voice mode"
  // The ids summary.json's window omitted when measured live 2026-07-28. Names are irrelevant here —
  // every assertion below is on ids and statuses — so components carry their id as their name.
  const OUT_OF_WINDOW = new Set([VOICE, '01JSYVYQSWMJ9QG35XHP08BHA7', '01JQ7EKW990MSPSWVXC7VPV2ZJ', '01JMXBNJXG1YMQPPCPCQX3MPA2', '01JSG1XMJ9RVJJQ0E85NVSJ2AZ'])

  // components.json: every badged component, Voice mode down. summary.json: the same list minus the ones
  // the window omitted.
  const SUPERSET = CHATGPT.statusComponentIds!.map((id) => comp(id, id, id === VOICE ? 'major_outage' : 'operational'))
  const WINDOW = SUPERSET.filter((c) => !OUT_OF_WINDOW.has(c.id))
  const summary = { status: { indicator: 'none', description: 'All Systems Operational' }, components: WINDOW, incidents: [] }
  const prefetched = () => ({ summary: summary as never, incidents: null, latency: 100, componentsFetch: ok(SUPERSET) })

  let fetchSpy: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchSpy = vi.fn(async (url: string) => {
      if (String(url).includes('components.json')) return new Response('', { status: 500 })
      if (String(url).endsWith('.json')) return new Response(JSON.stringify({ incidents: [] }), { status: 200 })
      return new Response('', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('is one chatgpt badges but summary.json omitted — otherwise the fixture proves nothing', () => {
    expect(CHATGPT.statusComponentIds).toContain(VOICE)
    expect(WINDOW.map((c) => c.id)).not.toContain(VOICE)
    // Relational, not a headcount: adding a 13th component must not fail this on an unrelated change.
    expect(WINDOW.length).toBeGreaterThan(0)
    expect(WINDOW.length).toBeLessThan(SUPERSET.length)
  })

  it('reddens the card', async () => {
    const svc = await fetchService(CHATGPT, prefetched(), undefined, {})
    expect(svc.status).toBe('down')
  })

  it('and appears in the breakdown, and the per-cycle drift warns go silent', async () => {
    const svc = await fetchService(CHATGPT, prefetched(), undefined, {})
    expect(svc.components?.map((c) => c.id)).toEqual(CHATGPT.displayComponentIds)
    expect(svc.components).toContainEqual(expect.objectContaining({ id: VOICE, status: 'down' }))
    // The other half of the live evidence for this fix: pre-fix chatgpt emitted BOTH of these every
    // cycle, naming the 5 omitted ids. Scoped to the two strings — `fetchService` has other warn paths,
    // so asserting no warns at all would fail for unrelated reasons.
    expect(warnText()).not.toContain('chatgpt additional component ids missing')
    expect(warnText()).not.toContain('chatgpt displayComponentIds missing')
  })

  it('reaches the superset by REUSING the page prefetch, not by fetching components.json itself', async () => {
    const svc = await fetchService(CHATGPT, prefetched(), undefined, {})
    // Without the second assertion this passes VACUOUSLY under the config mutation: strip componentsUrl
    // and the fetch branch is never entered, so "0 fetches" is trivially true. The second pins that the
    // 0 was reached by REUSING the prefetch rather than by skipping the superset.
    expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes('components.json'))).toHaveLength(0)
    expect(svc.components).toHaveLength(CHATGPT.displayComponentIds!.length)
  })

  it('the defect replayed: without componentsUrl the identical outage leaves the card operational', async () => {
    // The paired direction. It strips ONLY componentsUrl and keeps the prefetched superset available, so
    // what it pins is that the config field is the gate.
    //
    // The page indicator says `major` here, unlike the other cases: that is the production symptom #1175
    // filed (provider reporting an outage, our card green) AND it discriminates this fix from the other
    // candidate — had `resolveSvcStatus` instead fallen back to the overall indicator on a PARTIAL
    // resolve, the card would read `down` and the bug would have been masked. With `indicator: 'none'`
    // no test can tell the two apart.
    const outageSummary = { ...summary, status: { indicator: 'major', description: 'Partial outage' } }
    const svc = await fetchService({ ...CHATGPT, componentsUrl: undefined }, { ...prefetched(), summary: outageSummary as never }, undefined, {})
    expect(svc.status).toBe('operational')
    expect(svc.components?.map((c) => c.id)).not.toContain(VOICE)
  })

  it('an unreadable components.json re-narrows the badge — the fix\'s failure mode', async () => {
    // With both the prefetch AND the per-service re-fetch failing there is no superset to read, so the
    // badge falls back to the window and #1175 returns for that cycle. Pinned because of HOW it degrades:
    // the #135 miss-check inspects only the primary, which resolves here, so THAT alert stays silent —
    // asserted in both directions below. #1179 added the operator path this case lacked (a durable
    // `component-partial:` record → Discord after 6h); it is covered in partial-component-resolve.test.ts,
    // and this test still pins that the #135 path is not the one that fires.
    const svc = await fetchService(CHATGPT, { ...prefetched(), componentsFetch: { ok: false } }, undefined, {})
    expect(svc.status).toBe('operational')
    // Scoped to the ONE warn: the display-drift warn below it names the same ids, so a joined-text match
    // would still pass if this warn stopped enumerating them.
    const drift = warn.mock.calls.map((c: unknown[]) => c.join(' ')).find((m: string) => m.includes('chatgpt additional component ids missing'))
    expect(drift).toBeDefined()
    expect(drift).toContain(VOICE)
    // Positive control for the OTHER negative in the breakdown test above: without it, renaming this
    // warn string turns that assertion into a vacuous pass with nothing failing.
    expect(warnText()).toContain('chatgpt displayComponentIds missing')
    expect(warnText()).not.toContain('Component ID not found: chatgpt')
  })

  it('…and the miss-check DOES fire when the PRIMARY is the one out of window — anchors the negative above', async () => {
    // Without this, renaming that warn string turns the assertion above into a vacuous pass with no test
    // failing: a negative string match defaults to true, so it needs a positive control on the same string.
    await fetchService({ ...CHATGPT, statusComponentId: VOICE }, { ...prefetched(), componentsFetch: { ok: false } }, undefined, {})
    expect(warnText()).toContain('Component ID not found: chatgpt')
  })
})

// #1010 — the layer under #1175 again, and the one no source-widening could reach: the component was
// absent from the CONFIG, not merely unresolvable from the narrow source, so an outage on it could not
// redden the ChatGPT card however well the page was read. Pinned in both directions (#1032
// convention): the outage reddens the card, and with that id removed from the config the identical
// outage leaves it operational — so a revert of the config line fails here rather than going quiet.
describe('an official ChatGPT-group component absent from the config (#1010)', () => {
  const CHATGPT = SERVICES.find((s) => s.id === 'chatgpt')!
  // Only the member actually adopted by #1010. Two group members are deliberately still
  // out (see the chatgpt config comment in services.ts); their absence is pinned in
  // status-determination.test.ts, which is where flipping them has to be noticed.
  const ADDED: [string, string][] = [
    ['Compliance API', '01JNKS9D9S72PMP1938PVFFQN4'],
  ]
  // Names are irrelevant to every assertion here (all are on ids and statuses), so each component
  // carries its id as its name — same convention as the #1175 fixture above.
  const page = (downId: string) =>
    CHATGPT.statusComponentIds!.map((id) => comp(id, id, id === downId ? 'major_outage' : 'operational'))
  const prefetched = (components: ReturnType<typeof page>) => ({
    summary: { status: { indicator: 'major', description: 'Partial outage' }, components, incidents: [] } as never,
    incidents: null,
    latency: 100,
    componentsFetch: ok(components),
  })

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).endsWith('.json')
        ? new Response(JSON.stringify({ incidents: [] }), { status: 200 })
        : new Response('', { status: 200 })))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it.each(ADDED)('%s is in the badge scope AND the breakdown — otherwise the pair below proves nothing', (_name, id) => {
    expect(CHATGPT.statusComponentIds).toContain(id)
    expect(CHATGPT.displayComponentIds).toContain(id)
  })

  it.each(ADDED)('an outage on %s reddens the ChatGPT card', async (_name, id) => {
    const svc = await fetchService(CHATGPT, prefetched(page(id)), undefined, {})
    expect(svc.status).toBe('down')
  })

  it.each(ADDED)('the defect replayed: with %s dropped from the config the identical outage leaves the card operational', async (_name, id) => {
    // Drops ONLY this id, so what it pins is that the config entry is the gate — the page still reports
    // the same outage, and the other badge ids still resolve, so `resolveSvcStatus` stays on its
    // worst-of branch instead of falling back to the page indicator (which would read `down` here).
    const cfg = {
      ...CHATGPT,
      statusComponentIds: CHATGPT.statusComponentIds!.filter((c) => c !== id),
      displayComponentIds: CHATGPT.displayComponentIds!.filter((c) => c !== id),
    }
    const svc = await fetchService(cfg, prefetched(page(id)), undefined, {})
    expect(svc.status).toBe('operational')
  })
})

// #1010 — the hold-out rationale, made executable. The chatgpt config declines two group members
// because badge scope IS uptime scope: `uptimeScope` (`services.ts`) reads `statusComponentIds`, and
// `computeIncidentIoUptime` worst-ofs the percentage and takes the SHORTEST covered window across it.
// Each `it` carries its own control on the SAME html, so neither
// can pass just because the fixture is clean.
describe('uptime is computed over the badge scope, not the primary alone (#1010/#1006)', () => {
  const CHATGPT = SERVICES.find((s) => s.id === 'chatgpt')!
  const PRIMARY = CHATGPT.incidentIoComponentId as string // "Conversations"
  const COMPLIANCE = '01JNKS9D9S72PMP1938PVFFQN4' // a NON-primary badge id, adopted by #1010
  const DAY = 86_400_000
  const now = Date.now()
  const iso = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString()

  // `component_uptimes` / `component_impacts` in the page's real backslash-escaped RSC form.
  const uptimeEntry = (id: string, sinceDaysAgo: number) =>
    `{\\"component_id\\":\\"${id}\\",\\"data_available_since\\":\\"${iso(sinceDaysAgo)}\\",` +
    `\\"status_page_component_group_id\\":\\"$undefined\\",\\"uptime\\":\\"$undefined\\"}`
  const impactEntry = (id: string, startDaysAgo: number, endDaysAgo: number, status: string) =>
    `{\\"component_id\\":\\"${id}\\",\\"end_at\\":\\"${iso(endDaysAgo)}\\",\\"id\\":\\"IMP\\",` +
    `\\"start_at\\":\\"${iso(startDaysAgo)}\\",\\"status\\":\\"${status}\\",\\"status_page_incident_id\\":\\"INC\\"}`
  const rsc = (impacts: string[], uptimes: string[]) =>
    `<script>self.__next_f.push([1,"a:{\\"component_impacts\\":[${impacts.join(',')}],` +
    `\\"component_uptimes\\":[${uptimes.join(',')}],\\"incident_links\\":[]}"])</script>`

  const allOperational = () => CHATGPT.statusComponentIds!.map((id) => comp(id, id))
  const withUptimeHtml = (uptimeHtml: string) => ({
    summary: { status: { indicator: 'none', description: 'All Systems Operational' }, components: allOperational(), incidents: [] } as never,
    incidents: null,
    latency: 100,
    componentsFetch: ok(allOperational()),
    uptimeHtml,
  })

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).endsWith('.json')
        ? new Response(JSON.stringify({ incidents: [] }), { status: 200 })
        : new Response('', { status: 200 })))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('a 24h outage on a NON-primary badge component moves uptime30d', async () => {
    const html = rsc(
      [impactEntry(COMPLIANCE, 5, 4, 'full_outage')],
      CHATGPT.statusComponentIds!.map((id) => uptimeEntry(id, 400)),
    )
    // Control on the SAME html: scoped to the primary alone the page reads a spotless 100, so the
    // figure below can only have come from the wider scope.
    expect(computeIncidentIoUptime(html, PRIMARY, now)!.pct).toBe(100)
    const svc = await fetchService(CHATGPT, withUptimeHtml(html), undefined, {})
    expect(svc.uptime30d).toBe(96.66)
  })

  it('a badge component with a short record shortens the disclosed window — the cost the hold-out declines', async () => {
    // Exactly the shape `Sites` / `ChatGPT Work` would create: one young member, every other one old.
    const html = rsc([], CHATGPT.statusComponentIds!.map((id) => uptimeEntry(id, id === COMPLIANCE ? 20 : 400)))
    expect(computeIncidentIoUptime(html, PRIMARY, now)!.days).toBe(30) // control: the primary alone is whole
    const svc = await fetchService(CHATGPT, withUptimeHtml(html), undefined, {})
    expect(svc.uptimeWindowDays).toBe(20)
  })

  // chatgpt cannot catch a swap to `displayComponentIds`: its two id lists are identical by design,
  // so both read the same scope. langfuse is where they differ — 3 `statusComponentIds` and NO
  // `displayComponentIds` — so under that swap its uptime falls back to the primary alone, which is
  // the #1006 defect on a second service. Driven from the real langfuse config for that reason.
  it('langfuse: the scope is `statusComponentIds` specifically, not whichever id list is to hand', async () => {
    const LANGFUSE = SERVICES.find((s) => s.id === 'langfuse')!
    const ids = LANGFUSE.statusComponentIds!
    expect(LANGFUSE.displayComponentIds).toBeUndefined() // the property that makes this case discriminating
    const nonPrimary = ids.find((id) => id !== LANGFUSE.incidentIoComponentId)!
    const html = rsc([impactEntry(nonPrimary, 5, 4, 'full_outage')], ids.map((id) => uptimeEntry(id, 400)))
    expect(computeIncidentIoUptime(html, LANGFUSE.incidentIoComponentId as string, now)!.pct).toBe(100)
    const components = ids.map((id) => comp(id, id))
    const svc = await fetchService(LANGFUSE, {
      summary: { status: { indicator: 'none', description: 'All Systems Operational' }, components, incidents: [] } as never,
      incidents: null,
      latency: 100,
      uptimeHtml: html,
    }, undefined, {})
    expect(svc.uptime30d).toBe(96.66)
  })

  // The FALLBACK arm of the same expression. `uptimeScope` is `statusComponentIds ?? incidentIoComponentId`,
  // while the Atlassian branch ~60 lines above reads `statusComponentIds ?? statusComponentId` — two
  // near-identical expressions one screen apart, so harmonising them looks like tidying. It is not: these
  // services set NO `statusComponentId`, so under that edit the scope resolves to `undefined`,
  // `computeIncidentIoUptime` matches nothing and returns null, and each card silently loses its headline
  // uptime AND (per #713) has its Score Uptime component withheld and rescaled. Derived from SERVICES
  // rather than listed, so a service that later drops its `statusComponentId` joins the guard by itself.
  const IO_PRIMARY_ONLY = SERVICES.filter((s) => s.incidentIoComponentId && !s.statusComponentId && !s.statusComponentIds)
  it('the guard below covers a non-empty set — an empty filter would pass vacuously', () => {
    expect(IO_PRIMARY_ONLY.length).toBeGreaterThan(0)
  })
  it.each(IO_PRIMARY_ONLY.map((s) => [s.id, s] as const))(
    '%s resolves its uptime scope from incidentIoComponentId alone',
    async (_id, cfg) => {
      const ids = [cfg.incidentIoComponentId].flat() as string[]
      const html = rsc([], ids.map((id) => uptimeEntry(id, 400)))
      const svc = await fetchService(cfg, {
        summary: { status: { indicator: 'none', description: 'All Systems Operational' }, components: ids.map((id) => comp(id, id)), incidents: [] } as never,
        incidents: null,
        latency: 100,
        uptimeHtml: html,
      }, undefined, {})
      expect(svc.uptime30d).toBe(100)
    },
  )
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

  it('and every service on the page reads that one entry BY PAGE — the shared-read half (#1175)', () => {
    // The write is pinned above; without the read there is nothing to stop a refactor keying the prefetch
    // per service id, which would put openai/chatgpt/codex back on one components.json fetch EACH — a
    // silent +2 subrequests per cycle with the whole suite green.
    expect(SERVICES_SRC).toMatch(/prefetchMap\.get\(config\.apiUrl\)/)
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

  it('every service resolving components on such a page configures it too (#1175)', () => {
    // The #1175 drift: chatgpt sat on status.openai.com beside page-mates reading the superset while it
    // resolved its own badge ids against summary.json's window. The prefetch reads one components.json
    // per PAGE, so a page-mate left off it buys nothing — it only narrows what that service can see.
    // A lone `statusComponentId` counts too, and so does a name-matched `statusComponent`: both fall back
    // to the page overall indicator when the component rotates out (the #783 shape). BOUNDARY: the
    // population is pages that ALREADY have a componentsUrl, so this is a page-mate consistency check,
    // not proof the defect class is closed — a page where NO service sets one is invisible here.
    const withUrl = new Set(SERVICES.filter((s) => s.componentsUrl && s.apiUrl).map((s) => s.apiUrl!))
    expect(withUrl.size, 'no page configures a componentsUrl — the assertion would be vacuous').toBeGreaterThan(0)
    const resolving = SERVICES.filter((s) => s.apiUrl && withUrl.has(s.apiUrl)
      && ((s.statusComponentIds?.length ?? 0) > 0 || (s.displayComponentIds?.length ?? 0) > 0
        || !!s.statusComponentId || !!s.statusComponent))
    expect(resolving.length, 'no component-resolving service on those pages').toBeGreaterThan(0)
    for (const s of resolving) {
      expect(s.componentsUrl, `${s.id} resolves components on ${s.apiUrl} but reads only summary.json`).toBeTruthy()
    }
  })
})
