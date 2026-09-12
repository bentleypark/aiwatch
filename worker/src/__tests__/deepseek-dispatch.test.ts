import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  buildWorkflowDispatchRequest,
  maybeDispatchWorkflow,
  DEEPSEEK_DISPATCH_CONFIG,
  MISTRAL_DISPATCH_CONFIG,
} from '../deepseek-dispatch'

describe('buildWorkflowDispatchRequest (#629/#1395)', () => {
  it('builds the GitHub workflow_dispatch POST with auth + required headers, for the given workflow file', () => {
    const { url, init } = buildWorkflowDispatchRequest('tok-123', 'deepseek-feed.yml')
    expect(url).toBe('https://api.github.com/repos/bentleypark/aiwatch/actions/workflows/deepseek-feed.yml/dispatches')
    expect(init.method).toBe('POST')
    const h = init.headers as Record<string, string>
    expect(h.Authorization).toBe('Bearer tok-123')
    expect(h.Accept).toBe('application/vnd.github+json')
    expect(h['X-GitHub-Api-Version']).toBe('2022-11-28')
    expect(h['User-Agent']).toBeTruthy() // GitHub API rejects requests without one
    expect(JSON.parse(init.body as string)).toEqual({ ref: 'main' })
  })

  it('targets a different workflow file for a different consumer', () => {
    const { url } = buildWorkflowDispatchRequest('tok-123', 'mistral-feed.yml')
    expect(url).toBe('https://api.github.com/repos/bentleypark/aiwatch/actions/workflows/mistral-feed.yml/dispatches')
  })
})

describe('DEEPSEEK_DISPATCH_CONFIG / MISTRAL_DISPATCH_CONFIG (#1395)', () => {
  it('use distinct cooldown keys — a shared key would make one workflow dispatch suppress the other', () => {
    expect(DEEPSEEK_DISPATCH_CONFIG.cooldownKey).not.toBe(MISTRAL_DISPATCH_CONFIG.cooldownKey)
  })

  it('Mistral does not back off past its normal cadence on failure (55min already IS the normal cadence, not a back-off to shorten further)', () => {
    expect(MISTRAL_DISPATCH_CONFIG.failCooldownS).toBe(MISTRAL_DISPATCH_CONFIG.cooldownS)
  })

  it('DeepSeek keeps its pre-#1395 longer failure back-off, unchanged', () => {
    expect(DEEPSEEK_DISPATCH_CONFIG.failCooldownS).toBeGreaterThan(DEEPSEEK_DISPATCH_CONFIG.cooldownS)
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

describe('maybeDispatchWorkflow (#629/#1395)', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('no-ops when the token is absent', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const kv = mockKV()
    await maybeDispatchWorkflow({ STATUS_CACHE: kv as unknown as KVNamespace }, DEEPSEEK_DISPATCH_CONFIG) // no GH_DISPATCH_TOKEN
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('skips while in the cooldown window', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const kv = mockKV({ [DEEPSEEK_DISPATCH_CONFIG.cooldownKey]: '1' })
    await maybeDispatchWorkflow({ GH_DISPATCH_TOKEN: 't', STATUS_CACHE: kv as unknown as KVNamespace }, DEEPSEEK_DISPATCH_CONFIG)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('dispatches + sets the cooldown on HTTP 204', async () => {
    const fetchSpy = vi.fn(async (_url: string, _opts?: RequestInit) => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)
    const kv = mockKV()
    await maybeDispatchWorkflow({ GH_DISPATCH_TOKEN: 't', STATUS_CACHE: kv as unknown as KVNamespace }, DEEPSEEK_DISPATCH_CONFIG)
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(fetchSpy.mock.calls[0][0]).toContain('/actions/workflows/deepseek-feed.yml/dispatches')
    expect(kv.put).toHaveBeenCalledWith(DEEPSEEK_DISPATCH_CONFIG.cooldownKey, '1', { expirationTtl: 240 })
  })

  it('backs off with a longer cooldown on a non-204 (e.g. bad token)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 401 })))
    const kv = mockKV()
    await maybeDispatchWorkflow({ GH_DISPATCH_TOKEN: 't', STATUS_CACHE: kv as unknown as KVNamespace }, DEEPSEEK_DISPATCH_CONFIG)
    expect(kv.put).toHaveBeenCalledWith(DEEPSEEK_DISPATCH_CONFIG.cooldownKey, '1', { expirationTtl: 900 })
  })

  it('never throws on a fetch error (must not break the cron)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    const kv = mockKV()
    await expect(
      maybeDispatchWorkflow({ GH_DISPATCH_TOKEN: 't', STATUS_CACHE: kv as unknown as KVNamespace }, DEEPSEEK_DISPATCH_CONFIG),
    ).resolves.toBeUndefined()
  })

  it('#1395 — a thrown fetch still sets the fail-cooldown, so a network blip cannot escalate every */5 tick into a re-attempt forever', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    const kv = mockKV()
    await maybeDispatchWorkflow({ GH_DISPATCH_TOKEN: 't', STATUS_CACHE: kv as unknown as KVNamespace }, MISTRAL_DISPATCH_CONFIG)
    expect(kv.put).toHaveBeenCalledWith(MISTRAL_DISPATCH_CONFIG.cooldownKey, '1', { expirationTtl: MISTRAL_DISPATCH_CONFIG.failCooldownS })
  })

  describe('two consumers sharing one KV (#1395)', () => {
    it('dispatching DeepSeek does not put Mistral in cooldown, and vice versa', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
      const kv = mockKV()

      await maybeDispatchWorkflow({ GH_DISPATCH_TOKEN: 't', STATUS_CACHE: kv as unknown as KVNamespace }, DEEPSEEK_DISPATCH_CONFIG)
      expect(kv._store.has(DEEPSEEK_DISPATCH_CONFIG.cooldownKey)).toBe(true)
      expect(kv._store.has(MISTRAL_DISPATCH_CONFIG.cooldownKey)).toBe(false)

      // Mistral's own call still fires — it isn't suppressed by DeepSeek's just-set cooldown.
      const fetchSpy = vi.mocked(fetch)
      fetchSpy.mockClear()
      await maybeDispatchWorkflow({ GH_DISPATCH_TOKEN: 't', STATUS_CACHE: kv as unknown as KVNamespace }, MISTRAL_DISPATCH_CONFIG)
      expect(fetchSpy).toHaveBeenCalledOnce()
      expect(fetchSpy.mock.calls[0][0]).toContain('/actions/workflows/mistral-feed.yml/dispatches')
      expect(kv._store.has(MISTRAL_DISPATCH_CONFIG.cooldownKey)).toBe(true)
    })

    it('Mistral being in cooldown does not block DeepSeek', async () => {
      const fetchSpy = vi.fn(async (_url: string, _opts?: RequestInit) => new Response(null, { status: 204 }))
      vi.stubGlobal('fetch', fetchSpy)
      const kv = mockKV({ [MISTRAL_DISPATCH_CONFIG.cooldownKey]: '1' })

      await maybeDispatchWorkflow({ GH_DISPATCH_TOKEN: 't', STATUS_CACHE: kv as unknown as KVNamespace }, DEEPSEEK_DISPATCH_CONFIG)
      expect(fetchSpy).toHaveBeenCalledOnce()
      expect(fetchSpy.mock.calls[0][0]).toContain('/actions/workflows/deepseek-feed.yml/dispatches')
    })
  })

  describe('MISTRAL_DISPATCH_CONFIG', () => {
    it('dispatches + sets a ~55min cooldown on HTTP 204', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
      const kv = mockKV()
      await maybeDispatchWorkflow({ GH_DISPATCH_TOKEN: 't', STATUS_CACHE: kv as unknown as KVNamespace }, MISTRAL_DISPATCH_CONFIG)
      expect(kv.put).toHaveBeenCalledWith(MISTRAL_DISPATCH_CONFIG.cooldownKey, '1', { expirationTtl: 55 * 60 })
    })

    it('on failure, backs off to the SAME cooldown as success — not further (#1395: 55min is already the normal cadence, not a back-off)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 401 })))
      const kv = mockKV()
      await maybeDispatchWorkflow({ GH_DISPATCH_TOKEN: 't', STATUS_CACHE: kv as unknown as KVNamespace }, MISTRAL_DISPATCH_CONFIG)
      expect(kv.put).toHaveBeenCalledWith(MISTRAL_DISPATCH_CONFIG.cooldownKey, '1', { expirationTtl: 55 * 60 })
    })
  })
})
