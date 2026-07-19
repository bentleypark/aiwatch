import { describe, it, expect, vi, afterEach } from 'vitest'
import { applyTitleMap, filterIncidents, tagAutoMonitorIncidents, isAutoMonitorIncident, fetchService, SERVICES } from '../services'
import type { Incident, ServiceConfig } from '../types'

// #989 — Kimi (Moonshot AI): a non-English (Chinese) Atlassian status source whose auto-monitor opens a
// fresh `critical` incident per model-error blip. Three mechanisms cooperate: titleMap (Chinese→English),
// autoMonitorTitles (UI grouping + Score exclusion), and the badge/display component split.

const kimi = SERVICES.find((s) => s.id === 'kimi')!

function mkInc(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'km-1',
    title: 'Agentic 模型错误报警',
    status: 'resolved',
    impact: 'critical',
    startedAt: '2026-07-12T10:00:00.000Z',
    resolvedAt: '2026-07-12T10:04:00.000Z',
    duration: '4m',
    timeline: [],
    ...overrides,
  }
}

describe('kimi config shape (#989)', () => {
  it('is registered as an api-category LLM with a stamped addedAt', () => {
    expect(kimi).toBeTruthy()
    expect(kimi.category).toBe('api')
    expect(kimi.addedAt).toBeTruthy()
  })

  it('drives the badge off the single Open API component; model components are display-only', () => {
    expect(kimi.statusComponentId).toBe('8psr5dfdld0s') // Open API (has uptimeData, ~100%)
    // No statusComponentIds → the model components can NEVER flip the badge to `down` (a 1–9min blip
    // would otherwise drag status-edge alerts + cache refresh). They live in displayComponentIds only.
    expect(kimi.statusComponentIds).toBeUndefined()
    expect(kimi.displayComponentIds).toHaveLength(8)
    expect(kimi.displayComponentIds).toContain('8psr5dfdld0s') // badge included in the breakdown (openai pattern)
  })

  it('folds the six model components under a "Models" group, leaving Open API + API Service as surfaces', () => {
    const groups = kimi.componentGroups!
    expect(groups).toBeTruthy()
    // Open API (badge) + API Service stay ungrouped surface rows.
    expect(groups['8psr5dfdld0s']).toBeUndefined()
    expect(groups['rf64wcbxt3r2']).toBeUndefined()
    // Every OTHER displayComponentId is a model folded into "Models".
    const modelIds = kimi.displayComponentIds!.filter((id) => id !== '8psr5dfdld0s' && id !== 'rf64wcbxt3r2')
    expect(modelIds).toHaveLength(6)
    expect(modelIds.every((id) => groups[id] === 'Models')).toBe(true)
  })

  it('carries a titleMap and autoMonitorTitles, but NOT holdShortIncidents (inert for critical)', () => {
    expect(kimi.titleMap).toBeTruthy()
    expect(Object.keys(kimi.titleMap!)).toHaveLength(5)
    expect(kimi.autoMonitorTitles?.length).toBeGreaterThan(0)
    // holdShortIncidents / flapSuppression are deliberately unset: `critical` bypasses every hold/flap
    // path (alerts.ts), so setting them would be cargo-cult. The Discord flood is prevented by
    // filterByComponentStatus (#970) instead; grouping + Score-exclusion come from the autoMonitor tag.
    expect(kimi.holdShortIncidents).toBeUndefined()
    expect(kimi.flapSuppression).toBeUndefined()
  })
})

describe('applyTitleMap (#989)', () => {
  it('rewrites a mapped title to English', () => {
    expect(applyTitleMap([mkInc()], kimi)[0].title).toBe('Agentic model error alert')
    expect(applyTitleMap([mkInc({ title: '搜索请求出现大量报错' })], kimi)[0].title).toBe('Elevated search request error rate')
  })

  it('matches case- and whitespace-insensitively — every autoMonitorTitles variant translates (#989 review)', () => {
    // The recognition set must be at least as wide as the `autoMonitorTitles` regex (/i + \s*), else a
    // tagged variant leaks untranslated. Uppercase, extra spaces, and no-space all map to the English.
    for (const variant of ['AGENTIC 模型错误报警', 'Agentic  模型错误报警', 'agentic模型错误报警', '  aGeNtIc模型错误报警 ']) {
      expect(applyTitleMap([mkInc({ title: variant })], kimi)[0].title, variant).toBe('Agentic model error alert')
    }
  })

  it('the known machine-alarm variants are both tagged AND translated (no tagged-but-untranslated leak)', () => {
    // Pin the two sets together: a title the tagger stamps `autoMonitor` MUST translate, or Chinese
    // leaks to Discord/dashboard. Drive real machine variants through the map and assert no CJK remains.
    for (const t of ['Agentic 模型错误报警', 'agentic模型错误报警']) {
      expect(isAutoMonitorIncident(mkInc({ title: t }), kimi)).toBe(true)          // tagger matches
      expect(/[㐀-鿿]/.test(applyTitleMap([mkInc({ title: t })], kimi)[0].title)).toBe(false) // …and it translated
    }
  })

  it('passes an UNMAPPED title through unchanged — never drops it', () => {
    const out = applyTitleMap([mkInc({ title: 'A brand-new human-written incident' })], kimi)
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('A brand-new human-written incident')
  })

  it('is identity for a service with no titleMap (same reference)', () => {
    const noMap = { id: 'x', name: 'X' } as unknown as ServiceConfig
    const arr = [mkInc()]
    expect(applyTitleMap(arr, noMap)).toBe(arr)
  })

  it('every titleMap key is already normalized enough to be reachable (no stray-whitespace dead key)', () => {
    // A config key authored with leading/trailing/oddly-collapsed whitespace would still be reachable
    // via the normalized lookup, but a key that differs from its own trim is an authoring smell.
    for (const key of Object.keys(kimi.titleMap!)) {
      expect(key, `titleMap key "${key}" has stray edge whitespace`).toBe(key.trim())
    }
  })

  it('warns on an UNMAPPED CJK title — even a real (non-autoMonitor) gateway incident (#989 review)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A genuine Chinese incident the map lacks, NOT machine-tagged — the class most worth surfacing.
    applyTitleMap([mkInc({ title: '网络连接超时', autoMonitor: undefined, impact: 'major' })], kimi)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain('not in titleMap')
    warn.mockRestore()
  })

  it('does NOT warn when an unmapped title is plain ASCII (a human English incident)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    applyTitleMap([mkInc({ title: 'A brand-new English incident' })], kimi)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('filterIncidents → applyTitleMap ordering (#989 / #940 guard)', () => {
  // Kimi itself has no incidentExclude, so it cannot exercise the ordering (filterIncidents is a
  // pass-through for it). A SYNTHETIC config with BOTH a titleMap and an incidentExclude whose token
  // lives in the CHINESE original but NOT the English mapping makes the order observable: the two
  // orders give DIFFERENT results, so a swap is caught.
  const cfg = {
    id: 'synthetic', name: 'S',
    titleMap: { '维护通知': 'Maintenance notice', '正常事件': 'Normal event' },
    incidentExclude: ['维护'], // token lives in '维护通知' (Chinese) but not its English mapping
  } as unknown as ServiceConfig

  it('order matters: filter-first drops the excluded incident; map-first would wrongly keep it', () => {
    const inc = mkInc({ id: 'x', title: '维护通知' })
    // CORRECT (production order): filter on the original → the 维护 token drops it.
    expect(applyTitleMap(filterIncidents([inc], cfg), cfg)).toHaveLength(0)
    // WRONG (swapped): map first → English 'Maintenance notice' no longer contains 维护 → survives.
    expect(filterIncidents(applyTitleMap([inc], cfg), cfg).map((i) => i.id)).toEqual(['x'])
  })

  it('a non-excluded incident survives the filter and is then translated', () => {
    const out = applyTitleMap(
      filterIncidents([mkInc({ id: 'drop', title: '维护通知' }), mkInc({ id: 'keep', title: '正常事件' })], cfg),
      cfg,
    )
    expect(out.map((i) => i.id)).toEqual(['keep']) // '维护通知' dropped on the original token
    expect(out[0].title).toBe('Normal event')      // survivor translated by the map
  })
})

describe('autoMonitor tagging of the machine alarm (#989)', () => {
  it('tags BOTH casing/spacing variants of the Agentic alarm, but not a human singleton', () => {
    const tagged = tagAutoMonitorIncidents(
      [
        mkInc({ id: 'a', title: 'Agentic 模型错误报警' }),   // spaced, capital A
        mkInc({ id: 'b', title: 'agentic模型错误报警' }),     // no space, lowercase
        mkInc({ id: 'c', title: '搜索请求出现大量报错' }),     // search singleton — NOT the machine alarm
      ],
      kimi,
    )
    expect(tagged[0].autoMonitor).toBe(true)
    expect(tagged[1].autoMonitor).toBe(true)
    expect(tagged[2].autoMonitor).toBeUndefined()
  })
})

// The pure helpers above are the "tested twin"; the REAL /api/status path is fetchService, which
// runs tag THEN titleMap. This drives that path end-to-end — the guard that caught the live bug where
// titleMap ran before tagging, leaving the Chinese autoMonitorTitles patterns to match already-English
// titles (tag silently never applied → grouping + Score-exclusion both broke). (#989 / #966 / #940)
describe('fetchService applies tag AND titleMap in the right order (#989 — real call path)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const spInc = (id: string, name: string) => ({
    id, name, status: 'resolved', impact: 'critical',
    created_at: '2026-07-12T10:00:00.000Z', started_at: '2026-07-12T10:00:00.000Z',
    resolved_at: '2026-07-12T10:04:00.000Z', updated_at: '2026-07-12T10:04:00.000Z',
    incident_updates: [{ status: 'resolved', body: 'Error rate returned to normal.', created_at: '2026-07-12T10:04:00.000Z' }],
    components: [] as unknown[], // the Moonshot auto-monitor attaches to no component (verified live)
  })

  const fetchKimi = () => {
    const summary = {
      status: { indicator: 'none', description: 'All Systems Operational' },
      components: [{ id: '8psr5dfdld0s', name: 'Open API', status: 'operational' }],
      incidents: [
        spInc('a1', 'Agentic 模型错误报警'),   // machine, spaced
        spInc('a2', 'agentic模型错误报警'),     // machine, no-space lowercase
        spInc('h1', '搜索请求出现大量报错'),     // human singleton
      ],
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    return fetchService(kimi, { summary: summary as never, incidents: null, latency: 120 })
  }

  it('tags the machine alarm as autoMonitor=true AND renders its title in English', async () => {
    const svc = await fetchKimi()
    const machine = svc.incidents.filter((i) => i.title === 'Agentic model error alert')
    expect(machine).toHaveLength(2)                                   // both Chinese variants → one English title
    expect(machine.every((i) => i.autoMonitor === true)).toBe(true)  // ← the assertion the order bug failed
  })

  it('leaves the human singleton untagged, still title-mapped to English', async () => {
    const svc = await fetchKimi()
    const human = svc.incidents.find((i) => i.title === 'Elevated search request error rate')
    expect(human).toBeDefined()
    expect(human!.autoMonitor).toBeUndefined()
  })

  it('leaks NO Chinese text into any served title (titleMap actually ran)', async () => {
    const svc = await fetchKimi()
    expect(svc.incidents).toHaveLength(3)
    expect(svc.incidents.every((i) => !/[一-鿿]/.test(i.title))).toBe(true)
  })
})
