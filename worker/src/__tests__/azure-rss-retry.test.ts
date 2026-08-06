import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchService, SERVICES } from '../services'
import type { KVLike } from '../utils'

// #1211 — the Azure RSS leg intermittently returns no response headers at all, and three such stalls
// cross `trackFetchFailure`'s threshold into a `degraded` that describes our connection rather than
// Azure. azureopenai has one source, no probe target, and qualifies for no cross-validation phase, so
// nothing downstream can contradict it.
//
// These drive the real `fetchService` entry point rather than a hand-assembled imitation, because the
// bug is in the WIRING (which fetch helper this branch calls, and what latency it publishes), not in
// any parser — a parser-level test stays green through the entire failure.

const azure = SERVICES.find((s) => s.id === 'azureopenai')!

function mockKV(store: Record<string, string> = {}, ttls: Record<string, number | undefined> = {}): KVNamespace {
  return {
    get: async (k: string) => store[k] ?? null,
    put: async (k: string, v: string, opts?: { expirationTtl?: number }) => { store[k] = v; ttls[k] = opts?.expirationTtl },
    delete: async (k: string) => { delete store[k] },
  } as unknown as KVLike as unknown as KVNamespace
}

/** `fetch-fail:daily:*` keys are date-suffixed; match on the prefix. */
const keysStartingWith = (store: Record<string, string>, prefix: string) =>
  Object.keys(store).filter((k) => k.startsWith(prefix))

function abortError() {
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
}

/**
 * A faithful stall: the connection is accepted and then nothing arrives, so only the caller's own
 * AbortController ends it. Honouring `init.signal` is what makes this a stall rather than an instant
 * throw — the timing the fix is about is not exercised otherwise.
 */
function hangUntilAborted(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(abortError()))
  })
}

/**
 * The real feed is the WHOLE-Azure firehose, so a faithful fixture carries sibling noise: azureopenai's
 * only scoping is `incidentKeywords: ['Azure OpenAI']`, and a single-item fixture would let a dropped
 * `filterIncidents` call pass unnoticed.
 *
 * The Azure OpenAI title's word "Degraded" is load-bearing: `classifyAwsImpact` keys on it for
 * `impact: 'major'`, which is what makes `deriveAwsStatus` return `degraded` rather than `down`.
 */
function feedWithIncident() {
  const pubDate = new Date(Date.now() - 3_600_000).toUTCString()
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
  <title>Azure Status</title>
  <item>
    <title>Azure OpenAI - Degraded experience for some customers</title>
    <description>Engineers are investigating elevated error rates.</description>
    <pubDate>${pubDate}</pubDate>
    <guid>az-1211-test</guid>
  </item>
  <item>
    <title>Azure Cosmos DB - Degraded experience in West Europe</title>
    <description>A sibling Azure service, not ours.</description>
    <pubDate>${pubDate}</pubDate>
    <guid>az-cosmos-test</guid>
  </item>
</channel></rss>`
}

/** What the feed actually looks like almost all the time: reachable, zero incidents. */
const EMPTY_FEED = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Azure Status</title></channel></rss>`

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('#1211 — a stalled Azure RSS connection must not publish a false status', () => {
  it('recovers the incident when the first attempt stalls and the retry succeeds', async () => {
    // The regression test proper. Pre-fix this branch called `fetchWithTimeout` directly, so the abort
    // collapsed to `null` → `incidents: []` and the ongoing incident vanished from the card.
    const store: Record<string, string> = { 'fetch-fail:azureopenai': '2' }
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      if (calls === 1) throw abortError()
      return new Response(feedWithIncident(), { status: 200 })
    }))

    const svc = await fetchService(azure, undefined, mockKV(store))

    expect(calls, 'the stalled attempt must be retried on a fresh connection').toBe(2)
    expect(svc.incidents.length, 'ours reaches the card; the sibling Azure service is filtered out').toBe(1)
    expect(svc.incidents[0].title).toContain('Azure OpenAI')
    expect(svc.incidents[0].impact, 'the fixture title drives impact, which drives the status below').toBe('major')
    expect(svc.status).toBe('degraded')

    // The failure episode must be un-booked, not merely out-voted — the crossing counter is what
    // turned into the published `degraded`.
    expect(store['fetch-fail:azureopenai'], 'a success clears the streak').toBeUndefined()
    expect(keysStartingWith(store, 'fetch-fail:daily:'), 'no crossing may be booked when the retry rescued it').toEqual([])
  })

  it('still degrades when BOTH attempts stall — the retry must not swallow a dead source', async () => {
    // The other direction. A retry that hid a genuinely unreachable source would trade a false
    // `degraded` for a false `operational`, which is the worse failure for this product.
    const store: Record<string, string> = { 'fetch-fail:azureopenai': '2' }
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => { calls++; throw abortError() }))

    const svc = await fetchService(azure, undefined, mockKV(store))

    expect(calls, 'it must fail AFTER retrying, not instead of retrying').toBe(2)
    expect(svc.incidents, 'no feed was read, so no incidents').toEqual([])
    expect(store['fetch-fail:azureopenai'], 'the failure must still be booked').toBe('3')
    expect(svc.status, 'the third consecutive failure crosses the threshold').toBe('degraded')
    // No response was measured, so no response time may be published — reporting the elapsed abort
    // budget would put our own timeout into /api/v1/status and the latency:24h series as Azure's.
    expect(svc.latency, 'a poll that got nothing publishes no latency').toBeNull()
  })

  it('does not retry a successful first attempt — one subrequest on the happy path', async () => {
    // Guards the cost side: this leg runs on every /api/status request and every cron tick, so a
    // retry that fired unconditionally would double its subrequest and connection footprint.
    const store: Record<string, string> = {}
    const fetchMock = vi.fn(async () => new Response(feedWithIncident(), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const svc = await fetchService(azure, undefined, mockKV(store))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(svc.incidents.length).toBe(1)
  })

  it('an empty feed read on the retry is a clean operational, not a rescue with no effect', async () => {
    // The modal case: the live feed carries no <item> most of the time, so this — not the incident
    // fixture above — is what a real rescue usually produces.
    const store: Record<string, string> = { 'fetch-fail:azureopenai': '2' }
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      if (calls === 1) throw abortError()
      return new Response(EMPTY_FEED, { status: 200 })
    }))

    const svc = await fetchService(azure, undefined, mockKV(store))

    expect(svc.status, 'a reachable feed with no incidents is operational').toBe('operational')
    expect(svc.incidents).toEqual([])
    expect(store['fetch-fail:azureopenai']).toBeUndefined()
  })

  it('an HTTP error response is NOT retried — only a stall is', async () => {
    // Documents the boundary. `fetchWithRetry` retries a THROW, not a `!res.ok`, so a 5xx still books
    // a failure on the first response. Pinned so a later change does not silently assume otherwise.
    const store: Record<string, string> = { 'fetch-fail:azureopenai': '2' }
    const fetchMock = vi.fn(async () => new Response('upstream error', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)

    const svc = await fetchService(azure, undefined, mockKV(store))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(store['fetch-fail:azureopenai']).toBe('3')
    expect(svc.status).toBe('degraded')
    expect(svc.latency, 'an HTTP error still measured a real round trip — that one is kept').toBeTypeOf('number')
  })

  it('clears the #500 persistent-block marker too, once a retry recovers the source', async () => {
    // The episode that matters: the streak already crossed, so `fetch-fail:since` is armed and the 1h
    // structural-block alert is counting. A rescue that cleared only the streak would leave that clock
    // running and eventually page the operator about a source that recovered.
    const store: Record<string, string> = {
      'fetch-fail:azureopenai': '3',
      'fetch-fail:since:azureopenai': new Date(Date.now() - 600_000).toISOString(),
    }
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      if (calls === 1) throw abortError()
      return new Response(EMPTY_FEED, { status: 200 })
    }))

    await fetchService(azure, undefined, mockKV(store))

    expect(store['fetch-fail:azureopenai']).toBeUndefined()
    expect(store['fetch-fail:since:azureopenai'], 'the persistent-block clock must be disarmed too').toBeUndefined()
  })
})

describe('#1211 — the timing the fix is actually about', () => {
  // Fake timers so these assert the real budget without paying it. Everything here is driven by the
  // AbortController inside `fetchWithTimeout` and the 1s backoff inside `fetchWithRetry`.

  it('abandons the first attempt at 4s — not the 8s default — and publishes the RETRY\'s latency', async () => {
    // Two claims in one run, because they share a timeline.
    //
    // (a) The budget. 4s + 1s + 3s keeps the worst case at the 8s this leg already cost, while a stall
    //     is detected in half the time. Reverting to the 8s default silently doubles the worst case,
    //     and nothing else in the suite would notice.
    // (b) The latency. `start` is reset before the retry, so the served response's own RTT is what
    //     gets published. Measuring across the whole helper would charge the abandoned attempt and the
    //     backoff to the response that arrived, into `/api/v1/status` and the `latency:24h` series,
    //     where it reads as a measurement of Azure.
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      calls++
      if (calls === 1) return hangUntilAborted(init)
      return Promise.resolve(new Response(EMPTY_FEED, { status: 200 }))
    }))

    const pending = fetchService(azure, undefined, mockKV({}))

    await vi.advanceTimersByTimeAsync(3_900)
    expect(calls, 'the first attempt is still in flight just under the budget').toBe(1)

    await vi.advanceTimersByTimeAsync(200)   // crosses 4s → abort fires
    await vi.advanceTimersByTimeAsync(1_000) // the backoff before the retry
    const svc = await pending

    expect(calls, 'the retry fires once the abandoned attempt is cut loose').toBe(2)
    expect(svc.status).toBe('operational')
    expect(svc.latency, 'an api-category service must still publish a number').toBeTypeOf('number')
    expect(svc.latency, 'the abandoned 4s attempt and the 1s backoff must not be charged to the response')
      .toBeLessThan(1_000)
  })

  it('caps the retry at 3s, so the whole leg still resolves within its old 8s budget', async () => {
    // The other half of the budget claim. The retry inherits `Math.min(timeoutMs, 3000)`; widening it
    // to the caller's 4s would push the worst case past the 8s this change promised not to exceed.
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => { calls++; return hangUntilAborted(init) }))

    const store: Record<string, string> = { 'fetch-fail:azureopenai': '2' }
    const pending = fetchService(azure, undefined, mockKV(store))

    await vi.advanceTimersByTimeAsync(4_000)  // first attempt abandoned
    await vi.advanceTimersByTimeAsync(1_000)  // backoff
    expect(calls, 'the retry is in flight').toBe(2)

    await vi.advanceTimersByTimeAsync(2_900)
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled, 'still waiting on the retry just under its 3s cap').toBe(false)

    await vi.advanceTimersByTimeAsync(200)    // 4s + 1s + 3s = 8s, the pre-change budget
    const svc = await pending
    expect(svc.status, 'both attempts stalled on an already-crossing streak').toBe('degraded')
  })
})
