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
