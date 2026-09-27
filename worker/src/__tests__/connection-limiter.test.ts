import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>()
  return { ...actual, createConnectionLimiter: vi.fn(actual.createConnectionLimiter) }
})

import { createConnectionLimiter, fetchWithTimeout, WORKER_CONNECTION_SLOTS, STATUS_RUN_DEADLINE_MS, type ConnectionLimiter } from '../utils'
import { fetchAllServices, fetchService, canIdBypass, SERVICES } from '../services'
import { fetchUptimeShowcase } from '../uptime-showcase'
import { enrichIncidentIoText } from '../parsers/incident-io'
import type { Incident } from '../types'

/**
 * #1489 — a stand-in for the Workers runtime: at most `slots` requests wait for headers at once, the
 * rest queue, and an aborted signal rejects a request whether it is queued or in flight.
 */
function runtimeFetch(respondAfterMs: number, slots = WORKER_CONNECTION_SLOTS) {
  let waitingForHeaders = 0
  let maxWaitingForHeaders = 0
  let maxQueued = 0
  const sentUrls: string[] = []
  const queue: Array<() => void> = []
  const release = () => {
    waitingForHeaders--
    queue.shift()?.()
  }
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal
    let sent = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      if (timer) clearTimeout(timer)
      if (sent) release()
      else queue.splice(queue.indexOf(send), 1)
      reject(new DOMException('The operation was aborted', 'AbortError'))
    }
    const send = () => {
      sent = true
      sentUrls.push(String(input))
      waitingForHeaders++
      maxWaitingForHeaders = Math.max(maxWaitingForHeaders, waitingForHeaders)
      if (respondAfterMs === Infinity) return
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        release()
        resolve(String(input).endsWith('.json')
          ? Response.json({ page: {}, status: { indicator: 'none' }, components: [], incidents: [] })
          : new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }))
      }, respondAfterMs)
    }
    if (signal?.aborted) return reject(new DOMException('The operation was aborted', 'AbortError'))
    signal?.addEventListener('abort', onAbort)
    if (waitingForHeaders < slots) send()
    else {
      queue.push(send)
      maxQueued = Math.max(maxQueued, queue.length)
    }
  })
  return { fetchImpl, maxWaitingForHeaders: () => maxWaitingForHeaders, maxQueued: () => maxQueued, sent: () => sentUrls }
}

async function settle(tasks: Array<Promise<Response>>) {
  const results = await Promise.allSettled(tasks)
  return results.filter((r) => r.status === 'rejected').length
}

describe('#1489 fetch timeouts and the per-invocation connection queue', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('without a limiter, time spent queued behind other connections aborts a fetch the upstream would answer in time', async () => {
    vi.useFakeTimers()
    const runtime = runtimeFetch(40)
    vi.stubGlobal('fetch', runtime.fetchImpl)
    const tasks = Array.from({ length: 18 }, (_, i) => fetchWithTimeout(`https://example.test/${i}`, 100))
    const aborted = settle(tasks)
    await vi.advanceTimersByTimeAsync(500)
    expect(await aborted).toBeGreaterThan(0)
  })

  it('with a limiter, each timeout starts once a slot is held, so none of them abort', async () => {
    vi.useFakeTimers()
    const runtime = runtimeFetch(40)
    vi.stubGlobal('fetch', runtime.fetchImpl)
    const limiter = createConnectionLimiter()
    const tasks = Array.from({ length: 18 }, (_, i) => fetchWithTimeout(`https://example.test/${i}`, 100, undefined, limiter))
    const aborted = settle(tasks)
    await vi.advanceTimersByTimeAsync(500)
    expect(await aborted).toBe(0)
    expect(runtime.maxQueued()).toBe(0)
    expect(runtime.maxWaitingForHeaders()).toBe(WORKER_CONNECTION_SLOTS)
  })

  it('a queued fetch waits past its own timeout for a slot and then runs, because its timeout starts once it holds one', async () => {
    vi.useFakeTimers()
    const runtime = runtimeFetch(1000)
    vi.stubGlobal('fetch', runtime.fetchImpl)
    const limiter = createConnectionLimiter(1)
    const first = fetchWithTimeout('https://example.test/first', 5000, undefined, limiter)
    const second = fetchWithTimeout('https://example.test/second', 5000, undefined, limiter)
    const queued = fetchWithTimeout('https://example.test/queued', 1500, undefined, limiter)
    const outcome = Promise.allSettled([first, second, queued])
    await vi.advanceTimersByTimeAsync(5000)
    expect((await outcome).map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled'])
    expect(runtime.sent()).toEqual(['https://example.test/first', 'https://example.test/second', 'https://example.test/queued'])
  })

  it('fetches still waiting at the run deadline are refused together and never sent, while the ones already sent finish', async () => {
    vi.useFakeTimers()
    const runtime = runtimeFetch(1000)
    vi.stubGlobal('fetch', runtime.fetchImpl)
    const limiter = createConnectionLimiter(1, 1500)
    const tasks = ['a', 'b', 'c', 'd'].map((n) => fetchWithTimeout(`https://example.test/${n}`, 5000, undefined, limiter))
    const outcome = Promise.allSettled(tasks)
    await vi.advanceTimersByTimeAsync(5000)
    const settled = await outcome
    expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected', 'rejected'])
    expect(settled.slice(2).map((r) => r.status === 'rejected' && r.reason.name)).toEqual(['AbortError', 'AbortError'])
    expect(runtime.sent()).toEqual(['https://example.test/a', 'https://example.test/b'])
  })

  it('the default run deadline is 90 s from creation: a fetch at 89 s runs, one at 91 s is refused', async () => {
    vi.useFakeTimers()
    const runtime = runtimeFetch(10)
    vi.stubGlobal('fetch', runtime.fetchImpl)
    expect(STATUS_RUN_DEADLINE_MS).toBe(90_000)
    const limiter = createConnectionLimiter()
    await vi.advanceTimersByTimeAsync(89_000)
    const before = fetchWithTimeout('https://example.test/before', 5000, undefined, limiter)
    await vi.advanceTimersByTimeAsync(20)
    await expect(before).resolves.toBeInstanceOf(Response)
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(fetchWithTimeout('https://example.test/after', 5000, undefined, limiter)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('after the run deadline a fetch is refused without being sent, even when a slot is free', async () => {
    vi.useFakeTimers()
    const runtime = runtimeFetch(10)
    vi.stubGlobal('fetch', runtime.fetchImpl)
    const limiter = createConnectionLimiter(6, 1000)
    await vi.advanceTimersByTimeAsync(1500)
    await expect(fetchWithTimeout('https://example.test/late', 5000, undefined, limiter)).rejects.toMatchObject({ name: 'AbortError' })
    expect(runtime.sent()).toEqual([])
  })

  it('a slot is released when a fetch fails, so later fetches still run', async () => {
    const limiter = createConnectionLimiter(1)
    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValue(new Response('ok')))
    await expect(fetchWithTimeout('https://example.test/a', 100, undefined, limiter)).rejects.toThrow('connection reset')
    await expect(fetchWithTimeout('https://example.test/b', 100, undefined, limiter)).resolves.toBeInstanceOf(Response)
  })

  it('two limiters do not share slots, so concurrent invocations do not throttle each other', async () => {
    const first = createConnectionLimiter(1)
    const second = createConnectionLimiter(1)
    let unblock!: () => void
    const held = first.run(() => new Promise<void>((resolve) => { unblock = resolve }))
    await expect(second.run(async () => 'ran')).resolves.toBe('ran')
    unblock()
    await held
  })

  it('fetchAllServices ends within 105 s even when every upstream stalls', async () => {
    vi.useFakeTimers({ now: 0 })
    vi.stubGlobal('fetch', runtimeFetch(Infinity).fetchImpl)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    let endedAt = -1
    const run = fetchAllServices(undefined).then((r) => { endedAt = Date.now(); return r })
    await vi.advanceTimersByTimeAsync(400_000)
    await run
    expect(endedAt).toBeGreaterThan(0)
    expect(endedAt).toBeLessThanOrEqual(105_000)
  }, 60_000)

  it('fetchAllServices creates its limiter with the default run deadline', async () => {
    vi.mocked(createConnectionLimiter).mockClear()
    vi.stubGlobal('fetch', runtimeFetch(1).fetchImpl)
    await fetchAllServices(undefined)
    expect(vi.mocked(createConnectionLimiter).mock.calls).toEqual([[]])
  }, 60_000)

  it('fetchAllServices never leaves a request in the runtime queue', async () => {
    const runtime = runtimeFetch(1)
    vi.stubGlobal('fetch', runtime.fetchImpl)
    await fetchAllServices(undefined)
    expect(runtime.maxWaitingForHeaders()).toBe(WORKER_CONNECTION_SLOTS)
    expect(runtime.maxQueued()).toBe(0)
  }, 60_000)
})

/** Records every fetch and whether it started inside a limiter slot. */
function slotTracker() {
  let depth = 0
  const seen: string[] = []
  const outside: string[] = []
  const limiter: ConnectionLimiter = {
    async run<T>(task: () => Promise<T>): Promise<T> {
      depth++
      try { return await task() } finally { depth-- }
    },
  }
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    seen.push(url)
    if (depth === 0) outside.push(url)
    return url.endsWith('.json')
      ? Response.json({ page: {}, status: { indicator: 'none' }, components: [], incidents: [] })
      : new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } })
  })
  return { limiter, fetchImpl, seen, outside }
}

describe('#1489 every status-path fetch starts inside a slot (the legs the end-to-end fixture does not reach)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('the uptime showcase read', async () => {
    const t = slotTracker()
    vi.stubGlobal('fetch', t.fetchImpl)
    await fetchUptimeShowcase('https://status.example.test', ['abc'], 3000, t.limiter)
    expect(t.seen).toHaveLength(1)
    expect(t.outside).toEqual([])
  })

  it('the incident text enrichment read', async () => {
    const t = slotTracker()
    vi.stubGlobal('fetch', t.fetchImpl)
    const incident = {
      id: 'inc1', title: 'x', status: 'investigating', startedAt: '2026-01-01T00:00:00Z',
      timeline: [{ stage: 'investigating', at: '2026-01-01T00:00:00Z', text: '' }],
    } as unknown as Incident
    await enrichIncidentIoText([incident], 'https://status.example.test/incidents', new Map(), undefined, t.limiter)
    expect(t.seen).toHaveLength(1)
    expect(t.outside).toEqual([])
  })

  it('the incident.io global-page HTML read', async () => {
    const config = SERVICES.find((s) => s.incidentIoGlobalPage)!
    expect(config, 'a global-page service is configured').toBeDefined()
    const t = slotTracker()
    vi.stubGlobal('fetch', t.fetchImpl)
    await fetchService(config, undefined, undefined, {}, t.limiter)
    expect(t.seen, 'the leg was reached').toContain(config.statusUrl)
    expect(t.outside).toEqual([])
  })

  it('the 3 s status-page HTML re-fetch', async () => {
    const config = SERVICES.find((s) => canIdBypass(s) && !s.incidentIoGlobalPage)!
    expect(config, 'an id-bypass service is configured').toBeDefined()
    const t = slotTracker()
    vi.stubGlobal('fetch', t.fetchImpl)
    await fetchService(config, undefined, undefined, {}, t.limiter)
    expect(t.seen, 'the leg was reached').toContain(config.statusUrl)
    expect(t.outside).toEqual([])
  })
})
