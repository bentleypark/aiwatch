import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFetchTracker, fetchWithTimeout } from '../utils'
import { fetchAllServices } from '../services'

const CONNECTIONS = 6

function hangUntilAborted(init?: RequestInit) {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')))
  })
}

describe('#1489 fetch tracker', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('never holds a fetch back — every send starts at once, past the connection count', () => {
    const tracker = createFetchTracker()
    const started: number[] = []
    for (let i = 0; i < CONNECTIONS * 2; i++) {
      void tracker.track(() => { started.push(i); return new Promise<Response>(() => {}) })
    }
    expect(started).toHaveLength(CONNECTIONS * 2)
    expect(tracker.stats().maxInFlight).toBe(CONNECTIONS * 2)
  })

  it('starts the timeout at the fetch() call, not after a wait for a slot', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => hangUntilAborted(init)))
    const tracker = createFetchTracker()
    const reads = Array.from({ length: CONNECTIONS + 1 }, (_, i) =>
      fetchWithTimeout(`https://upstream.test/${i}`, 1000, undefined, tracker).catch((err: Error) => err.name))
    await vi.advanceTimersByTimeAsync(1000)
    expect(await Promise.all(reads)).toEqual(Array(CONNECTIONS + 1).fill('AbortError'))
  })

  it('sums the other fetches waiting at each start, apart for timeouts and for answers', async () => {
    vi.useFakeTimers()
    let call = 0
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
      call++ < 2 ? Promise.resolve(new Response('{}')) : hangUntilAborted(init)))
    const tracker = createFetchTracker()
    const answered = [0, 1].map((i) => fetchWithTimeout(`https://upstream.test/${i}`, 1000, undefined, tracker))
    await Promise.all(answered)
    const timedOut = [2, 3, 4].map((i) => fetchWithTimeout(`https://upstream.test/${i}`, 1000, undefined, tracker).catch(() => null))
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.all(timedOut)
    // answered started with 0 and 1 others waiting; the timeouts with 0, 1 and 2.
    expect(tracker.stats()).toMatchObject({ answered: 2, waitingAtStartAnswered: 1, timeouts: 3, waitingAtStartTimeouts: 3 })
  })

  it('counts a non-2xx response as answered and a non-timeout error apart from timeouts', async () => {
    const tracker = createFetchTracker()
    await tracker.track(async () => new Response('', { status: 503 }))
    await tracker.track(async () => new Response('{}', { status: 200 }))
    await tracker.track(async () => { throw new TypeError('connection reset') }).catch(() => null)
    expect(tracker.stats()).toEqual({ maxInFlight: 1, answered: 2, timeouts: 0, httpErrors: 1, otherErrors: 1, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 })
  })

  it('fetchAllServices counts every fetch of a run whose sources all answer 404', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 404 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { fetchStats } = await fetchAllServices()
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(0)
    expect(fetchStats.answered + fetchStats.timeouts + fetchStats.otherErrors).toBe(fetchSpy.mock.calls.length)
  }, 60_000)
})
