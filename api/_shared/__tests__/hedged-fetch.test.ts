import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { hedgedJsonFetch, HEDGE_AFTER_MS, DEADLINE_MS } from '../hedged-fetch'

const URL_ = 'https://worker.test/api/status/cached?series=0'
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// A request that never answers until its signal aborts.
function stall(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })
}
function answerAfter(ms: number, res: () => Response) {
  return (_: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const t = setTimeout(() => resolve(res()), ms)
    init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')) })
  })
}

describe('hedgedJsonFetch (#1531 Part 5)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchMock.mockRestore()
    vi.useRealTimers()
  })

  it('sends one request when the first answers before the hedge point', async () => {
    fetchMock.mockImplementation(answerAfter(HEDGE_AFTER_MS - 1, () => json({ v: 1 })))
    const p = hedgedJsonFetch<{ v: number }>(URL_)
    await vi.advanceTimersByTimeAsync(DEADLINE_MS)
    expect(await p).toEqual({ ok: true, data: { v: 1 }, attempt: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a stalled first request is rescued by the second, which starts at the hedge point', async () => {
    const signals: AbortSignal[] = []
    fetchMock
      .mockImplementationOnce((_u, init) => { signals.push(init!.signal!); return stall(init) })
      .mockImplementationOnce(answerAfter(300, () => json({ v: 2 })))
    const p = hedgedJsonFetch<{ v: number }>(URL_)
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS - 1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(300)
    expect(await p).toEqual({ ok: true, data: { v: 2 }, attempt: 2 })
    expect(signals[0].aborted).toBe(true)
  })

  it('the first request still wins when it answers after the hedge started, and the second is cancelled', async () => {
    const signals: AbortSignal[] = []
    fetchMock
      .mockImplementationOnce(answerAfter(HEDGE_AFTER_MS + 200, () => json({ v: 1 })))
      .mockImplementationOnce((_u, init) => { signals.push(init!.signal!); return stall(init) })
    const p = hedgedJsonFetch<{ v: number }>(URL_)
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS + 200)
    expect(await p).toEqual({ ok: true, data: { v: 1 }, attempt: 1 })
    expect(signals[0].aborted).toBe(true)
  })

  it('both stalled → worker_timeout at the deadline, not later', async () => {
    fetchMock.mockImplementation((_u, init) => stall(init))
    let result: unknown
    void hedgedJsonFetch(URL_).then((r) => { result = r })
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toEqual({ ok: false, reason: 'worker_timeout' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('an HTTP failure before the hedge point is returned at once, with no second request', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'no cached data' }, 503))
    const p = hedgedJsonFetch(URL_)
    await vi.advanceTimersByTimeAsync(0)
    expect(await p).toEqual({ ok: false, reason: 'worker_http_503' })
    await vi.advanceTimersByTimeAsync(DEADLINE_MS)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a failed second request does not end the wait for a first that later answers', async () => {
    fetchMock
      .mockImplementationOnce(answerAfter(HEDGE_AFTER_MS + 1000, () => json({ v: 1 })))
      .mockResolvedValueOnce(json({}, 502))
    const p = hedgedJsonFetch<{ v: number }>(URL_)
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS + 1000)
    expect(await p).toEqual({ ok: true, data: { v: 1 }, attempt: 1 })
  })

  it('a stalled first and a failed second report the failure, not worker_timeout', async () => {
    fetchMock
      .mockImplementationOnce((_u, init) => stall(init))
      .mockResolvedValueOnce(json({}, 502))
    const p = hedgedJsonFetch(URL_)
    await vi.advanceTimersByTimeAsync(DEADLINE_MS)
    expect(await p).toEqual({ ok: false, reason: 'worker_http_502' })
  })

  it('labels each failure class', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await hedgedJsonFetch(URL_)).toEqual({ ok: false, reason: 'worker_unreachable' })
    fetchMock.mockResolvedValueOnce(new Response('{not json'))
    expect(await hedgedJsonFetch(URL_)).toEqual({ ok: false, reason: 'parse_error' })
  })
})

describe('hedgedJsonFetch lastGood (#1531 Part 7)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchMock.mockRestore()
    vi.useRealTimers()
  })
  const copy = (data: unknown, afterMs = 50) => vi.fn((signal: AbortSignal) => new Promise<unknown>((resolve, reject) => {
    const t = setTimeout(() => resolve(data), afterMs)
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')) })
  }))

  it('both Worker requests stalled: the copy, started with the hedge, answers at the deadline', async () => {
    fetchMock.mockImplementation((_u, init) => stall(init))
    const lastGood = copy({ v: 'copy' })
    const p = hedgedJsonFetch(URL_, { lastGood })
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS - 1)
    expect(lastGood).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(lastGood).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(DEADLINE_MS)
    expect(await p).toEqual({ ok: true, data: { v: 'copy' }, attempt: 'copy', reason: 'worker_timeout' })
  })

  it('an early Worker failure starts the copy at once and carries the failure reason', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'no cached data' }, 503))
    const lastGood = copy({ v: 'copy' })
    const p = hedgedJsonFetch(URL_, { lastGood })
    await vi.advanceTimersByTimeAsync(50)
    expect(await p).toEqual({ ok: true, data: { v: 'copy' }, attempt: 'copy', reason: 'worker_http_503' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('after an early failure, a copy that lands after the hedge waits for the hedged request, which wins', async () => {
    fetchMock
      .mockImplementationOnce(answerAfter(100, () => json({}, 502)))
      .mockImplementationOnce(answerAfter(1200, () => json({ v: 2 })))
    const lastGood = copy({ v: 'copy' }, HEDGE_AFTER_MS)
    const p = hedgedJsonFetch(URL_, { lastGood })
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS + 1200)
    expect(await p).toEqual({ ok: true, data: { v: 2 }, attempt: 2 })
    expect(lastGood).toHaveBeenCalledTimes(1)
  })

  it('after an early failure, the copy answers once the hedged request has failed too', async () => {
    fetchMock
      .mockImplementationOnce(answerAfter(100, () => json({}, 502)))
      .mockImplementationOnce(answerAfter(1200, () => json({}, 503)))
    const p = hedgedJsonFetch(URL_, { lastGood: copy({ v: 'copy' }, HEDGE_AFTER_MS) })
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS + 1200)
    expect(await p).toEqual({ ok: true, data: { v: 'copy' }, attempt: 'copy', reason: 'worker_http_502' })
  })

  it('a Worker answer wins over the copy, and the copy read is cancelled', async () => {
    let copySignal: AbortSignal | undefined
    fetchMock
      .mockImplementationOnce((_u, init) => stall(init))
      .mockImplementationOnce(answerAfter(300, () => json({ v: 2 })))
    const lastGood = vi.fn((signal: AbortSignal) => { copySignal = signal; return new Promise<unknown>(() => {}) })
    const p = hedgedJsonFetch(URL_, { lastGood })
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS + 300)
    expect(await p).toEqual({ ok: true, data: { v: 2 }, attempt: 2 })
    expect(copySignal?.aborted).toBe(true)
  })

  it('no copy (null) or a copy still pending at the deadline is the Worker failure', async () => {
    fetchMock.mockImplementation((_u, init) => stall(init))
    const empty = hedgedJsonFetch(URL_, { lastGood: copy(null) })
    await vi.advanceTimersByTimeAsync(DEADLINE_MS)
    expect(await empty).toEqual({ ok: false, reason: 'worker_timeout' })
    const slow = hedgedJsonFetch(URL_, { lastGood: copy({ v: 'late' }, DEADLINE_MS) })
    await vi.advanceTimersByTimeAsync(DEADLINE_MS)
    expect(await slow).toEqual({ ok: false, reason: 'worker_timeout' })
  })

  it('a copy read that throws is a missing copy', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 502))
    const p = hedgedJsonFetch(URL_, { lastGood: async () => { throw new Error('blob down') } })
    await vi.advanceTimersByTimeAsync(0)
    expect(await p).toEqual({ ok: false, reason: 'worker_http_502' })
  })
})
