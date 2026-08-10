import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  applyParseFailure, parseParseFailDay, recordParseFailure, parseFailKey, totalFor, slotOf,
  PARSE_FAIL_TTL_S, type ParseFailDay,
} from '../parse-failure-log'
import { fetchService, SERVICES } from '../services'
import type { KVLike } from '../utils'

/** Counts puts as well as storing, because "how many writes" is itself under test here. */
function mockKV(store: Record<string, string> = {}, meta: { puts: number; ttls: Record<string, number | undefined> } = { puts: 0, ttls: {} }): KVLike {
  return {
    get: async (k: string) => store[k] ?? null,
    put: async (k: string, v: string, opts?: { expirationTtl?: number }) => {
      store[k] = v; meta.puts++; meta.ttls[k] = opts?.expirationTtl
    },
    delete: async (k: string) => { delete store[k] },
  } as unknown as KVLike
}

const EMPTY: ParseFailDay = { counts: {}, slots: {} }
const T = (iso: string) => Date.parse(iso)

describe('#1089 follow-up — durable per-service parse-failure counter', () => {
  it('attributes a failure by service AND by reason', () => {
    // Reason is kept because it selects the fix: `scrape-unreadable` means URL drift (a config
    // change), the payload reasons mean Instatus moved its SSR shape (a parser change).
    const got = applyParseFailure(EMPTY, 'mistral', 'scrape-unreadable', 1)
    expect(got.counts).toEqual({ mistral: { 'scrape-unreadable': 1 } })
  })

  it('accumulates across services and reasons without collapsing them', () => {
    let d = EMPTY
    d = applyParseFailure(d, 'mistral', 'scrape-unreadable', 1)
    d = applyParseFailure(d, 'mistral', 'scrape-unreadable', 2)
    d = applyParseFailure(d, 'mistral', 'no-nuxt-payload', 3)
    d = applyParseFailure(d, 'perplexity', 'next-shape-changed', 1)
    expect(d.counts).toEqual({
      mistral: { 'scrape-unreadable': 2, 'no-nuxt-payload': 1 },
      perplexity: { 'next-shape-changed': 1 },
    })
    expect(totalFor(d, 'mistral')).toBe(3)
    expect(totalFor(d, 'fal'), 'a service with no failures totals 0').toBe(0)
  })

  it('does not mutate the input', () => {
    const before: ParseFailDay = { counts: { mistral: { 'bad-json': 1 } }, slots: { mistral: 1 } }
    applyParseFailure(before, 'mistral', 'bad-json', 2)
    expect(before.counts).toEqual({ mistral: { 'bad-json': 1 } })
  })

  it('skips an empty service id or reason rather than booking a "" bucket', () => {
    expect(applyParseFailure(EMPTY, '', 'bad-json', 1).counts).toEqual({})
    expect(applyParseFailure(EMPTY, 'mistral', '', 1).counts).toEqual({})
  })

  // ── the dedup: this is what makes the number mean CYCLES, not requests ──

  it('books at most once per service per cron slot', () => {
    let d = applyParseFailure(EMPTY, 'mistral', 'bad-json', 100)
    d = applyParseFailure(d, 'mistral', 'bad-json', 100)
    d = applyParseFailure(d, 'mistral', 'no-nuxt-payload', 100) // different reason, same slot
    expect(totalFor(d, 'mistral'), 'a slot contributes exactly 1 regardless of invocations').toBe(1)
  })

  it('a repeat within the same slot returns the SAME object, so the caller can skip the write', () => {
    const first = applyParseFailure(EMPTY, 'mistral', 'bad-json', 100)
    expect(applyParseFailure(first, 'mistral', 'bad-json', 100)).toBe(first)
  })

  it('dedup is per service — one service does not mask another in the same slot', () => {
    let d = applyParseFailure(EMPTY, 'mistral', 'bad-json', 100)
    d = applyParseFailure(d, 'perplexity', 'bad-json', 100)
    expect(totalFor(d, 'mistral')).toBe(1)
    expect(totalFor(d, 'perplexity')).toBe(1)
  })

  it('slotOf buckets by the 5-minute cron interval', () => {
    expect(slotOf(T('2026-07-21T00:00:00Z'))).toBe(slotOf(T('2026-07-21T00:04:59Z')))
    expect(slotOf(T('2026-07-21T00:05:00Z'))).not.toBe(slotOf(T('2026-07-21T00:04:59Z')))
  })

  // ── retention: the whole reason this counter exists separately ──

  it('writes with 30d retention, not the 48h that made this necessary', async () => {
    const store: Record<string, string> = {}, meta = { puts: 0, ttls: {} as Record<string, number | undefined> }
    await recordParseFailure(mockKV(store, meta), T('2026-07-21T09:00:00Z'), 'mistral', 'bad-json')
    expect(meta.ttls['instatus-parse-fail:2026-07-21']).toBe(PARSE_FAIL_TTL_S)
    expect(PARSE_FAIL_TTL_S).toBe(30 * 86400)
  })

  it('keys by UTC day and round-trips through KV', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    await recordParseFailure(kv, T('2026-07-21T09:00:00Z'), 'mistral', 'scrape-unreadable')
    await recordParseFailure(kv, T('2026-07-21T09:06:00Z'), 'mistral', 'scrape-unreadable')
    await recordParseFailure(kv, T('2026-07-22T00:01:00Z'), 'mistral', 'scrape-unreadable')
    expect(totalFor(parseParseFailDay(store[parseFailKey('2026-07-21')]), 'mistral')).toBe(2)
    expect(totalFor(parseParseFailDay(store[parseFailKey('2026-07-22')]), 'mistral')).toBe(1)
  })

  it('reader tolerates every corrupt shape rather than throwing', () => {
    for (const junk of ['', 'not json', '[]', 'null', '3', '{}', '{"counts":"x"}', '{"counts":[1]}', '{"counts":{"mistral":"x"}}', '{"counts":{"":{"a":1}}}', '{"counts":{"mistral":{"a":"x"}}}', '{"counts":{"mistral":{"a":-2}}}']) {
      expect(parseParseFailDay(junk).counts, junk).toEqual({})
    }
    expect(parseParseFailDay(null).counts).toEqual({})
  })

  it('reader keeps good entries when only part of the value is corrupt', () => {
    const got = parseParseFailDay('{"counts":{"mistral":{"bad-json":2,"x":"nope"},"fal":"junk"},"slots":{"mistral":7,"fal":"bad"}}')
    expect(got.counts).toEqual({ mistral: { 'bad-json': 2 } })
    expect(got.slots).toEqual({ mistral: 7 })
  })

  it('a corrupt slots block cannot resurrect a lost dedup as a permanent skip', () => {
    // If `slots` were trusted blindly, a garbage value could equal the current slot and silence the
    // counter forever. Non-numeric entries are dropped, so the worst case is one extra booking.
    const day = parseParseFailDay('{"counts":{},"slots":{"mistral":"NaN"}}')
    expect(applyParseFailure(day, 'mistral', 'bad-json', 1).counts.mistral).toEqual({ 'bad-json': 1 })
  })

  it('a write failure never propagates — bookkeeping must not fail a status fetch', async () => {
    const kv = { get: async () => null, put: async () => { throw new Error('KV down') }, delete: async () => {} } as unknown as KVLike
    await expect(recordParseFailure(kv, Date.now(), 'mistral', 'bad-json')).resolves.toBeUndefined()
  })
})

// ── wiring + write budget: a pure-fn test sees neither ──

describe('#1089 follow-up — the guard books into the counter, once per cycle', () => {
  const mistral = SERVICES.find((s) => s.id === 'mistral')!
  afterEach(() => vi.unstubAllGlobals())

  const failStub = () => vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body>redesigned</body></html>', { status: 200 })))

  it('records the failure with its reason on a real fetchService parse failure', async () => {
    // Drives the production entry point, so parse → flag → guard → counter runs end to end.
    failStub()
    const store: Record<string, string> = {}
    const svc = await fetchService(mistral, undefined, mockKV(store) as never, {})
    expect(svc.sourceUnknown, 'precondition: the guard must have fired').toBe(true)

    const key = Object.keys(store).find((k) => k.startsWith('instatus-parse-fail:'))
    expect(key, `expected a counter key, got: ${Object.keys(store).join(', ')}`).toBeDefined()
    const day = parseParseFailDay(store[key!])
    expect(totalFor(day, 'mistral')).toBe(1)
    expect(Object.keys(day.counts.mistral), 'must carry a reason, not a bare count').toHaveLength(1)
  })

  // THE regression this file exists for. `fetchService` runs on every `/api/status` request, not only
  // the 5-min cron, so a per-invocation write would bill KV per dashboard request for as long as the
  // source stayed broken — traffic-proportional writes, which the standing decision rules out — and
  // would make the tally a traffic measurement rather than the cycle count the open decision needs.
  it('does NOT write once per invocation — repeated calls in one slot write once', async () => {
    failStub()
    const store: Record<string, string> = {}, meta = { puts: 0, ttls: {} as Record<string, number | undefined> }
    const kv = mockKV(store, meta)
    for (let i = 0; i < 10; i++) await fetchService(mistral, undefined, kv as never, {})

    const key = Object.keys(store).find((k) => k.startsWith('instatus-parse-fail:'))!
    expect(totalFor(parseParseFailDay(store[key]), 'mistral'), '10 invocations in one slot = 1 cycle').toBe(1)
    // `puts` includes trackFetchFailure's own bounded writes; what matters is that it does not grow
    // linearly with invocations the way an unbounded counter would. Removing the dedup makes this
    // assertion fail — that is the guarantee, rather than any figure from a tree that no longer exists.
    expect(meta.puts, `writes must not track invocations: ${meta.puts} for 10 calls`).toBeLessThan(10)
  })

  it('records nothing on a healthy fetch', async () => {
    // The false-positive direction: if this ever books on success, every quiet day reads as failing
    // and the counter stops being able to answer the question it exists for.
    const arr: unknown[] = [
      'Audio API Degraded', 'INVESTIGATING', '2026-07-17T07:55:56.406Z', 0, 'MEDIUM', 'inc-1', [], [],
      { id: 5, name: 0, lastUpdateStatus: 1, created_at: 2, duration: 3, severity: 4, services: 6, incidentUpdates: 7 },
      [8], { incidents: 9 }, { 'incidents-by-date-2026': 10 },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`, { status: 200 })))
    const store: Record<string, string> = {}
    const svc = await fetchService(mistral, undefined, mockKV(store) as never, {})
    expect(svc.sourceUnknown).toBeUndefined()
    expect(Object.keys(store).filter((k) => k.startsWith('instatus-parse-fail:'))).toEqual([])
  })
})
