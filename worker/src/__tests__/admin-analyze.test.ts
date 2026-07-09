// #299 — admin-only endpoint to force a Sonnet analysis on a specific active
// incident. Tests cover the four documented failure modes (auth, scope, rate
// limit, upstream fail) plus happy path.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import workerModule, { constantTimeEqual, adminRateLimitKey, isStickyExistingAnalysis } from '../index'
import type { ServiceStatus, Incident } from '../types'

// In-memory KV with spies for assertion.
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

function makeIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'inc-abc',
    title: 'Elevated error rates',
    status: 'investigating',
    impact: 'major',
    startedAt: '2026-04-20T10:00:00Z',
    resolvedAt: null,
    duration: null,
    timeline: [{ stage: 'investigating', text: 'Initial report', at: '2026-04-20T10:00:00Z' }],
    ...overrides,
  }
}

function makeService(overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    id: 'chatgpt',
    name: 'ChatGPT',
    provider: 'OpenAI',
    category: 'app',
    status: 'degraded',
    latency: null,
    uptime30d: 99.9,
    lastChecked: '2026-04-20T10:00:00Z',
    incidents: [makeIncident()],
    ...overrides,
  }
}

function seedServicesLatest(store: Record<string, string>, services: ServiceStatus[]) {
  store['services:latest'] = JSON.stringify({ services, cachedAt: new Date().toISOString() })
}

function envWith(opts: { adminKey?: string; anthropicKey?: string; kv: KVNamespace }) {
  return {
    ALLOWED_ORIGIN: '*',
    STATUS_CACHE: opts.kv,
    ANTHROPIC_API_KEY: opts.anthropicKey,
    ADMIN_API_KEY: opts.adminKey,
  } as Parameters<typeof workerModule.fetch>[1]
}

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/api/admin/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const mockSonnetResult = {
  summary: 'Systemic infrastructure failure across API Platform',
  estimatedRecovery: '1–2h',
  estimatedRecoveryHours: 2,
  affectedScope: ['API', 'ChatGPT'],
  needsFallback: true,
  analyzedAt: '2026-04-20T10:15:00Z',
  incidentId: 'inc-abc',
  model: 'sonnet' as const,
}

describe('constantTimeEqual (#299)', () => {
  it('returns true for equal strings', () => {
    expect(constantTimeEqual('secret-xyz', 'secret-xyz')).toBe(true)
  })
  it('returns false for length mismatch', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
  })
  it('returns false for same-length different strings', () => {
    expect(constantTimeEqual('secret-xyz', 'secret-abc')).toBe(false)
  })
  it('returns true for two empty strings', () => {
    // Defensive: env.ADMIN_API_KEY missing would be rejected earlier; but the
    // comparator itself should handle the edge case without special-casing.
    expect(constantTimeEqual('', '')).toBe(true)
  })
})

describe('isStickyExistingAnalysis (#299)', () => {
  // Guard for the cron new-incident write path (symmetric with refreshOrReanalyze).
  // Without this check, a manual /api/admin/analyze call that lands between two
  // cron cycles for a brand-new incident would get clobbered by the cron's
  // default Gemma-first write.
  it('returns true when existing analysis has sticky=true', () => {
    expect(isStickyExistingAnalysis(JSON.stringify({ summary: 'x', sticky: true }))).toBe(true)
  })
  it('returns false when existing analysis is sticky=false', () => {
    expect(isStickyExistingAnalysis(JSON.stringify({ summary: 'x', sticky: false }))).toBe(false)
  })
  it('returns false when sticky field is absent (not a truthy check)', () => {
    expect(isStickyExistingAnalysis(JSON.stringify({ summary: 'x' }))).toBe(false)
  })
  it('returns false on null/empty input (no existing analysis)', () => {
    expect(isStickyExistingAnalysis(null)).toBe(false)
    expect(isStickyExistingAnalysis('')).toBe(false)
  })
  it('returns false on corrupt JSON — does not lock the key during parse failures', () => {
    // Safer default: if JSON is corrupt we DON'T want to be stuck with a dead-sticky
    // payload that can never be overwritten. Treat as non-sticky and let the cron
    // proceed with its normal write.
    expect(isStickyExistingAnalysis('{not json')).toBe(false)
  })
  it('ignores truthy but non-literal-true values (sticky: "yes" not equal to true)', () => {
    // Strict `=== true` — avoids accidentally sticking on typos or legacy payloads
    // where the field might be 1 / "true" / "yes".
    expect(isStickyExistingAnalysis(JSON.stringify({ sticky: 1 }))).toBe(false)
    expect(isStickyExistingAnalysis(JSON.stringify({ sticky: 'true' }))).toBe(false)
  })
})

describe('adminRateLimitKey (#299)', () => {
  it('produces a stable admin:ratelimit: prefixed key', async () => {
    const k = await adminRateLimitKey('chatgpt', 'inc-abc')
    expect(k.startsWith('admin:ratelimit:')).toBe(true)
    // 32 hex chars after prefix (we truncate to 128-bit — 32 hex digits).
    expect(k.length).toBe('admin:ratelimit:'.length + 32)
  })
  it('is deterministic for the same input', async () => {
    const a = await adminRateLimitKey('svc', 'inc')
    const b = await adminRateLimitKey('svc', 'inc')
    expect(a).toBe(b)
  })
  it('differs for different inputs', async () => {
    const a = await adminRateLimitKey('svc', 'inc-1')
    const b = await adminRateLimitKey('svc', 'inc-2')
    expect(a).not.toBe(b)
  })
})

describe('POST /api/admin/analyze (#299)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns 401 when ADMIN_API_KEY is not configured', async () => {
    const { kv } = makeKV()
    const env = envWith({ kv })
    const res = await workerModule.fetch(req({}), env, {} as ExecutionContext)
    expect(res.status).toBe(401)
    const body = await res.json() as { ok: boolean; error: string }
    expect(body).toEqual({ ok: false, error: 'unauthorized' })
  })

  it('returns 401 when X-Admin-Key is missing or wrong', async () => {
    const { kv } = makeKV()
    const env = envWith({ adminKey: 'correct-key', kv })
    // Missing header
    const res1 = await workerModule.fetch(req({}), env, {} as ExecutionContext)
    expect(res1.status).toBe(401)
    // Wrong header
    const res2 = await workerModule.fetch(req({}, { 'X-Admin-Key': 'wrong' }), env, {} as ExecutionContext)
    expect(res2.status).toBe(401)
  })

  it('returns 503 when ANTHROPIC_API_KEY is missing', async () => {
    const { kv } = makeKV()
    const env = envWith({ adminKey: 'k', kv })  // no anthropicKey
    const res = await workerModule.fetch(req({ svcId: 'chatgpt', incidentId: 'inc-abc' }, { 'X-Admin-Key': 'k' }), env, {} as ExecutionContext)
    expect(res.status).toBe(503)
  })

  it('returns 400 when svcId or incidentId is missing', async () => {
    const { kv } = makeKV()
    const env = envWith({ adminKey: 'k', anthropicKey: 'sk-test', kv })
    const res = await workerModule.fetch(req({ svcId: 'chatgpt' }, { 'X-Admin-Key': 'k' }), env, {} as ExecutionContext)
    expect(res.status).toBe(400)
  })

  it('returns 404 when incident is not in services:latest (scope guard)', async () => {
    // Scope guard: prevent admin endpoint from writing arbitrary KV keys even if
    // the secret leaks — the IDs must match something the cron is actively tracking.
    const { kv, store } = makeKV()
    seedServicesLatest(store, [makeService()])  // only inc-abc is active
    const env = envWith({ adminKey: 'k', anthropicKey: 'sk-test', kv })
    const res = await workerModule.fetch(req({ svcId: 'chatgpt', incidentId: 'FAKE-ID' }, { 'X-Admin-Key': 'k' }), env, {} as ExecutionContext)
    expect(res.status).toBe(404)

    // Rate-limit key MUST NOT be written for non-accepting paths — a future
    // refactor that moved the write above the scope guard would let an attacker
    // enumerate incident IDs by watching for 429s.
    const rlKey = await adminRateLimitKey('chatgpt', 'FAKE-ID')
    expect(store[rlKey]).toBeUndefined()
  })

  it('returns 404 when services:latest is missing (cold KV)', async () => {
    const { kv } = makeKV()  // no services:latest seeded
    const env = envWith({ adminKey: 'k', anthropicKey: 'sk-test', kv })
    const res = await workerModule.fetch(req({ svcId: 'chatgpt', incidentId: 'inc-abc' }, { 'X-Admin-Key': 'k' }), env, {} as ExecutionContext)
    expect(res.status).toBe(404)
  })

  it('returns 404 when incident is already resolved (must be active)', async () => {
    const { kv, store } = makeKV()
    seedServicesLatest(store, [makeService({ incidents: [makeIncident({ status: 'resolved' })] })])
    const env = envWith({ adminKey: 'k', anthropicKey: 'sk-test', kv })
    const res = await workerModule.fetch(req({ svcId: 'chatgpt', incidentId: 'inc-abc' }, { 'X-Admin-Key': 'k' }), env, {} as ExecutionContext)
    expect(res.status).toBe(404)
  })

  it('returns 429 when rate limit key is already present', async () => {
    const { kv, store } = makeKV()
    seedServicesLatest(store, [makeService()])
    // Pre-seed the rate-limit key for this svcId+incidentId.
    const rlKey = await adminRateLimitKey('chatgpt', 'inc-abc')
    store[rlKey] = '1'
    const env = envWith({ adminKey: 'k', anthropicKey: 'sk-test', kv })
    const res = await workerModule.fetch(req({ svcId: 'chatgpt', incidentId: 'inc-abc' }, { 'X-Admin-Key': 'k' }), env, {} as ExecutionContext)
    expect(res.status).toBe(429)
  })

  it('happy path — writes analysis with sticky=true and bumps ai:usage counter', async () => {
    const { kv, store } = makeKV()
    seedServicesLatest(store, [makeService()])
    // Stub the Sonnet fetch so we don't hit AI Gateway.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify({
        summary: mockSonnetResult.summary,
        estimatedRecovery: mockSonnetResult.estimatedRecovery,
        affectedScope: mockSonnetResult.affectedScope,
        needsFallback: mockSonnetResult.needsFallback,
      }) }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    const env = envWith({ adminKey: 'k', anthropicKey: 'sk-test', kv })
    const res = await workerModule.fetch(req({ svcId: 'chatgpt', incidentId: 'inc-abc' }, { 'X-Admin-Key': 'k' }), env, {} as ExecutionContext)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; wrote: string; ttl: number; analysis: { sticky?: boolean; model?: string } }
    expect(body.ok).toBe(true)
    expect(body.wrote).toBe('ai:analysis:chatgpt:inc-abc')
    expect(body.ttl).toBe(3600)
    expect(body.analysis.sticky).toBe(true)
    expect(body.analysis.model).toBe('sonnet')

    // KV assertions — analysis persisted, rate-limit key written, ai:usage incremented.
    expect(store['ai:analysis:chatgpt:inc-abc']).toContain('sticky')
    const rlKey = await adminRateLimitKey('chatgpt', 'inc-abc')
    expect(store[rlKey]).toBe('1')
    const usageKey = Object.keys(store).find(k => k.startsWith('ai:usage:'))
    expect(usageKey).toBeDefined()
    const usage = JSON.parse(store[usageKey!])
    expect(usage.calls).toBe(1)
    expect(usage.success).toBe(1)
    expect(usage.sonnet).toBe(1)
  })

  it('honors sticky=false override — writes analysis without sticky field', async () => {
    // Operator can opt out if they want the analysis to be auto-refreshable by the cron.
    const { kv, store } = makeKV()
    seedServicesLatest(store, [makeService()])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify({
        summary: 'S', estimatedRecovery: '1h', affectedScope: ['API'], needsFallback: false,
      }) }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    const env = envWith({ adminKey: 'k', anthropicKey: 'sk-test', kv })
    const res = await workerModule.fetch(
      req({ svcId: 'chatgpt', incidentId: 'inc-abc', sticky: false }, { 'X-Admin-Key': 'k' }),
      env, {} as ExecutionContext,
    )
    expect(res.status).toBe(200)
    const persisted = JSON.parse(store['ai:analysis:chatgpt:inc-abc'])
    // `sticky` should be undefined (not persisted), NOT set to false — matches the
    // "absent = not sticky" convention already used on other optional boolean fields.
    expect(persisted.sticky).toBeUndefined()
  })

  it('returns 502 when Sonnet returns null (upstream parse failure)', async () => {
    const { kv, store } = makeKV()
    seedServicesLatest(store, [makeService()])
    // Respond with garbage that will fail parseAnalysisResponse.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: 'not-json' }],
    }), { status: 200 })))

    const env = envWith({ adminKey: 'k', anthropicKey: 'sk-test', kv })
    const res = await workerModule.fetch(req({ svcId: 'chatgpt', incidentId: 'inc-abc' }, { 'X-Admin-Key': 'k' }), env, {} as ExecutionContext)
    expect(res.status).toBe(502)
    // A 200 whose body doesn't parse is permanent — retrying the same prompt reproduces it.
    expect((await res.json() as { kind: string }).kind).toBe('permanent')
  })

  // #955 — this endpoint is what an operator reaches for WHEN the automated path is broken, so
  // a bare "analysis returned null" is the worst possible answer. It is exactly the ambiguity
  // that let a retired Sonnet model id 404 silently for weeks.
  it('surfaces the upstream status + detail on a permanent 404 (retired model id)', async () => {
    const { kv, store } = makeKV()
    seedServicesLatest(store, [makeService()])
    const fetchMock = vi.fn(async () => new Response('{"type":"error","error":{"type":"not_found_error"}}', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    const env = envWith({ adminKey: 'k', anthropicKey: 'sk-test', kv })
    const res = await workerModule.fetch(req({ svcId: 'chatgpt', incidentId: 'inc-abc' }, { 'X-Admin-Key': 'k' }), env, {} as ExecutionContext)

    expect(res.status).toBe(502)
    const body = await res.json() as { kind: string; status: number; detail: string }
    expect(body.kind).toBe('permanent')
    expect(body.status).toBe(404)
    expect(body.detail).toContain('not_found_error')
    expect(fetchMock).toHaveBeenCalledOnce() // permanent → never retried
  })

  it('reports a 529 overload as transient, after one retry', async () => {
    const { kv, store } = makeKV()
    seedServicesLatest(store, [makeService()])
    const fetchMock = vi.fn(async () => new Response('overloaded', { status: 529 }))
    vi.stubGlobal('fetch', fetchMock)

    const env = envWith({ adminKey: 'k', anthropicKey: 'sk-test', kv })
    const res = await workerModule.fetch(req({ svcId: 'chatgpt', incidentId: 'inc-abc' }, { 'X-Admin-Key': 'k' }), env, {} as ExecutionContext)

    const body = await res.json() as { kind: string; status: number }
    expect(body.kind).toBe('transient')
    expect(body.status).toBe(529)
    expect(fetchMock).toHaveBeenCalledTimes(2) // retried once
  })

  // The model call already happened and already cost money; a failed persist must not erase it
  // from the ledger. `recordUsage` therefore runs BEFORE the `ai:analysis` write.
  it('books a SUCCESSFUL analysis into ai:usage even when the KV persist fails', async () => {
    const { kv, store } = makeKV()
    seedServicesLatest(store, [makeService()])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: '{"summary":"s","estimatedRecovery":"1h","affectedScope":[],"needsFallback":false}' }],
    }), { status: 200 })))
    const realPut = kv.put as unknown as (k: string, v: string, o?: unknown) => Promise<void>
    ;(kv as unknown as { put: unknown }).put = vi.fn(async (k: string, v: string, o?: unknown) => {
      if (k.startsWith('ai:analysis:')) throw new Error('KV unavailable')
      return realPut(k, v, o)
    })

    const env = envWith({ adminKey: 'k', anthropicKey: 'sk-test', kv })
    const res = await workerModule.fetch(req({ svcId: 'chatgpt', incidentId: 'inc-abc' }, { 'X-Admin-Key': 'k' }), env, {} as ExecutionContext)

    expect(res.status).toBe(502)
    expect((await res.json() as { error: string }).error).toBe('KV write failed')
    const usageKey = Object.keys(store).find(k => k.startsWith('ai:usage:'))!
    expect(JSON.parse(store[usageKey])).toMatchObject({ calls: 1, success: 1, sonnet: 1 })
  })

  // The counter used to be bumped only AFTER the `if (!analysis) return 502` guard, so a failed
  // manual analysis incremented neither `calls` nor `failed` — under-reporting exactly the
  // failures the counter exists to surface.
  it('books a FAILED manual analysis into ai:usage', async () => {
    const { kv, store } = makeKV()
    seedServicesLatest(store, [makeService()])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))

    const env = envWith({ adminKey: 'k', anthropicKey: 'sk-test', kv })
    await workerModule.fetch(req({ svcId: 'chatgpt', incidentId: 'inc-abc' }, { 'X-Admin-Key': 'k' }), env, {} as ExecutionContext)

    const usageKey = Object.keys(store).find(k => k.startsWith('ai:usage:'))!
    const usage = JSON.parse(store[usageKey])
    expect(usage).toMatchObject({ calls: 1, success: 0, failed: 1, sonnetAttempts: 1 })
    expect(usage.sonnet).toBeUndefined() // attempted, never succeeded
  })

  it('preserves pre-seeded ai:usage counters — increments rather than overwrites', async () => {
    // Regression guard: `usage = usageRaw ? JSON.parse(raw) : {...}` must read
    // existing counts. A regression to always-init would erase the day's running
    // tally from the cron's own AI calls.
    const { kv, store } = makeKV()
    seedServicesLatest(store, [makeService()])
    const today = new Date().toISOString().slice(0, 10)
    store[`ai:usage:${today}`] = JSON.stringify({ calls: 5, success: 4, failed: 1, gemma: 2, sonnet: 2 })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify({
        summary: 'S', estimatedRecovery: '1h', affectedScope: [], needsFallback: false,
      }) }],
    }), { status: 200 })))

    const env = envWith({ adminKey: 'k', anthropicKey: 'sk-test', kv })
    const res = await workerModule.fetch(req({ svcId: 'chatgpt', incidentId: 'inc-abc' }, { 'X-Admin-Key': 'k' }), env, {} as ExecutionContext)
    expect(res.status).toBe(200)
    const usage = JSON.parse(store[`ai:usage:${today}`])
    expect(usage.calls).toBe(6)    // 5 + 1
    expect(usage.success).toBe(5)  // 4 + 1
    expect(usage.sonnet).toBe(3)   // 2 + 1
    expect(usage.failed).toBe(1)   // unchanged
    expect(usage.gemma).toBe(2)    // unchanged
  })

  it('falls back to sonnet on unrecognized model value (not strict enum)', async () => {
    // `body.model === 'gemma' ? 'gemma' : 'sonnet'` — any non-'gemma' value
    // defaults to sonnet. Intentional (operator typos don't fail the call),
    // but untested until now.
    const { kv, store } = makeKV()
    seedServicesLatest(store, [makeService()])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify({
        summary: 'S', estimatedRecovery: '1h', affectedScope: [], needsFallback: false,
      }) }],
    }), { status: 200 })))

    const env = envWith({ adminKey: 'k', anthropicKey: 'sk-test', kv })
    const res = await workerModule.fetch(
      req({ svcId: 'chatgpt', incidentId: 'inc-abc', model: 'sonnet4' }, { 'X-Admin-Key': 'k' }),
      env, {} as ExecutionContext,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { analysis: { model?: string } }
    expect(body.analysis.model).toBe('sonnet')
  })

  it('accepts explicit sticky=true identically to default', async () => {
    // Default is `sticky === false ? false : true` — explicit `true` must take
    // the same branch so a future refactor to tri-state doesn't silently change
    // the operator-facing contract.
    const { kv, store } = makeKV()
    seedServicesLatest(store, [makeService()])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify({
        summary: 'S', estimatedRecovery: '1h', affectedScope: [], needsFallback: false,
      }) }],
    }), { status: 200 })))

    const env = envWith({ adminKey: 'k', anthropicKey: 'sk-test', kv })
    const res = await workerModule.fetch(
      req({ svcId: 'chatgpt', incidentId: 'inc-abc', sticky: true }, { 'X-Admin-Key': 'k' }),
      env, {} as ExecutionContext,
    )
    expect(res.status).toBe(200)
    const persisted = JSON.parse(store['ai:analysis:chatgpt:inc-abc'])
    expect(persisted.sticky).toBe(true)
  })

  it('returns 400 on malformed JSON body', async () => {
    const { kv, store } = makeKV()
    seedServicesLatest(store, [makeService()])
    const env = envWith({ adminKey: 'k', anthropicKey: 'sk-test', kv })
    const res = await workerModule.fetch(
      new Request('https://example.com/api/admin/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'k' },
        body: 'not-json',
      }),
      env, {} as ExecutionContext,
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('invalid JSON body')
  })
})
