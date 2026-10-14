import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFetchTracker, fetchWithTimeout, fetchLegOf, budgetShareBucket, type FetchLeg, type FetchLegStats } from '../utils'
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
    expect(tracker.stats()).toMatchObject({ maxInFlight: 1, answered: 2, timeouts: 0, httpErrors: 1, otherErrors: 1, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 })
  })

  it('fetchAllServices counts every fetch of a run whose sources all answer 404', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 404 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { fetchStats } = await fetchAllServices()
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(0)
    expect(fetchStats.answered + fetchStats.timeouts + fetchStats.otherErrors).toBe(fetchSpy.mock.calls.length)
  }, 60_000)

  it('fetchAllServices hands back the per-leg split, and the legs add up to the run', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { urls.push(String(input)); return new Response('{}', { status: 404 }) }))
    const { fetchStats } = await fetchAllServices()
    const legs = fetchStats.legs!
    expect(legs.length).toBeGreaterThan(0)
    const sum = (pick: (l: FetchLegStats) => number) => legs.reduce((n, l) => n + pick(l), 0)
    expect(sum((l) => l.answered)).toBe(fetchStats.answered)
    expect(sum((l) => l.timeouts)).toBe(fetchStats.timeouts)
    expect(sum((l) => l.httpErrors)).toBe(fetchStats.httpErrors)
    expect(sum((l) => l.otherErrors)).toBe(fetchStats.otherErrors)
    const answered = (leg: FetchLeg) => legs.filter((l) => l.leg === leg).reduce((n, l) => n + l.answered, 0)
    expect(answered('summary')).toBeGreaterThan(0)
    expect(answered('incidents')).toBeGreaterThan(0)
    expect(sum((l) => l.answered)).toBe(urls.length)
    expect(legs.every((l) => l.budgetMs > 0)).toBe(true)
  }, 60_000)
})

describe('#1489 fetchLegOf — which leg of a page\'s chain a URL is', () => {
  it.each([
    ['https://status.claude.com/api/v2/summary.json', 'summary'],
    ['https://status.claude.com/api/v2/incidents.json', 'incidents'],
    ['https://status.openai.com/api/v2/components.json', 'components'],
    ['https://status.claude.com/uptime_showcase?components=a,b', 'showcase'],
    ['https://status.claude.com', 'html'],
    ['https://status.claude.com/', 'html'],
    ['https://global.status.smith.langchain.com/gcp-us', 'other'],
    ['https://www.cloudflarestatus.com/api/v3/summary', 'other'],
    ['https://status.cloud.google.com/incidents.json', 'other'],
    ['https://example.betteruptime.com/index.json', 'other'],
    ['https://status.together.ai/feed', 'other'],
    ['https://health.aws.amazon.com/public/events', 'other'],
    ['not a url', 'other'],
  ] as const)('%s -> %s', (url, leg) => {
    expect(fetchLegOf(url)).toBe(leg)
  })
})

describe('#1489 per-leg accounting', () => {
  const SUMMARY = 'https://status.claude.com/api/v2/summary.json'
  const SHOWCASE = 'https://status.claude.com/uptime_showcase?components=a'
  const ROOT = 'https://status.together.ai/'
  const find = (legs: FetchLegStats[] | undefined, leg: FetchLeg, budgetMs: number) => legs!.find((l) => l.leg === leg && l.budgetMs === budgetMs)!

  function deferred() {
    let resolve!: (r: Response) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<Response>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  async function answerAfter(tracker: ReturnType<typeof createFetchTracker>, setClock: (ms: number) => void, url: string, budgetMs: number, ms: number) {
    const d = deferred()
    const run = tracker.track(() => d.promise, url, budgetMs)
    setClock(ms)
    d.resolve(new Response('{}'))
    await run
  }

  it('puts an answer in the fifth of its own timeout that it used', async () => {
    let t = 0
    const tracker = createFetchTracker(() => t)
    for (const ms of [100, 300, 500, 700, 900]) {
      const start = t
      await answerAfter(tracker, (d) => { t = start + d }, SHOWCASE, 1000, ms)
    }
    expect(find(tracker.stats().legs, 'showcase', 1000).answeredByBudgetShare).toEqual([1, 1, 1, 1, 1])
  })

  it('reads the same answer against each leg\'s own budget: 2 s is a fifth of 8 s and two thirds of 3 s', async () => {
    let t = 0
    const tracker = createFetchTracker(() => t)
    await answerAfter(tracker, (d) => { t += d }, SUMMARY, 8000, 2000)
    await answerAfter(tracker, (d) => { t += d }, SHOWCASE, 3000, 2000)
    const { legs } = tracker.stats()
    expect(find(legs, 'summary', 8000).answeredByBudgetShare).toEqual([0, 1, 0, 0, 0])
    expect(find(legs, 'showcase', 3000).answeredByBudgetShare).toEqual([0, 0, 0, 1, 0])
  })

  it.each([
    [0, 1000, 0], [199, 1000, 0], [200, 1000, 1], [999, 1000, 4], [1000, 1000, 4], [5000, 1000, 4], [-5, 1000, 0], [10, 0, 0],
  ])('%i ms of a %i ms timeout is bucket %i', (elapsed, budget, bucket) => {
    expect(budgetShareBucket(elapsed, budget)).toBe(bucket)
  })

  it('keeps one leg\'s timeouts apart by the timeout they were given', async () => {
    const tracker = createFetchTracker(() => 0)
    for (const budget of [3000, 5000, 8000, 8000]) {
      await tracker.track(() => Promise.reject(new DOMException('aborted', 'AbortError')), ROOT, budget).catch(() => null)
    }
    const html = tracker.stats().legs!.filter((l) => l.leg === 'html')
    expect(html.map((l) => [l.budgetMs, l.timeouts]).sort((a, b) => a[0] - b[0])).toEqual([[3000, 1], [5000, 1], [8000, 2]])
  })

  it('counts a timeout in its own leg only', async () => {
    const tracker = createFetchTracker(() => 0)
    await tracker.track(() => Promise.reject(new DOMException('aborted', 'AbortError')), SHOWCASE, 3000).catch(() => null)
    await tracker.track(async () => new Response('{}'), SUMMARY, 8000)
    const { legs } = tracker.stats()
    expect(find(legs, 'showcase', 3000)).toMatchObject({ timeouts: 1, answered: 0 })
    expect(find(legs, 'summary', 8000)).toMatchObject({ timeouts: 0, answered: 1 })
  })

  it('sums the time to headers over a leg and keeps its maximum, not its last value', async () => {
    let t = 0
    const tracker = createFetchTracker(() => t)
    for (const ms of [100, 300, 200]) {
      const start = t
      await answerAfter(tracker, (d) => { t = start + d }, SUMMARY, 8000, ms)
    }
    const leg = find(tracker.stats().legs, 'summary', 8000)
    expect(leg.answeredMs).toBe(600)
    expect(leg.maxAnsweredMs).toBe(300)
  })

  it('a leg\'s answered count always equals the sum of its budget-share buckets', async () => {
    let t = 0
    const tracker = createFetchTracker(() => t)
    const holds = Array.from({ length: 40 }, () => deferred())
    const runs = holds.map((d, i) => tracker.track(() => d.promise, i % 2 ? SUMMARY : SHOWCASE, i % 2 ? 8000 : 3000).catch(() => null))
    t = 900
    holds.forEach((d, i) => (i % 5 === 0 ? d.reject(new DOMException('aborted', 'AbortError')) : d.resolve(new Response('{}'))))
    await Promise.all(runs)
    const { legs } = tracker.stats()
    for (const l of legs!) expect(l.answeredByBudgetShare.reduce((a, b) => a + b, 0)).toBe(l.answered)
    expect(legs!.reduce((n, l) => n + l.answered, 0)).toBe(32)
    expect(legs!.reduce((n, l) => n + l.timeouts, 0)).toBe(8)
  })

  it('counts a non-2xx and an error in their own leg, and a fetch with no URL in other', async () => {
    const tracker = createFetchTracker(() => 0)
    await tracker.track(async () => new Response('', { status: 503 }), SHOWCASE, 3000)
    await tracker.track(async () => { throw new TypeError('reset') }, SUMMARY, 8000).catch(() => null)
    await tracker.track(async () => new Response('{}'))
    const { legs } = tracker.stats()
    expect(find(legs, 'showcase', 3000)).toMatchObject({ answered: 1, httpErrors: 1, otherErrors: 0 })
    expect(find(legs, 'summary', 8000)).toMatchObject({ answered: 0, httpErrors: 0, otherErrors: 1 })
    expect(find(legs, 'other', 0).answered).toBe(1)
  })

  it('hands out a copy: a later fetch does not change an earlier reading', async () => {
    const tracker = createFetchTracker(() => 0)
    await tracker.track(async () => new Response('{}'), SUMMARY, 8000)
    const before = tracker.stats()
    await tracker.track(async () => new Response('{}'), SUMMARY, 8000)
    expect(find(before.legs, 'summary', 8000).answered).toBe(1)
    expect(find(before.legs, 'summary', 8000).answeredByBudgetShare).toEqual([1, 0, 0, 0, 0])
  })
})
