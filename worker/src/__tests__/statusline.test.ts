import { describe, it, expect, vi } from 'vitest'
import {
  buildStatuslinePayload,
  isStatuslineRequest,
  renderStatuslinePreset,
  isStatuslinePreset,
  STATUSLINE_PRESETS,
  renderStatuslineBrief,
  renderStatuslineDownList,
  buildStatuslineDownResponse,
  buildStatuslinePresetResponse,
  hasNoSnapshot,
  renderStatuslinePresetUnknown,
  STATUSLINE_BRIEF_UNKNOWN,
  type StatuslineService,
  type BriefService,
} from '../statusline'
import { SERVICES } from '../services'
import type { ServiceStatus } from '../types'

const ESC = ''

function svc(overrides: Partial<ServiceStatus> & Record<string, unknown> = {}): ServiceStatus {
  return {
    id: 'claude',
    name: 'Claude API',
    provider: 'Anthropic',
    category: 'api',
    status: 'operational',
    incidents: [],
    ...overrides,
  } as ServiceStatus
}

describe('buildStatuslinePayload (#438)', () => {
  it('projects each service down to id/name/status only', () => {
    const cached = {
      cachedAt: '2026-05-20T00:00:00Z',
      services: [
        svc({ id: 'claude', name: 'Claude API', status: 'operational', latency: 142, uptime30d: 99.9, aiwatchScore: 92, incidents: [{ id: 'i1' } as never] }),
        svc({ id: 'openai', name: 'OpenAI API', status: 'down' }),
      ],
    }
    const out = buildStatuslinePayload(cached)
    expect(out.services).toEqual([
      { id: 'claude', name: 'Claude API', status: 'operational' },
      { id: 'openai', name: 'OpenAI API', status: 'down' },
    ])
    // The heavy fields the statusline doesn't use must be dropped
    expect(out.services[0]).not.toHaveProperty('latency')
    expect(out.services[0]).not.toHaveProperty('incidents')
    expect(out.services[0]).not.toHaveProperty('aiwatchScore')
    expect(out.cachedAt).toBe('2026-05-20T00:00:00Z')
  })

  it('returns empty services + null cachedAt when the cache is missing', () => {
    expect(buildStatuslinePayload(null)).toEqual({ services: [], cachedAt: null })
    expect(buildStatuslinePayload({ services: [] })).toEqual({ services: [], cachedAt: null })
  })

  it('projects exactly the keys the Statusline.jsx jq filters read (id/name/status)', () => {
    // Contract guard: the snippet jq selects .services[].id/.name/.status. A field
    // rename here would silently blank every installed statusline.
    const out = buildStatuslinePayload({ cachedAt: 't', services: [svc()] })
    expect(Object.keys(out.services[0]).sort()).toEqual(['id', 'name', 'status'])
  })
})

describe('/api/status/cached statusline routing contract (#438)', () => {
  // Mirrors the index.ts dispatch (worker/src/index.ts /api/status/cached): a
  // statusline-tagged request short-circuits to the lite payload; everything else
  // falls through to the full ~2 MB path. This is the core bandwidth guarantee —
  // pinned here because the handler branch itself is inline in the fetch dispatcher
  // (repo pattern: cached-response.test.ts simulates rather than invokes).
  function dispatch(search: string, cache: { services: ServiceStatus[]; cachedAt?: string } | null) {
    const sp = new URLSearchParams(search)
    if (isStatuslineRequest(sp)) return { path: 'lite' as const, body: buildStatuslinePayload(cache) }
    return { path: 'full' as const }
  }

  it('routes statusline-tagged requests to the lite payload', () => {
    const cache = { cachedAt: 't', services: [svc({ aiwatchScore: 92, incidents: [{ id: 'i' } as never] })] }
    const r = dispatch('src=statusline-degraded_only', cache)
    expect(r.path).toBe('lite')
    expect(r.body).toEqual(buildStatuslinePayload(cache))
    expect(r.body!.services[0]).not.toHaveProperty('aiwatchScore')
  })

  it('routes untagged + non-statusline requests to the full path', () => {
    expect(dispatch('', { services: [] }).path).toBe('full')
    expect(dispatch('src=dashboard', { services: [] }).path).toBe('full')
  })
})

describe('WAE writeDataPoint contract (#494)', () => {
  // Mirrors the WAE branch in the index.ts statusline handler.
  // Pins: blob1/double1/index shape, 32-byte safeSrc cap, optional-binding guard.
  function dispatchWithWae(
    search: string,
    analytics: { writeDataPoint: ReturnType<typeof vi.fn<(arg: { blobs: string[]; doubles: number[]; indexes: string[] }) => void>> } | undefined,
  ) {
    const sp = new URLSearchParams(search)
    if (!isStatuslineRequest(sp)) return
    const src = sp.get('src')
    if (src && analytics) {
      try {
        const safeSrc = src.slice(0, 32)
        analytics.writeDataPoint({ blobs: [safeSrc], doubles: [1], indexes: [safeSrc] })
      } catch { /* best-effort */ }
    }
  }

  it('writes one data point with correct blob/double/index for a statusline request', () => {
    const wae = { writeDataPoint: vi.fn() }
    dispatchWithWae('src=statusline-compact_badge', wae)
    expect(wae.writeDataPoint).toHaveBeenCalledOnce()
    expect(wae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ['statusline-compact_badge'],
      doubles: [1],
      indexes: ['statusline-compact_badge'],
    })
  })

  it('does not write when env.ANALYTICS is absent (local dev / tests)', () => {
    const wae = { writeDataPoint: vi.fn() }
    dispatchWithWae('src=statusline-compact_badge', undefined)
    expect(wae.writeDataPoint).not.toHaveBeenCalled()
  })

  it('does not write for non-statusline requests', () => {
    const wae = { writeDataPoint: vi.fn() }
    dispatchWithWae('', wae)
    dispatchWithWae('src=dashboard', wae)
    expect(wae.writeDataPoint).not.toHaveBeenCalled()
  })

  it('caps src to 32 bytes to stay within WAE index limit', () => {
    const wae = { writeDataPoint: vi.fn() }
    const longSrc = 'statusline-' + 'x'.repeat(60) // 71 chars total
    dispatchWithWae(`src=${longSrc}`, wae)
    expect(wae.writeDataPoint).toHaveBeenCalledOnce()
    const call = wae.writeDataPoint.mock.calls[0][0]
    expect(call.blobs[0]).toHaveLength(32)
    expect(call.indexes[0]).toHaveLength(32)
    expect(call.blobs[0]).toBe(call.indexes[0]) // same safeSrc used for both
  })
})

describe('isStatuslineRequest (#438)', () => {
  it('matches the ?src=statusline-<preset> tag', () => {
    expect(isStatuslineRequest(new URLSearchParams('src=statusline-degraded_only'))).toBe(true)
    expect(isStatuslineRequest(new URLSearchParams('src=statusline-compact_badge'))).toBe(true)
  })

  it('does not match regular or untagged requests', () => {
    expect(isStatuslineRequest(new URLSearchParams(''))).toBe(false)
    expect(isStatuslineRequest(new URLSearchParams('src=dashboard'))).toBe(false)
    expect(isStatuslineRequest(new URLSearchParams('foo=statusline-x'))).toBe(false)
  })
})

// #918 — server-side rendering: the display logic (incl. the +N overflow) now lives in
// the worker as testable TS, not a frozen client-side jq string. These pin each preset's
// output so a future change is caught, and so the +N overflow can't silently regress.
describe('renderStatuslinePreset (#918)', () => {
  const link = (url: string, text: string) => `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`
  const lite = (...svcs: Array<[string, string, StatuslineService['status']]>): StatuslineService[] =>
    svcs.map(([id, name, status]) => ({ id, name, status }))

  // 5 non-operational (order preserved) + 2 operational (filtered out)
  const FIVE_DOWN = lite(
    ['claude', 'Claude API', 'down'],
    ['openai', 'OpenAI', 'degraded'],
    ['gemini', 'Gemini', 'down'],
    ['groq', 'Groq', 'degraded'],
    ['xai', 'xAI', 'down'],
    ['cohere', 'Cohere', 'operational'],
    ['mistral', 'Mistral', 'operational'],
  )
  const TWO_DOWN = lite(['claude', 'Claude API', 'down'], ['openai', 'OpenAI', 'degraded'])
  const ALL_OK = lite(['claude', 'Claude API', 'operational'])

  it('degraded_only: top 3 names + `+N` overflow, empty when healthy', () => {
    expect(renderStatuslinePreset('degraded_only', FIVE_DOWN)).toBe('🔴 Claude API 🔴 OpenAI 🔴 Gemini +2')
    expect(renderStatuslinePreset('degraded_only', TWO_DOWN)).toBe('🔴 Claude API 🔴 OpenAI')
    expect(renderStatuslinePreset('degraded_only', ALL_OK)).toBe('')
  })

  // #936 — OSC-8 link targets carry utm_source=statusline (query before the '#' for hash links); the
  // VISIBLE statusline text is unchanged (the URL lives inside the invisible OSC-8 escape).
  const HOME = 'https://ai-watch.dev?utm_source=statusline&utm_medium=referral'
  const detail = (id: string) => `https://ai-watch.dev/?utm_source=statusline&utm_medium=referral#${id}`

  it('branded: always-on AIWatch label, 🟢 healthy, OSC-8 links + `+N` when down', () => {
    const label = link(HOME, 'AIWatch')
    expect(renderStatuslinePreset('branded', ALL_OK)).toBe(`${label} 🟢`)
    const out = renderStatuslinePreset('branded', FIVE_DOWN)
    expect(out.startsWith(`${label} `)).toBe(true)
    expect(out).toContain(link(detail('claude'), '🔴 Claude API'))
    expect(out.endsWith(' +2')).toBe(true)
  })

  it('clickable: OSC-8 links + `+N`, empty when healthy', () => {
    const out = renderStatuslinePreset('clickable', FIVE_DOWN)
    expect(out).toContain(link(detail('openai'), '🔴 OpenAI'))
    expect(out.endsWith(' +2')).toBe(true)
    expect(renderStatuslinePreset('clickable', ALL_OK)).toBe('')
  })

  it('compact_badge: count only, empty when healthy', () => {
    expect(renderStatuslinePreset('compact_badge', FIVE_DOWN)).toBe('🔴 5 AI services')
    expect(renderStatuslinePreset('compact_badge', ALL_OK)).toBe('')
  })

  it('full_list: all services, X· for down / !· for degraded, no cap', () => {
    expect(renderStatuslinePreset('full_list', FIVE_DOWN)).toBe(
      'X·Claude API | !·OpenAI | X·Gemini | !·Groq | X·xAI',
    )
    expect(renderStatuslinePreset('full_list', ALL_OK)).toBe('')
  })

  it('scoped: only claude/openai/gemini, no `+N`', () => {
    expect(renderStatuslinePreset('scoped', FIVE_DOWN)).toBe('🔴 Claude API 🔴 OpenAI 🔴 Gemini')
    expect(renderStatuslinePreset('scoped', TWO_DOWN)).toBe('🔴 Claude API 🔴 OpenAI')
  })

  it('unknown preset renders empty (caller 404s first)', () => {
    expect(renderStatuslinePreset('bogus', FIVE_DOWN)).toBe('')
  })
})

// #920 — the parseable down-list the plugin monitor tracks transitions from.
describe('renderStatuslineDownList (#920)', () => {
  const svc = (id: string, name: string, status: StatuslineService['status']): StatuslineService => ({ id, name, status })

  it('emits one `status<TAB>name` line per non-operational service, in order', () => {
    const out = renderStatuslineDownList([
      svc('claude', 'Claude API', 'down'),
      svc('openai', 'OpenAI', 'operational'),
      svc('mistral', 'Mistral API', 'degraded'),
    ])
    expect(out).toBe('down\tClaude API\ndegraded\tMistral API')
  })

  it('is empty when everything is operational', () => {
    expect(renderStatuslineDownList([svc('openai', 'OpenAI', 'operational')])).toBe('')
    expect(renderStatuslineDownList([])).toBe('')
  })

  it('is uncapped (unlike the 3-cap presets) — all affected services listed', () => {
    const many = Array.from({ length: 6 }, (_, i) => svc(`s${i}`, `Service ${i}`, 'down'))
    expect(renderStatuslineDownList(many).split('\n')).toHaveLength(6)
  })

  // #1238 — the format is one row per service, and the monitor reads a service's ABSENCE from it as
  // the only published claim of health. The monitor rejects a body it cannot read, so one name
  // carrying such a character costs EVERY service its transitions for as long as it is published.
  // Pinned on the configured roster, over the REAL `SERVICES`.
  it('no configured service name can break a row apart', () => {
    expect(SERVICES.length).toBeGreaterThan(40) // or an empty roster would satisfy the next line
    const offenders = SERVICES.filter((s) => /[\t\r\n]/.test(s.name)).map((s) => s.id)
    expect(offenders).toEqual([])
  })

  it('falls back to the id when a CACHED name is blank or only control characters', () => {
    // Both shapes reach the monitor's `$2` and both are worse than a wrong-looking name: an empty
    // `$2` rejects the WHOLE body on every poll (the monitor goes silent for as long as the record
    // is cached), and a whitespace-only one passes that guard and announces `🔴   is down`, a
    // notification naming no service. Dropping the row instead would be an all-clear.
    expect(renderStatuslineDownList([{ id: 'claude', name: '', status: 'down' }])).toBe('down\tclaude')
    expect(renderStatuslineDownList([{ id: 'claude', name: '\t', status: 'down' }])).toBe('down\tclaude')
    expect(renderStatuslineDownList([{ id: 'claude', name: '  ', status: 'unknown' }])).toBe('unknown\tclaude')
  })

  it('folds a control character in a CACHED name rather than emitting a row it would split', () => {
    // The roster above is pinned clean, but this renderer reads a cached payload — the same
    // "written by another deploy" reasoning that makes the status normalisation necessary.
    const out = renderStatuslineDownList([{ id: 'claude', name: 'Claude\nAPI', status: 'down' }])
    expect(out).toBe('down\tClaude API')
    expect(out.split('\n')).toHaveLength(1)
  })
})

// #1227 — the pure decision layer: a surface must never render "everything is fine" from a
// snapshot it could not read. The no-snapshot cases below fail against the pre-#1227 code; the
// populated-snapshot cases pin that the healthy behaviour did NOT change. Wiring — that the routes
// actually reach these builders — is covered separately in statusline-wiring.test.ts.
describe('no-snapshot handling (#1227)', () => {
  const cached = (services: ServiceStatus[]) => ({ cachedAt: '2026-08-13T02:52:50Z', upstreamFeeds: [], services })
  // Positional helper — the top-level `svc()` takes an overrides object, and these cases only care
  // about the three projected fields.
  const s = (id: string, name: string, status: ServiceStatus['status']): ServiceStatus =>
    svc({ id, name, status })

  describe('buildStatuslineDownResponse — the monitor down-list', () => {
    it('503s when there is no snapshot, so `curl -sf` fails and the monitor holds its previous set', () => {
      const r = buildStatuslineDownResponse(null)
      // The bug: a 200 here is read as "all clear" and fires a false `✅ recovered`.
      expect(r.status).toBe(503)
      expect(r.cacheControl).toBe('no-store')
    })

    it('keeps the empty 200 MEANINGFUL — a real all-operational snapshot still returns zero bytes', () => {
      const r = buildStatuslineDownResponse(cached([s('openai', 'OpenAI', 'operational')]))
      expect(r.status).toBe(200)
      expect(r.body).toBe('')
      expect(r.cacheControl).toBe('public, max-age=30')
    })

    it('renders the affected list unchanged on a populated snapshot', () => {
      const r = buildStatuslineDownResponse(cached([
        s('mistral', 'Mistral API', 'degraded'),
        s('fireworks', 'Fireworks AI', 'degraded'),
      ]))
      expect(r.status).toBe(200)
      expect(r.body).toBe('degraded\tMistral API\ndegraded\tFireworks AI')
    })
  })

  // The predicate the builders share. Zero services counts as "no snapshot": redundant in
  // production (cacheRead collapses it to null before any builder sees it), kept as depth.
  describe('hasNoSnapshot — the shared predicate', () => {
    it('is true for a null snapshot', () => {
      expect(hasNoSnapshot(null)).toBe(true)
    })

    it('is ALSO true for a snapshot that parsed but carries zero services', () => {
      expect(hasNoSnapshot({ services: [] })).toBe(true)
      expect(hasNoSnapshot({} as { services?: ServiceStatus[] })).toBe(true)
    })

    it('is false whenever there is a roster to report on, however healthy', () => {
      expect(hasNoSnapshot({ services: [s('openai', 'OpenAI', 'operational')] })).toBe(false)
      expect(hasNoSnapshot({ services: [s('mistral', 'Mistral API', 'degraded')] })).toBe(false)
    })

    it('drives the down-list: an empty-services snapshot 503s just like a null one', () => {
      expect(buildStatuslineDownResponse(cached([])).status).toBe(503)
      expect(buildStatuslinePresetResponse('branded', cached([])).body)
        .toBe(renderStatuslinePresetUnknown('branded'))
    })
  })

  describe('STATUSLINE_BRIEF_UNKNOWN — the /aiwatch briefing', () => {
    it('never claims all-clear', () => {
      expect(STATUSLINE_BRIEF_UNKNOWN).not.toContain('all monitored AI services operational')
      expect(STATUSLINE_BRIEF_UNKNOWN).not.toContain('✅')
      expect(STATUSLINE_BRIEF_UNKNOWN).toContain('unknown')
    })

    it('is distinct from the healthy briefing (the string the empty list used to produce)', () => {
      expect(renderStatuslineBrief([])).toBe('AIWatch: all monitored AI services operational ✅')
      expect(STATUSLINE_BRIEF_UNKNOWN).not.toBe(renderStatuslineBrief([]))
    })
  })

  describe('renderStatuslinePresetUnknown — the statusline snippets', () => {
    it('marks EVERY preset as unknown — including the ones that are silent when healthy', () => {
      for (const preset of STATUSLINE_PRESETS) {
        const out = renderStatuslinePresetUnknown(preset)
        expect(out, `${preset} must render an unknown marker`).not.toBe('')
        expect(out, `${preset} must carry the neutral marker`).toContain('⚪')
      }
    })

    it('never renders the healthy green — branded showed "AIWatch 🟢" on a cache miss before', () => {
      for (const preset of STATUSLINE_PRESETS) {
        expect(renderStatuslinePresetUnknown(preset)).not.toContain('🟢')
        expect(renderStatuslinePresetUnknown(preset)).not.toContain('🔴')
      }
      expect(renderStatuslinePreset('branded', [])).toContain('🟢')       // the healthy string…
      expect(renderStatuslinePresetUnknown('branded')).not.toBe(renderStatuslinePreset('branded', []))  // …is not what we serve
    })

    it('differs from the healthy render for every preset, so the two states are distinguishable', () => {
      for (const preset of STATUSLINE_PRESETS) {
        expect(renderStatuslinePresetUnknown(preset), preset).not.toBe(renderStatuslinePreset(preset, []))
      }
    })
  })

  // The renderers above can all be correct while the handler never reaches them, so pin the
  // DECISION too — this is the function the route actually spreads into its Response.
  describe('buildStatuslinePresetResponse — the decision the preset route runs', () => {
    it('serves the unknown marker (not the healthy render) when there is no snapshot', () => {
      for (const preset of STATUSLINE_PRESETS) {
        const r = buildStatuslinePresetResponse(preset, null)
        expect(r.body, preset).toBe(renderStatuslinePresetUnknown(preset))
        expect(r.body, preset).not.toBe(renderStatuslinePreset(preset, []))
        expect(r.cacheControl, preset).toBe('no-store')
      }
      // The specific regression: branded used to answer "AIWatch 🟢" here.
      expect(buildStatuslinePresetResponse('branded', null).body).not.toContain('🟢')
    })

    it('renders normally from a populated snapshot', () => {
      const snap = cached([s('mistral', 'Mistral API', 'degraded')])
      const r = buildStatuslinePresetResponse('degraded_only', snap)
      expect(r.body).toBe('🔴 Mistral API')
      expect(r.cacheControl).toBe('public, max-age=30')
    })

    it('still says "all clear" when the snapshot really is all-operational', () => {
      const r = buildStatuslinePresetResponse('branded', cached([s('openai', 'OpenAI', 'operational')]))
      expect(r.body).toContain('🟢')
      expect(r.cacheControl).toBe('public, max-age=30')
    })
  })
})

// #920 — the compact incident briefing behind the plugin's /aiwatch command.
describe('renderStatuslineBrief (#920)', () => {
  const brief = (over: Partial<BriefService> & Record<string, unknown> = {}): BriefService => ({
    id: 'x', name: 'X', provider: 'P', category: 'api', status: 'operational',
    incidents: [], aiwatchScore: 90, scoreGrade: 'good', ...over,
  } as BriefService)

  it('all operational → a single all-clear line', () => {
    const out = renderStatuslineBrief([brief({ id: 'openai', name: 'OpenAI' }), brief({ id: 'gemini', name: 'Gemini' })])
    expect(out).toBe('AIWatch: all monitored AI services operational ✅')
  })

  it('down service → incident (title + impact) + AI summary + a fallback line', () => {
    const pool = [
      brief({ id: 'claude', name: 'Claude API', status: 'down', incidents: [{ id: 'inc1', title: 'Elevated errors', status: 'investigating', impact: 'major' }] as unknown as BriefService['incidents'] }),
      brief({ id: 'openai', name: 'OpenAI' }),
      brief({ id: 'gemini', name: 'Gemini' }),
    ]
    const out = renderStatuslineBrief(pool, { 'claude:inc1': 'Capacity issue, ~30m to recovery.' })
    expect(out).toContain('AIWatch — active AI service issues:')
    expect(out).toContain('🔴 Claude API (down) — "Elevated errors" · major impact')
    expect(out).toContain('AI: Capacity issue, ~30m to recovery.')
    expect(out).toContain('Try instead:')
    // per-service SHORT landing link → vercel.json /p/:slug redirect adds UTM + 307s to is-down
    expect(out).toContain('↳ https://ai-watch.dev/p/claude')
    expect(out).not.toContain('utm_') // UTM lives in the vercel redirect, not the (model-relayed) link
    expect(out).toContain('More: https://ai-watch.dev')
  })

  it('degraded service with no published incident → says so, no AI line', () => {
    const out = renderStatuslineBrief([brief({ id: 'mistral', name: 'Mistral API', status: 'degraded', incidents: [] })])
    expect(out).toContain('🟠 Mistral API (degraded) — no published incident')
    expect(out).not.toContain('AI:')
  })

  it('truncates a very long AI summary', () => {
    const long = 'x'.repeat(500)
    const out = renderStatuslineBrief(
      [brief({ id: 'claude', name: 'Claude API', status: 'down', incidents: [{ id: 'i', title: 'T', status: 'identified', impact: 'minor' }] as unknown as BriefService['incidents'] })],
      { 'claude:i': long },
    )
    expect(out).toContain('…')
    expect(out).not.toContain('x'.repeat(300))
  })
})

describe('isStatuslinePreset / STATUSLINE_PRESETS (#918)', () => {
  it('accepts exactly the six shipped presets', () => {
    expect([...STATUSLINE_PRESETS]).toEqual(['branded', 'clickable', 'degraded_only', 'compact_badge', 'full_list', 'scoped'])
    for (const p of STATUSLINE_PRESETS) expect(isStatuslinePreset(p)).toBe(true)
  })
  it('rejects unknown / injection-y values', () => {
    expect(isStatuslinePreset('bogus')).toBe(false)
    expect(isStatuslinePreset('branded; rm -rf')).toBe(false)
    expect(isStatuslinePreset('')).toBe(false)
  })
})
