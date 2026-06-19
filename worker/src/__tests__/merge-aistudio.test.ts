import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mergeAistudioIncidents, carryOverAistudioIncidents, readLastKnownAistudioIncidents, AISTUDIO_CARRYOVER_MAX_AGE_MS, CACHE_KEY } from '../services'
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
