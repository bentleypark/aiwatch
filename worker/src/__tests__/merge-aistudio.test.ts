import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mergeAistudioIncidents, carryOverAistudioIncidents, readLastKnownAistudioIncidents, AISTUDIO_CARRYOVER_MAX_AGE_MS, CACHE_KEY, SERVICES, fetchService } from '../services'
import { AISTUDIO_ENDPOINT } from '../parsers/aistudio'
import type { Incident } from '../types'

function vertex(id: string, title = 't'): Incident {
  return {
    id: `vertex:${id}`,
    title,
    status: 'resolved',
    impact: 'minor',
    startedAt: '2026-04-01T00:00:00.000Z',
    resolvedAt: '2026-04-01T01:00:00.000Z',
    duration: '1h 0m',
    timeline: [],
  }
}

// Minimal aistudio proto response with one API-component incident
const aistudioPayload = [[[
  ['new-keys', 'Gemini API keys issue', 1, [[1, 't', ['1776466800'], 'Detected']], 1, [1]],
  // AI Studio UI incident (component 3) — must be filtered out
  ['ui-only', 'AI Studio UI glitch', 1, [[1, 't', ['1776466800'], 'Detected']], 3, [3]],
]]]

function mockResponse(opts: {
  ok: boolean
  status?: number
  json?: () => Promise<unknown>
  bodyCancelRejects?: boolean
}): Response {
  const cancelFn = opts.bodyCancelRejects
    ? vi.fn().mockRejectedValue(new Error('stream locked'))
    : vi.fn().mockResolvedValue(undefined)
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    json: opts.json ?? (() => Promise.resolve(aistudioPayload)),
    body: { cancel: cancelFn },
  } as unknown as Response
}

describe('mergeAistudioIncidents', () => {
  let warn: ReturnType<typeof vi.spyOn>
  let info: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    info = vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
    info.mockRestore()
  })

  it('merges API-component aistudio incidents into the primary list', async () => {
    const primary = [vertex('v1')]
    const res = mockResponse({ ok: true })
    const out = await mergeAistudioIncidents(primary, res, 'gemini')
    expect(out.incidents.map((i) => i.id)).toEqual(['vertex:v1', 'aistudio:new-keys'])
    expect(out.merged).toBe(1)
    expect(out.parseErrors).toBe(0)
  })

  // #1012 — the filter widened from [API]-only to [API, MULTIMODAL_LIVE]; a pure Live API outage
  // (tagged [2], no 1) must now survive instead of being silently dropped.
  it('#1012 — merges a Multimodal-Live-only incident (component 2, no API tag)', async () => {
    const payload = [[[
      ['live-outage', 'Gemini Live API outage', 2, [[1, 't', ['1776466800'], 'Detected']], 2, [2]],
    ]]]
    const primary = [vertex('v1')]
    const res = mockResponse({ ok: true, json: () => Promise.resolve(payload) })
    const out = await mergeAistudioIncidents(primary, res, 'gemini')
    expect(out.incidents.map((i) => i.id)).toEqual(['vertex:v1', 'aistudio:live-outage'])
    const live = out.incidents.find((i) => i.id === 'aistudio:live-outage')
    expect(live?.componentIds).toEqual(['2'])
  })

  it('#1012 — still drops an AI-Studio-only incident (component 3) after the widen', async () => {
    const res = mockResponse({ ok: true }) // aistudioPayload's 'ui-only' entry is component 3 only
    const out = await mergeAistudioIncidents([vertex('v1')], res, 'gemini')
    expect(out.incidents.map((i) => i.id)).not.toContain('aistudio:ui-only')
  })

  // #1012 — the literal reported-bug shape: Google tags a real Live API outage as
  // [MULTIMODAL_LIVE, AI_STUDIO] (no API=1) — e.g. "AI Studio Realtime and Gemini Live API outage".
  it('#1012 — merges a [Multimodal Live, AI Studio]-tagged incident (real-world shape, no API tag)', async () => {
    const payload = [[[
      ['live-outage', 'AI Studio Realtime and Gemini Live API outage', 2, [[1, 't', ['1776466800'], 'Detected']], 2, [2, 3]],
    ]]]
    const res = mockResponse({ ok: true, json: () => Promise.resolve(payload) })
    const out = await mergeAistudioIncidents([vertex('v1')], res, 'gemini')
    expect(out.incidents.map((i) => i.id)).toContain('aistudio:live-outage')
    expect(out.incidents.find((i) => i.id === 'aistudio:live-outage')?.componentIds).toEqual(['2', '3'])
  })

  it('falls back silently and cancels the body on HTTP 403 (API key rotation)', async () => {
    const primary = [vertex('v1')]
    const res = mockResponse({ ok: false, status: 403 })
    const out = await mergeAistudioIncidents(primary, res, 'gemini')
    expect(out.incidents).toEqual(primary) // vertex preserved — Gemini monitoring never breaks
    expect(out.merged).toBe(0)
    expect(out.parseErrors).toBe(0)
    expect((res.body!.cancel as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('aistudio HTTP 403'))
  })

  it('cancels the body when JSON parsing throws (no resource leak)', async () => {
    const primary = [vertex('v1')]
    const res = mockResponse({ ok: true, json: () => Promise.reject(new Error('bad json')) })
    const out = await mergeAistudioIncidents(primary, res, 'gemini')
    expect(out.incidents).toEqual(primary)
    expect(out.parseErrors).toBe(1)
    expect((res.body!.cancel as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('aistudio parse failed'),
      expect.anything(),
    )
  })

  it('does not throw when body.cancel() rejects (Cloudflare unhandled-rejection guard)', async () => {
    const primary = [vertex('v1')]
    const res = mockResponse({ ok: false, status: 500, bodyCancelRejects: true })
    await expect(
      mergeAistudioIncidents(primary, res, 'gemini'),
    ).resolves.not.toThrow()
  })

  it('does not double-prefix — primary IDs keep vertex:, extras keep aistudio:', async () => {
    const primary = [vertex('dup-id'), vertex('v2')]
    const res = mockResponse({ ok: true })
    const out = await mergeAistudioIncidents(primary, res, 'gemini')
    const ids = out.incidents.map((i) => i.id)
    // Check namespaces stay distinct — no collisions.
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.startsWith('vertex:') || id.startsWith('aistudio:'))).toBe(true)
  })

  it('emits merge-count info log for tail-log audit', async () => {
    await mergeAistudioIncidents([vertex('v1')], mockResponse({ ok: true }), 'gemini')
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/\[gemini\] merged vertex=1 aistudio=1/),
    )
  })

  // #717 — hold last-known aistudio incidents on a failed read instead of dropping to vertex-only.
  describe('carry-over on failed read (#717)', () => {
    const held: Incident[] = [{
      id: 'aistudio:nano-banana',
      title: 'Issues with Nano Banana',
      status: 'investigating',
      impact: 'minor',
      startedAt: '2026-06-19T12:00:00.000Z',
      duration: null,
      timeline: [],
    }]
    const getCarryOver = () => Promise.resolve(held)

    it('holds carry-over incidents on HTTP non-OK (not vertex-only)', async () => {
      const out = await mergeAistudioIncidents([vertex('v1')], mockResponse({ ok: false, status: 403 }), 'gemini', getCarryOver)
      expect(out.incidents.map((i) => i.id)).toEqual(['vertex:v1', 'aistudio:nano-banana'])
      expect(out.held).toBe(1)
    })

    it('holds carry-over incidents when JSON parse throws', async () => {
      const out = await mergeAistudioIncidents(
        [vertex('v1')],
        mockResponse({ ok: true, json: () => Promise.reject(new Error('bad json')) }),
        'gemini',
        getCarryOver,
      )
      expect(out.incidents.map((i) => i.id)).toEqual(['vertex:v1', 'aistudio:nano-banana'])
      expect(out.held).toBe(1)
      expect(out.parseErrors).toBe(1)
    })

    it('does NOT consult carry-over on a successful read (fresh data is authoritative)', async () => {
      const spy = vi.fn(getCarryOver)
      const out = await mergeAistudioIncidents([vertex('v1')], mockResponse({ ok: true }), 'gemini', spy)
      expect(spy).not.toHaveBeenCalled()
      expect(out.held).toBe(0)
      expect(out.incidents.map((i) => i.id)).toEqual(['vertex:v1', 'aistudio:new-keys'])
    })

    it('holds carry-over when aistudioRes is null (fetch threw upstream)', async () => {
      const out = await mergeAistudioIncidents([vertex('v1')], null, 'gemini', getCarryOver)
      expect(out.incidents.map((i) => i.id)).toEqual(['vertex:v1', 'aistudio:nano-banana'])
      expect(out.held).toBe(1)
    })

    it('falls back to vertex-only when no getCarryOver is provided', async () => {
      const out = await mergeAistudioIncidents([vertex('v1')], mockResponse({ ok: false, status: 403 }), 'gemini')
      expect(out.incidents.map((i) => i.id)).toEqual(['vertex:v1'])
      expect(out.held).toBe(0)
    })

    it('stays vertex-only (does not throw) when getCarryOver itself throws — resilience guard', async () => {
      const throwing = () => Promise.reject(new Error('KV exploded'))
      const out = await mergeAistudioIncidents([vertex('v1')], null, 'gemini', throwing)
      expect(out.incidents.map((i) => i.id)).toEqual(['vertex:v1'])
      expect(out.held).toBe(0)
    })
  })
})

describe('readLastKnownAistudioIncidents (#717)', () => {
  const now = Date.parse('2026-06-19T13:00:00.000Z')
  const activeAistudio: Incident = {
    id: 'aistudio:nano', title: 'Issues with Nano Banana', status: 'investigating',
    impact: 'minor', startedAt: '2026-06-19T12:00:00.000Z', duration: null, timeline: [],
  }
  const snapshot = JSON.stringify({ services: [
    { id: 'claude', incidents: [] },
    { id: 'gemini', incidents: [activeAistudio, { ...activeAistudio, id: 'vertex:v', }] },
  ] })
  const fakeKv = (get: () => Promise<string | null>) => ({ get: vi.fn(get) }) as unknown as KVNamespace

  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { warn.mockRestore() })

  it('returns [] when kv is undefined', async () => {
    expect(await readLastKnownAistudioIncidents(undefined, 'gemini', now)).toEqual([])
  })

  it('returns [] when the cache key is absent', async () => {
    expect(await readLastKnownAistudioIncidents(fakeKv(() => Promise.resolve(null)), 'gemini', now)).toEqual([])
  })

  it('returns [] (and warns) when kv.get rejects', async () => {
    const out = await readLastKnownAistudioIncidents(fakeKv(() => Promise.reject(new Error('KV down'))), 'gemini', now)
    expect(out).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('carry-over read failed'), expect.anything())
  })

  it('returns [] (and warns) on corrupt JSON', async () => {
    const out = await readLastKnownAistudioIncidents(fakeKv(() => Promise.resolve('{not json')), 'gemini', now)
    expect(out).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('carry-over read failed'), expect.anything())
  })

  it('returns [] when the service is absent from the snapshot', async () => {
    expect(await readLastKnownAistudioIncidents(fakeKv(() => Promise.resolve(snapshot)), 'mistral', now)).toEqual([])
  })

  it('picks the right service and returns only its active aistudio incidents (drops vertex:)', async () => {
    const out = await readLastKnownAistudioIncidents(fakeKv(() => Promise.resolve(snapshot)), 'gemini', now)
    expect(out.map((i) => i.id)).toEqual(['aistudio:nano'])
    expect(out[0].status).toBe('investigating') // field fidelity — badge depends on it
  })

  it('applies the age cap (a long-stale held incident is dropped)', async () => {
    const old = new Date(now - AISTUDIO_CARRYOVER_MAX_AGE_MS - 60_000).toISOString()
    const stale = JSON.stringify({ services: [{ id: 'gemini', incidents: [{ ...activeAistudio, startedAt: old }] }] })
    expect(await readLastKnownAistudioIncidents(fakeKv(() => Promise.resolve(stale)), 'gemini', now)).toEqual([])
  })
})

describe('carryOverAistudioIncidents (#717)', () => {
  const now = Date.parse('2026-06-19T13:00:00.000Z')
  const mk = (over: Partial<Incident>): Incident => ({
    id: 'aistudio:x', title: 't', status: 'investigating', impact: 'minor',
    startedAt: '2026-06-19T12:00:00.000Z', duration: null, timeline: [], ...over,
  })

  it('keeps active aistudio incidents within the age cap', () => {
    const out = carryOverAistudioIncidents([mk({ id: 'aistudio:nano' })], now)
    expect(out.map((i) => i.id)).toEqual(['aistudio:nano'])
  })

  it('drops vertex-sourced incidents (only aistudio: carried)', () => {
    const out = carryOverAistudioIncidents([mk({ id: 'vertex:v1' })], now)
    expect(out).toEqual([])
  })

  it('drops resolved incidents (badge-irrelevant; refresh will re-list)', () => {
    const out = carryOverAistudioIncidents([mk({ id: 'aistudio:done', status: 'resolved' })], now)
    expect(out).toEqual([])
  })

  it('drops incidents older than the age cap (stale-but-stuck guard)', () => {
    const old = new Date(now - AISTUDIO_CARRYOVER_MAX_AGE_MS - 60_000).toISOString()
    const out = carryOverAistudioIncidents([mk({ id: 'aistudio:old', startedAt: old })], now)
    expect(out).toEqual([])
  })

  it('returns [] for undefined input', () => {
    expect(carryOverAistudioIncidents(undefined, now)).toEqual([])
  })

  it('KEEPS an incident with an unparseable startedAt (fail-open: it was active last snapshot)', () => {
    const out = carryOverAistudioIncidents([mk({ id: 'aistudio:nostart', startedAt: '' })], now)
    expect(out.map((i) => i.id)).toEqual(['aistudio:nostart'])
  })
})

// #1012 — end-to-end through fetchService, not just the pure synthesizeAistudioComponents/merge
// functions in isolation. Guards the actual insertion point in services.ts's returned-object ternary
// (betterStackComponents / instatusComponents / aistudioComponents / {}) — a reordering or guard
// mistake there would ship with zero other test failures, since every other #1012 test exercises the
// parser functions directly rather than the wiring that calls them.
describe('#1012 — gemini fetchService wires the synthesized component breakdown into ServiceStatus', () => {
  const gemini = SERVICES.find((s) => s.id === 'gemini')!

  afterEach(() => vi.unstubAllGlobals())

  it('a live Multimodal-Live-only aistudio incident produces a degraded Multimodal Live row, API row stays operational', async () => {
    const aistudioPayload = [[[
      // severity 1 → 'minor' impact → 'degraded' (aistudio's mapImpact caps at severity 2/'major',
      // which synthesizeAistudioComponents escalates to 'down' — see its own test file for that case).
      ['live-outage', 'Gemini Live API outage', 1, [[1, 't', ['1776466800'], 'Detected']], 2, [2]],
    ]]]
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === AISTUDIO_ENDPOINT) return new Response(JSON.stringify(aistudioPayload), { status: 200 })
      if (url === gemini.statusUrl) return new Response('', { status: 200 })
      if (url === 'https://status.cloud.google.com/incidents.json') return new Response(JSON.stringify([]), { status: 200 })
      throw new Error(`unexpected fetch: ${url}`)
    }))

    const result = await fetchService(gemini, undefined, undefined, {})

    expect(result.components).toEqual([
      { id: 'aistudio-api', name: 'API', status: 'operational' },
      { id: 'aistudio-multimodal-live', name: 'Multimodal Live API', status: 'degraded' },
    ])
    expect(result.incidents.map((i) => i.id)).toContain('aistudio:live-outage')
  })

  it('no aistudio incidents at all → both breakdown rows operational', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === AISTUDIO_ENDPOINT) return new Response(JSON.stringify([[[]]]), { status: 200 })
      if (url === gemini.statusUrl) return new Response('', { status: 200 })
      if (url === 'https://status.cloud.google.com/incidents.json') return new Response(JSON.stringify([]), { status: 200 })
      throw new Error(`unexpected fetch: ${url}`)
    }))

    const result = await fetchService(gemini, undefined, undefined, {})

    expect(result.components).toEqual([
      { id: 'aistudio-api', name: 'API', status: 'operational' },
      { id: 'aistudio-multimodal-live', name: 'Multimodal Live API', status: 'operational' },
    ])
  })

  // #1012 review (rounds 2-4) — a same-cycle "is this trustworthy" gate was tried and reverted: every
  // signal available at fetchService time (merge.held, "was gemini ever cached") is either 0 on an
  // ordinary healthy day too (flapping the breakdown on every transient blip) or true forever once
  // gemini has been cached once (cacheWrite re-caches every service unconditionally every cycle,
  // regardless of aistudio's own outcome — so it can't distinguish "read failed today" from "read
  // failed for a week"). So a failed read with no fresher carry-over falls back to whatever `filtered`
  // already holds — same accepted limitation `aistudioDailyImpact` above already has: a multi-day
  // aistudio outage reads as a stale "operational" breakdown rather than an explicit unknown, since
  // `ServiceComponent.status` has no unknown state. This is intentional parity with the pre-existing
  // sibling feature, not an oversight — pinned here so a future "fix" doesn't reopen the flap.
  it('aistudio HTTP 403 with no carry-over (kv=undefined) → stale "operational" breakdown (accepted limitation, not blanked)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === AISTUDIO_ENDPOINT) return new Response('', { status: 403 })
      if (url === gemini.statusUrl) return new Response('', { status: 200 })
      if (url === 'https://status.cloud.google.com/incidents.json') return new Response(JSON.stringify([]), { status: 200 })
      throw new Error(`unexpected fetch: ${url}`)
    }))

    const result = await fetchService(gemini, undefined, undefined, {})

    expect(result.components).toEqual([
      { id: 'aistudio-api', name: 'API', status: 'operational' },
      { id: 'aistudio-multimodal-live', name: 'Multimodal Live API', status: 'operational' },
    ])
    warn.mockRestore()
  })

  // A failed read that DOES have a valid carry-over renders the last-known state — this half was never
  // in question, carry-over existed pre-#1012 for the incident list and the breakdown just reads it too.
  it('aistudio HTTP 403 WITH a valid carry-over → breakdown reflects the held incident', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const held: Incident = {
      id: 'aistudio:live-outage', title: 'Gemini Live API outage', status: 'investigating',
      impact: 'minor', startedAt: new Date().toISOString(), duration: null, timeline: [],
      componentIds: ['2'],
    }
    const snapshot = JSON.stringify({ services: [{ id: 'gemini', incidents: [held] }] })
    const kv = { get: vi.fn(async () => snapshot) } as unknown as KVNamespace
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === AISTUDIO_ENDPOINT) return new Response('', { status: 403 })
      if (url === gemini.statusUrl) return new Response('', { status: 200 })
      if (url === 'https://status.cloud.google.com/incidents.json') return new Response(JSON.stringify([]), { status: 200 })
      throw new Error(`unexpected fetch: ${url}`)
    }))

    const result = await fetchService(gemini, undefined, kv, {})

    expect(result.components).toEqual([
      { id: 'aistudio-api', name: 'API', status: 'operational' },
      { id: 'aistudio-multimodal-live', name: 'Multimodal Live API', status: 'degraded' },
    ])
    warn.mockRestore()
  })
})
