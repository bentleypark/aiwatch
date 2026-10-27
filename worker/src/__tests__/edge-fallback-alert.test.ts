// #378 — Worker endpoint that fires Discord alert when Vercel Edge falls back
// to the degraded "Status data is temporarily unavailable" render. Tests cover
// auth, dedup, dispatch toggle on missing webhook, and input sanitization.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleEdgeFallbackAlert } from '../index'
import { EDGE_FALLBACK_ALERT_KEY_PREFIX, EDGE_FALLBACK_ALERT_TTL_S } from '../edge-fallback-alert-keys'

function makeKV(initial: Record<string, string> = {}) {
  const store = { ...initial }
  return {
    store,
    kv: {
      get: vi.fn(async (k: string) => store[k] ?? null),
      put: vi.fn(async (k: string, v: string, _opts?: unknown) => { store[k] = v }),
      delete: vi.fn(async (k: string) => { delete store[k] }),
      list: vi.fn(async () => ({ keys: Object.keys(store).map(name => ({ name })), list_complete: true, cacheStatus: null })),
    } as unknown as KVNamespace,
  }
}

function makeReq(body: unknown, token?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token !== undefined) headers.Authorization = `Bearer ${token}`
  return new Request('https://aiwatch-worker.test/api/internal/edge-fallback', {
    method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const cors = { 'Access-Control-Allow-Origin': '*' }

let pending: Promise<unknown>[] = []
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) } }

async function call(req: Request, env: Parameters<typeof handleEdgeFallbackAlert>[1]): Promise<Response> {
  const res = await handleEdgeFallbackAlert(req, env, cors, ctx)
  await Promise.all(pending)
  return res
}

describe('handleEdgeFallbackAlert (#378)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    pending = []
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    )
  })

  afterEach(() => { fetchMock.mockRestore() })

  it('returns 401 when EDGE_ALERT_TOKEN is not configured', async () => {
    const { kv } = makeKV()
    const env = { STATUS_CACHE: kv } as unknown as Parameters<typeof handleEdgeFallbackAlert>[1]
    const res = await call(makeReq({ surface: 'is-down', slug: 'claude' }, 'anything'), env)
    expect(res.status).toBe(401)
  })

  it('returns 401 on wrong Bearer token', async () => {
    const { kv } = makeKV()
    const env = { STATUS_CACHE: kv, EDGE_ALERT_TOKEN: 'correct' } as unknown as Parameters<typeof handleEdgeFallbackAlert>[1]
    const res = await call(makeReq({ surface: 'is-down', slug: 'claude' }, 'wrong'), env)
    expect(res.status).toBe(401)
  })

  it('returns 401 when Authorization header is missing entirely', async () => {
    const { kv } = makeKV()
    const env = { STATUS_CACHE: kv, EDGE_ALERT_TOKEN: 'correct' } as unknown as Parameters<typeof handleEdgeFallbackAlert>[1]
    const res = await call(makeReq({ surface: 'is-down', slug: 'claude' }), env)
    expect(res.status).toBe(401)
  })

  it('returns 400 when surface or slug is missing', async () => {
    const { kv } = makeKV()
    const env = { STATUS_CACHE: kv, EDGE_ALERT_TOKEN: 'correct', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x/y' } as unknown as Parameters<typeof handleEdgeFallbackAlert>[1]
    const res = await call(makeReq({ surface: 'is-down' }, 'correct'), env)
    expect(res.status).toBe(400)
  })

  it('dispatches Discord alert and writes dedup marker on first call', async () => {
    const { store, kv } = makeKV()
    const env = { STATUS_CACHE: kv, EDGE_ALERT_TOKEN: 'correct', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x/y' } as unknown as Parameters<typeof handleEdgeFallbackAlert>[1]
    const res = await call(makeReq({ surface: 'is-down', slug: 'claude', reason: 'worker_timeout' }, 'correct'), env)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; queued: boolean }
    expect(body).toMatchObject({ ok: true, queued: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(store[`${EDGE_FALLBACK_ALERT_KEY_PREFIX}is-down:claude`]).toBe('1')
  })

  it('#1531 — answers before the Discord post settles, with the marker written first and the post under waitUntil', async () => {
    let release!: (r: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { release = r }))
    const { store, kv } = makeKV()
    const env = { STATUS_CACHE: kv, EDGE_ALERT_TOKEN: 'correct', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x/y' } as unknown as Parameters<typeof handleEdgeFallbackAlert>[1]
    const res = await handleEdgeFallbackAlert(makeReq({ surface: 'is-down', slug: 'claude' }, 'correct'), env, cors, ctx)
    expect(res.status).toBe(200)
    expect(pending).toHaveLength(1)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(store[`${EDGE_FALLBACK_ALERT_KEY_PREFIX}is-down:claude`]).toBe('1')
    release(new Response(null, { status: 204 }))
    await Promise.all(pending)
  })

  it.each([['is-down', true], ['reports', false]] as const)('#1531 — the %s alert mentions the CDN copy only where the page sets stale-if-error', async (surface, mentions) => {
    const { kv } = makeKV()
    const env = { STATUS_CACHE: kv, EDGE_ALERT_TOKEN: 'correct', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x/y' } as unknown as Parameters<typeof handleEdgeFallbackAlert>[1]
    await call(makeReq({ surface, slug: 'claude' }, 'correct'), env)
    const sent = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as { embeds: Array<{ description: string }> }
    expect(sent.embeds[0].description.includes('stale-if-error')).toBe(mentions)
  })

  it('#1531 — answers even while the dedup read stalls, with the whole dispatch under waitUntil', async () => {
    const { kv } = makeKV()
    ;(kv.get as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise(() => {}))
    const env = { STATUS_CACHE: kv, EDGE_ALERT_TOKEN: 'correct', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x/y' } as unknown as Parameters<typeof handleEdgeFallbackAlert>[1]
    const res = await handleEdgeFallbackAlert(makeReq({ surface: 'is-down', slug: 'claude' }, 'correct'), env, cors, ctx)
    expect(res.status).toBe(200)
    expect(pending).toHaveLength(1)
  })

  it('#1531 — still posts to Discord when the dedup marker write is rejected', async () => {
    const { kv } = makeKV()
    ;(kv.put as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('kv down'))
    const env = { STATUS_CACHE: kv, EDGE_ALERT_TOKEN: 'correct', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x/y' } as unknown as Parameters<typeof handleEdgeFallbackAlert>[1]
    await call(makeReq({ surface: 'is-down', slug: 'claude' }, 'correct'), env)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends nothing on a second call within the cooldown window', async () => {
    const { kv } = makeKV({ [`${EDGE_FALLBACK_ALERT_KEY_PREFIX}is-down:claude`]: '1' })
    const env = { STATUS_CACHE: kv, EDGE_ALERT_TOKEN: 'correct', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x/y' } as unknown as Parameters<typeof handleEdgeFallbackAlert>[1]
    const res = await call(makeReq({ surface: 'is-down', slug: 'claude' }, 'correct'), env)
    expect(res.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips Discord but still writes dedup marker when DISCORD_WEBHOOK_URL is unset', async () => {
    const { store, kv } = makeKV()
    const env = { STATUS_CACHE: kv, EDGE_ALERT_TOKEN: 'correct' } as unknown as Parameters<typeof handleEdgeFallbackAlert>[1]
    const res = await call(makeReq({ surface: 'is-down', slug: 'claude' }, 'correct'), env)
    expect(res.status).toBe(200)
    expect(store[`${EDGE_FALLBACK_ALERT_KEY_PREFIX}is-down:claude`]).toBe('1')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('writes dedup marker even when Discord delivery fails (defends against retry storm)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('upstream gone', { status: 502 }))
    const { store, kv } = makeKV()
    const env = { STATUS_CACHE: kv, EDGE_ALERT_TOKEN: 'correct', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x/y' } as unknown as Parameters<typeof handleEdgeFallbackAlert>[1]
    const res = await call(makeReq({ surface: 'is-down', slug: 'claude' }, 'correct'), env)
    expect(res.status).toBe(200)
    expect(store[`${EDGE_FALLBACK_ALERT_KEY_PREFIX}is-down:claude`]).toBe('1')
  })

  it('uses TTL of 5 minutes on the dedup marker', async () => {
    const { kv } = makeKV()
    const env = { STATUS_CACHE: kv, EDGE_ALERT_TOKEN: 'correct', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x/y' } as unknown as Parameters<typeof handleEdgeFallbackAlert>[1]
    await call(makeReq({ surface: 'is-down', slug: 'claude' }, 'correct'), env)
    const putMock = (kv.put as unknown as ReturnType<typeof vi.fn>)
    const opts = putMock.mock.calls[0]?.[2] as { expirationTtl: number } | undefined
    expect(opts?.expirationTtl).toBe(EDGE_FALLBACK_ALERT_TTL_S)
    expect(EDGE_FALLBACK_ALERT_TTL_S).toBe(300)
  })

  it('sanitizes surface and slug to alphanum/dash, capped length', async () => {
    const { store, kv } = makeKV()
    const env = { STATUS_CACHE: kv, EDGE_ALERT_TOKEN: 'correct', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x/y' } as unknown as Parameters<typeof handleEdgeFallbackAlert>[1]
    // Inject path-traversal + special chars; expect them stripped before forming the dedup key.
    await call(
      makeReq({ surface: 'is-down/../etc', slug: '../../passwd!@#$', reason: 'rm -rf /' }, 'correct'),
      env,
    )
    // Key should not contain '/' or '.', should match the sanitized shape
    const keys = Object.keys(store)
    expect(keys).toHaveLength(1)
    const key = keys[0]
    expect(key).toMatch(/^alerted:edge-fallback:[a-z0-9-]+:[a-z0-9-]+$/i)
    expect(key).not.toContain('/')
    expect(key).not.toContain('.')
  })

  it('caps slug length at 64 chars after sanitization', async () => {
    const { store, kv } = makeKV()
    const env = { STATUS_CACHE: kv, EDGE_ALERT_TOKEN: 'correct', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x/y' } as unknown as Parameters<typeof handleEdgeFallbackAlert>[1]
    const longSlug = 'a'.repeat(200)
    await call(makeReq({ surface: 'is-down', slug: longSlug }, 'correct'), env)
    const keys = Object.keys(store)
    expect(keys).toHaveLength(1)
    // Key shape: alerted:edge-fallback:{surface}:{slug} — slug portion ≤ 64
    const slugPart = keys[0].split(':').slice(3).join(':')
    expect(slugPart.length).toBe(64)
  })

  it('case-insensitive dedup: "Claude" and "claude" collapse to the same key', async () => {
    const { store, kv } = makeKV()
    const env = { STATUS_CACHE: kv, EDGE_ALERT_TOKEN: 'correct', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x/y' } as unknown as Parameters<typeof handleEdgeFallbackAlert>[1]
    await call(makeReq({ surface: 'is-down', slug: 'Claude' }, 'correct'), env)
    await call(makeReq({ surface: 'IS-DOWN', slug: 'claude' }, 'correct'), env)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(Object.keys(store)).toHaveLength(1)
    // Key must be all-lowercase
    expect(Object.keys(store)[0]).toBe(`${EDGE_FALLBACK_ALERT_KEY_PREFIX}is-down:claude`)
  })

  it('separate surface+slug pairs do NOT share dedup state', async () => {
    const { store, kv } = makeKV({ [`${EDGE_FALLBACK_ALERT_KEY_PREFIX}is-down:claude`]: '1' })
    const env = { STATUS_CACHE: kv, EDGE_ALERT_TOKEN: 'correct', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x/y' } as unknown as Parameters<typeof handleEdgeFallbackAlert>[1]
    // Different slug → must NOT dedup against claude
    await call(makeReq({ surface: 'is-down', slug: 'openai' }, 'correct'), env)
    // Different surface, same slug → must NOT dedup either
    await call(makeReq({ surface: 'reports', slug: 'claude' }, 'correct'), env)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Three distinct keys now
    expect(Object.keys(store).length).toBe(3)
  })
})
