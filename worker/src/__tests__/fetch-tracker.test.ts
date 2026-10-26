import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFetchTracker, fetchWithTimeout, fetchLegOf, budgetShareBucket, launchOrderOf, fetchHostOf, FETCH_TRACE_MAX, type FetchLeg, type FetchLegStats } from '../utils'
import { fetchAllServices, SERVICES } from '../services'

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

describe('#1489 per-fetch trace', () => {
  it('records each fetch in start order with the depth it started at and how it ended', async () => {
    let t = 0
    const tracker = createFetchTracker(() => t)
    let release!: (r: Response) => void
    const first = tracker.track(() => new Promise<Response>((r) => { release = r }), 'https://status.a.test/api/v2/summary.json', 8000)
    const second = tracker.track(async () => new Response('', { status: 503 }), 'https://status.b.test/', 5000)
    const third = tracker.track(async () => { throw new DOMException('aborted', 'AbortError') }, 'https://status.c.test/uptime_showcase?components=x', 3000).catch(() => null)
    const fourth = tracker.track(async () => { throw new TypeError('reset') }, 'https://status.d.test/api/v2/incidents.json', 8000).catch(() => null)
    t = 700
    release(new Response('{}'))
    await Promise.all([first, second, third, fourth])
    expect(tracker.stats().trace).toEqual([
      { host: 'status.a.test', leg: 'summary', budgetMs: 8000, waiting: 0, outcome: 'a', ms: 700 },
      { host: 'status.b.test', leg: 'html', budgetMs: 5000, waiting: 1, outcome: 'h', ms: 700 },
      { host: 'status.c.test', leg: 'showcase', budgetMs: 3000, waiting: 2, outcome: 't', ms: 700 },
      { host: 'status.d.test', leg: 'incidents', budgetMs: 8000, waiting: 3, outcome: 'e', ms: 700 },
    ])
  })

  it('leaves a fetch still in flight without an outcome', () => {
    const tracker = createFetchTracker(() => 0)
    void tracker.track(() => new Promise<Response>(() => {}), 'https://status.a.test/', 5000)
    expect(tracker.stats().trace).toEqual([{ host: 'status.a.test', leg: 'html', budgetMs: 5000, waiting: 0 }])
  })

  it('hands out a copy of the trace: a fetch settling later does not change an earlier reading', async () => {
    const tracker = createFetchTracker(() => 0)
    let release!: (r: Response) => void
    const pending = tracker.track(() => new Promise<Response>((r) => { release = r }), 'https://status.a.test/', 5000)
    const before = tracker.stats().trace!
    release(new Response('{}'))
    await pending
    expect(before).toEqual([{ host: 'status.a.test', leg: 'html', budgetMs: 5000, waiting: 0 }])
    expect(tracker.stats().trace![0].outcome).toBe('a')
  })

  it('stops recording at FETCH_TRACE_MAX but keeps counting', async () => {
    const tracker = createFetchTracker(() => 0)
    for (let i = 0; i < FETCH_TRACE_MAX + 5; i++) await tracker.track(async () => new Response('{}'), 'https://status.a.test/', 5000)
    const stats = tracker.stats()
    expect(stats.trace).toHaveLength(FETCH_TRACE_MAX)
    expect(stats.answered).toBe(FETCH_TRACE_MAX + 5)
  })

  it('reads the host off a URL and gives an empty host for none or a bad one', () => {
    expect(fetchHostOf('https://status.claude.com/api/v2/summary.json')).toBe('status.claude.com')
    expect(fetchHostOf(undefined)).toBe('')
    expect(fetchHostOf('not a url')).toBe('')
  })
})

describe('#1489 launchOrderOf', () => {
  const ITEMS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const seeded = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  it('keeps the listed order for fixed, as a copy', () => {
    const out = launchOrderOf(ITEMS, 'fixed')
    expect(out).toEqual(ITEMS)
    expect(out).not.toBe(ITEMS)
  })

  it('shuffled is a permutation that leaves the input alone', () => {
    const input = [...ITEMS]
    const out = launchOrderOf(input, 'shuffled', seeded(7))
    expect([...out].sort()).toEqual(ITEMS)
    expect(input).toEqual(ITEMS)
  })

  it('shuffled follows the random source: different draws give different orders, the same draws the same', () => {
    const a = launchOrderOf(ITEMS, 'shuffled', seeded(1))
    expect(launchOrderOf(ITEMS, 'shuffled', seeded(1))).toEqual(a)
    const orders = new Set(Array.from({ length: 20 }, (_, i) => launchOrderOf(ITEMS, 'shuffled', seeded(i)).join('')))
    expect(orders.size).toBeGreaterThan(10)
  })

  it('every item can land in every position (no position is pinned)', () => {
    const seen = ITEMS.map(() => new Set<string>())
    for (let i = 0; i < 400; i++) launchOrderOf(ITEMS, 'shuffled', seeded(i)).forEach((x, pos) => seen[pos].add(x))
    for (const s of seen) expect(s.size).toBe(ITEMS.length)
  })
})

describe('#1489 fetchAllServices launch order', () => {
  afterEach(() => vi.unstubAllGlobals())

  async function summaryOrder(random: () => number) {
    const hosts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v2/summary.json')) hosts.push(new URL(url).hostname)
      return new Response('{}', { status: 404 })
    }))
    const { fetchStats } = await fetchAllServices(undefined, undefined, random)
    return { hosts: [...new Set(hosts)], fetchStats }
  }

  it('a draw under one half shuffles the prefetch and says so; the listed order is the other arm', async () => {
    // First draw is the coin; any later draw of 0 would rotate the list if the fixed arm were shuffled.
    let draws = 0
    const fixed = await summaryOrder(() => (draws++ === 0 ? 0.99 : 0))
    const listed = [...new Set(SERVICES.filter((s) => s.apiUrl).map((s) => new URL(s.apiUrl!).hostname))]
    expect(fixed.hosts).toEqual(listed)
    const shuffled = await summaryOrder(() => 0)
    expect(fixed.fetchStats.launchOrder).toBe('fixed')
    expect(shuffled.fetchStats.launchOrder).toBe('shuffled')
    expect(fixed.hosts.length).toBeGreaterThan(5)
    expect([...shuffled.hosts].sort()).toEqual([...fixed.hosts].sort())
    expect(shuffled.hosts).not.toEqual(fixed.hosts)
  }, 60_000)

  it('a finished run\'s trace gives every fetch an outcome', async () => {
    const { fetchStats } = await summaryOrder(() => 0.99)
    expect(fetchStats.trace!.length).toBeGreaterThan(0)
    expect(fetchStats.trace!.every((e) => e.outcome != null)).toBe(true)
  }, 60_000)
})
