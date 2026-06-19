import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildWorkflowDispatchRequest, maybeDispatchDeepseekFeed, DISPATCH_COOLDOWN_KEY } from '../deepseek-dispatch'

describe('buildWorkflowDispatchRequest (#629)', () => {
  it('builds the GitHub workflow_dispatch POST with auth + required headers', () => {
    const { url, init } = buildWorkflowDispatchRequest('tok-123')
    expect(url).toBe('https://api.github.com/repos/bentleypark/aiwatch/actions/workflows/deepseek-feed.yml/dispatches')
    expect(init.method).toBe('POST')
    const h = init.headers as Record<string, string>
    expect(h.Authorization).toBe('Bearer tok-123')
    expect(h.Accept).toBe('application/vnd.github+json')
    expect(h['X-GitHub-Api-Version']).toBe('2022-11-28')
    expect(h['User-Agent']).toBeTruthy() // GitHub API rejects requests without one
    expect(JSON.parse(init.body as string)).toEqual({ ref: 'main' })
  })
})

// Minimal in-memory KV with the get/put surface the dispatcher uses.
function mockKV(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    _store: store,
  }
}

describe('maybeDispatchDeepseekFeed (#629)', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('no-ops when the token is absent (GH schedule backup only)', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const kv = mockKV()
    await maybeDispatchDeepseekFeed({ STATUS_CACHE: kv as unknown as KVNamespace }) // no GH_DISPATCH_TOKEN
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('skips while in the cooldown window', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const kv = mockKV({ [DISPATCH_COOLDOWN_KEY]: '1' })
    await maybeDispatchDeepseekFeed({ GH_DISPATCH_TOKEN: 't', STATUS_CACHE: kv as unknown as KVNamespace })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('dispatches + sets the cooldown on HTTP 204', async () => {
    const fetchSpy = vi.fn(async (_url: string, _opts?: RequestInit) => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)
    const kv = mockKV()
    await maybeDispatchDeepseekFeed({ GH_DISPATCH_TOKEN: 't', STATUS_CACHE: kv as unknown as KVNamespace })
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(fetchSpy.mock.calls[0][0]).toContain('/actions/workflows/deepseek-feed.yml/dispatches')
    expect(kv.put).toHaveBeenCalledWith(DISPATCH_COOLDOWN_KEY, '1', { expirationTtl: 240 })
  })

  it('backs off with a longer cooldown on a non-204 (e.g. bad token) — hourly schedule covers it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 401 })))
    const kv = mockKV()
    await maybeDispatchDeepseekFeed({ GH_DISPATCH_TOKEN: 't', STATUS_CACHE: kv as unknown as KVNamespace })
    expect(kv.put).toHaveBeenCalledWith(DISPATCH_COOLDOWN_KEY, '1', { expirationTtl: 900 })
  })

  it('never throws on a fetch error (must not break the cron)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    const kv = mockKV()
    await expect(
      maybeDispatchDeepseekFeed({ GH_DISPATCH_TOKEN: 't', STATUS_CACHE: kv as unknown as KVNamespace }),
    ).resolves.toBeUndefined()
  })
})
