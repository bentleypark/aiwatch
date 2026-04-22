import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mergeAistudioIncidents } from '../services'
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
})
