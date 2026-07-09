import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ANTHROPIC_MODEL,
  AI_GATEWAY_ANTHROPIC_URL,
  anthropicRequestBody,
  classifyAnthropicStatus,
  parseRetryAfterMs,
  callAnthropicMessages,
  sleep,
  RETRY_AFTER_CAP_MS,
} from '../anthropic'

/** Minimal Response stand-in — `callAnthropicMessages` only touches these members. */
function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

const textResponse = (text: string) => res(200, { content: [{ type: 'text', text }] })

const noSleep = async () => {}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('model pin (#955 Part 1)', () => {
  // The bug: `claude-sonnet-4-20250514` was hardcoded in #21 (2026-03-26), reached its
  // 2026-06-15 retirement, and started 404ing. Nothing in the codebase would have noticed.
  it('does not use a retired Sonnet 4 model id', () => {
    expect(ANTHROPIC_MODEL).not.toMatch(/^claude-sonnet-4/)
    expect(ANTHROPIC_MODEL).toBe('claude-sonnet-5')
  })

  it('routes through the Cloudflare AI Gateway', () => {
    expect(AI_GATEWAY_ANTHROPIC_URL).toContain('gateway.ai.cloudflare.com')
    expect(AI_GATEWAY_ANTHROPIC_URL).toMatch(/\/anthropic\/v1\/messages$/)
  })

  // Sonnet 5 selects ADAPTIVE thinking when `thinking` is omitted (Sonnet 4 ran thinking-off).
  // Thinking tokens come out of max_tokens, so an adaptive run on a complex incident could
  // truncate the JSON. Disabling it makes the output budget deterministic. (Measured 2026-07-09:
  // on a representative prompt Sonnet 5 emitted no thinking block either way — a guard, not a fix.)
  it('explicitly disables thinking', () => {
    expect(anthropicRequestBody('sys', 'user', 600)).toMatchObject({
      model: 'claude-sonnet-5',
      max_tokens: 600,
      thinking: { type: 'disabled' },
      system: 'sys',
      messages: [{ role: 'user', content: 'user' }],
    })
  })
})

describe('classifyAnthropicStatus', () => {
  // A retired-model 404 and a 529 overload both used to collapse to `null`, so the one that
  // deserved a retry never got one and the one that didn't was retried forever.
  it.each([408, 429, 500, 502, 503, 529])('treats %i as transient', (status) => {
    expect(classifyAnthropicStatus(status)).toBe('transient')
  })

  it.each([400, 401, 403, 404, 413, 422])('treats %i as permanent', (status) => {
    expect(classifyAnthropicStatus(status)).toBe('permanent')
  })
})

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds and clamps to the cap', () => {
    expect(parseRetryAfterMs('1')).toBe(1000)
    expect(parseRetryAfterMs('600')).toBe(RETRY_AFTER_CAP_MS)
  })

  it('ignores absent, non-numeric and HTTP-date values', () => {
    expect(parseRetryAfterMs(null)).toBeNull()
    expect(parseRetryAfterMs('Wed, 09 Jul 2026 13:00:00 GMT')).toBeNull()
    expect(parseRetryAfterMs('-3')).toBeNull()
  })
})

describe('callAnthropicMessages', () => {
  it('returns the text block on 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('hello'))
    const out = await callAnthropicMessages('k', { system: 's', user: 'u', maxTokens: 600, fetchImpl, sleepImpl: noSleep })
    expect(out).toEqual({ kind: 'ok', text: 'hello' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('sends the pinned model + api key + version headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('ok'))
    await callAnthropicMessages('secret-key', { system: 's', user: 'u', maxTokens: 600, fetchImpl, sleepImpl: noSleep })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(AI_GATEWAY_ANTHROPIC_URL)
    expect(init.headers['x-api-key']).toBe('secret-key')
    expect(init.headers['anthropic-version']).toBe('2023-06-01')
    expect(JSON.parse(init.body).model).toBe(ANTHROPIC_MODEL)
    expect(JSON.parse(init.body).thinking).toEqual({ type: 'disabled' })
  })

  // The exact production failure: a retired model id. Retrying it is pure waste.
  it('does NOT retry a 404 and reports it as permanent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(404, 'model not found'))
    const out = await callAnthropicMessages('k', { system: 's', user: 'u', maxTokens: 600, fetchImpl, sleepImpl: noSleep })
    expect(out).toMatchObject({ kind: 'permanent', status: 404 })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('retries a 529 once, then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(529, 'overloaded'))
      .mockResolvedValueOnce(textResponse('second try'))
    const out = await callAnthropicMessages('k', { system: 's', user: 'u', maxTokens: 600, fetchImpl, sleepImpl: noSleep })
    expect(out).toEqual({ kind: 'ok', text: 'second try' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('honours retry-after when retrying', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined)
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(429, 'slow down', { 'retry-after': '1' }))
      .mockResolvedValueOnce(textResponse('ok'))
    await callAnthropicMessages('k', { system: 's', user: 'u', maxTokens: 600, fetchImpl, sleepImpl })
    expect(sleepImpl).toHaveBeenCalledWith(1000, undefined)
  })

  it('reports transient when the retry also fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(503, 'down'))
    const out = await callAnthropicMessages('k', { system: 's', user: 'u', maxTokens: 600, fetchImpl, sleepImpl: noSleep })
    expect(out).toMatchObject({ kind: 'transient', status: 503 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('reports a network error as transient after retrying', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('connection reset'))
    const out = await callAnthropicMessages('k', { system: 's', user: 'u', maxTokens: 600, fetchImpl, sleepImpl: noSleep })
    expect(out).toMatchObject({ kind: 'transient', status: null })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  // A 200 whose body carries no text block means the model spent its budget on thinking or
  // was truncated. The identical prompt would reproduce it, so it must not be retried.
  it('treats a 200 with no text block as permanent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, { content: [] }))
    const out = await callAnthropicMessages('k', { system: 's', user: 'u', maxTokens: 600, fetchImpl, sleepImpl: noSleep })
    expect(out).toMatchObject({ kind: 'permanent', status: 200 })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('never throws — even on a malformed 200 body', async () => {
    const bad = { ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error('bad json') }, text: async () => '' } as unknown as Response
    const out = await callAnthropicMessages('k', { system: 's', user: 'u', maxTokens: 600, fetchImpl: vi.fn().mockResolvedValue(bad), sleepImpl: noSleep })
    expect(out.kind).toBe('permanent')
  })

  // #955 Part 2 — the outer budget must win. Before, a Sonnet response arriving after the
  // 8s race had already resolved was paid for and silently discarded.
  it('returns aborted:budget when the caller signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const fetchImpl = vi.fn()
    const out = await callAnthropicMessages('k', { system: 's', user: 'u', maxTokens: 600, signal: ctrl.signal, fetchImpl, sleepImpl: noSleep })
    expect(out).toEqual({ kind: 'aborted', reason: 'budget' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('stops retrying once the caller budget aborts mid-backoff', async () => {
    const ctrl = new AbortController()
    const fetchImpl = vi.fn().mockResolvedValue(res(503, 'down'))
    const sleepImpl = vi.fn().mockImplementation(async () => { ctrl.abort(); throw new Error('aborted') })
    const out = await callAnthropicMessages('k', { system: 's', user: 'u', maxTokens: 600, signal: ctrl.signal, fetchImpl, sleepImpl })
    expect(out).toEqual({ kind: 'aborted', reason: 'budget' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('propagates an abort signal into the fetch call', async () => {
    const ctrl = new AbortController()
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('ok'))
    await callAnthropicMessages('k', { system: 's', user: 'u', maxTokens: 600, signal: ctrl.signal, fetchImpl, sleepImpl: noSleep })
    const init = fetchImpl.mock.calls[0][1]
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.signal.aborted).toBe(false)
  })

  it('reports aborted:timeout when every attempt exceeds the per-attempt cap', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }))
    const out = await callAnthropicMessages('k', { system: 's', user: 'u', maxTokens: 600, timeoutMs: 5, retries: 0, fetchImpl, sleepImpl: noSleep })
    expect(out).toEqual({ kind: 'aborted', reason: 'timeout' })
  })
})

describe('sleep', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(sleep(1000, ctrl.signal)).rejects.toThrow('aborted')
  })

  it('rejects when the signal aborts mid-wait', async () => {
    const ctrl = new AbortController()
    const promise = sleep(10_000, ctrl.signal)
    ctrl.abort()
    await expect(promise).rejects.toThrow('aborted')
  })

  it('resolves normally without a signal', async () => {
    await expect(sleep(1)).resolves.toBeUndefined()
  })
})
