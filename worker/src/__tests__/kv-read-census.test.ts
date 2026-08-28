// #1224 Phase 2 — tests for the cron's per-run KV read census. The failure this file guards is
// silent by construction: a census that misses reads reports smaller numbers, which read as "that
// path is cheap" (`feedback_derived_signal_needs_scoped_diagnostic`).
//
// The wiring is asserted BEHAVIOURALLY — `scheduled()` is invoked and the emitted line is parsed —
// rather than by matching the source text of index.ts. Round 1 of review demonstrated why: three
// source-text assertions were satisfied by an unwired variant (a `% 30` sampling gate on the log
// line, a guard-clause `return` at six-space indent), while also failing on a rename that changes
// nothing (`feedback_pin_the_decision_not_the_spelling`).

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  rollupByDepth, createReadCensus, formatCensus, reconcileBuckets, MAX_TRACKED_KEYS,
  OVERFLOW_BUCKET, NON_STRING_BUCKET, UNATTRIBUTED_BUCKET,
} from '../kv-read-census'
import workerModule from '../index'

/** A KV stand-in that records its own calls, so the census can be checked against ground truth. */
function fakeKv() {
  const calls = { get: [] as unknown[], getWithMetadata: [] as unknown[], put: 0, delete: 0, list: 0 }
  const kv = {
    get: (key: unknown, _opts?: unknown) => { calls.get.push(key); return Promise.resolve(null) },
    getWithMetadata: (key: unknown, _opts?: unknown) => { calls.getWithMetadata.push(key); return Promise.resolve({ value: null, metadata: null }) },
    put: () => { calls.put++; return Promise.resolve() },
    delete: () => { calls.delete++; return Promise.resolve() },
    list: () => { calls.list++; return Promise.resolve({ keys: [], list_complete: true, cacheStatus: null }) },
  } as unknown as KVNamespace
  return { kv, calls }
}

const m = (pairs: Array<[string, number]>) => new Map(pairs)
const ids = (prefix: string, n: number, count = 1): Array<[string, number]> =>
  Array.from({ length: n }, (_, i) => [`${prefix}${i}`, count] as [string, number])

const VERBS = ['new', 'res', 'wd', 'down', 'recovered', 'degraded', 'fetch-persistent', 'flap',
  'component-missing', 'component-partial', 'source-dead', 'service-drop', 'edge-fallback',
  'platform', 'worker-error', 'probe-spike']

/** `outer` ids each with `inner` ids beneath, e.g. recovered:{svcId}:{incId}. */
const fanout = (prefix: string, outer: number, inner: number): Array<[string, number]> =>
  Array.from({ length: outer }, (_, i) => Array.from({ length: inner }, (_, j) => [`${prefix}:o${i}:i${j}`, 1] as [string, number])).flat()

describe('rollupByDepth — positional, so two runs are comparable', () => {
  it('folds a family onto its first segment at depth 1, and splits the vocabulary at depth 2', () => {
    const counts = m([...ids('alerted:new:inc', 14), ...ids('alerted:down:svc', 45)])
    expect(rollupByDepth(counts, 1)).toEqual([['alerted:*', 59]])
    expect(rollupByDepth(counts, 2)).toEqual([['alerted:down:*', 45], ['alerted:new:*', 14]])
  })

  it('reports a key whole once it has no more segments than the depth', () => {
    const counts = m([['probe:24h', 2], ['services:latest', 1], ['suppressions', 3]])
    expect(rollupByDepth(counts, 2)).toEqual([['suppressions', 3], ['probe:24h', 2], ['services:latest', 1]])
    expect(rollupByDepth(counts, 1)).toEqual([['suppressions', 3], ['probe:*', 2], ['services:*', 1]])
  })

  it('gives the SAME depth-1 bucket names whatever the fan-out width — the property the last two rules lacked', () => {
    // The variance rule this replaced put `recovered:{svcId}:{incId}` in one `recovered:*` bucket at
    // one incident per service and in 225 separate exact-key buckets at five, so two runs could not
    // be subtracted. Reproduced during review by execution; this is the regression guard.
    const narrow = rollupByDepth(m(fanout('recovered', 45, 1)), 1)
    const wide = rollupByDepth(m(fanout('recovered', 45, 5)), 1)
    expect(narrow.map(([b]) => b)).toEqual(wide.map(([b]) => b))
    expect(narrow).toEqual([['recovered:*', 45]])
    expect(wide).toEqual([['recovered:*', 225]])
  })

  it('keeps a two-level id fan-out in ONE family bucket instead of the `other=` tail', () => {
    // `ai:analysis:{svcId}:{incId}` — the family Phase 1's own line counts as 1,125 pairs. The
    // variance rule split it per service, putting 73% of the run's dominant family inside `other=`.
    const counts = m(fanout('ai:analysis', 45, 25))
    expect(rollupByDepth(counts, 1)).toEqual([['ai:*', 1125]])
    expect(rollupByDepth(counts, 2)).toEqual([['ai:analysis:*', 1125]])
  })

  it('does not collapse the whole `alerted:` vocabulary, at ANY fan-out width', () => {
    // The variance rule produced a single `alerted:*` bucket whenever a run touched >8 verbs with
    // <=2 keys under each — destroying the `alerted:down:` vs `alerted:new:` distinction Phase 1
    // acted on. Asserted across the widths that broke it, not just the one that worked.
    for (const width of [1, 2, 3, 45]) {
      const counts = m(VERBS.flatMap(v => ids(`alerted:${v}:svc`, width)))
      const detail = rollupByDepth(counts, 2)
      expect(detail, `width ${width}`).toHaveLength(VERBS.length)
      expect(detail.map(([b]) => b), `width ${width}`).toContain('alerted:new:*')
      expect(detail.map(([b]) => b), `width ${width}`).toContain('alerted:down:*')
      expect(rollupByDepth(counts, 1), `width ${width}`).toEqual([['alerted:*', VERBS.length * width]])
    }
  })

  it('conserves the total at every depth', () => {
    const counts = m([
      ...ids('alerted:new:inc', 40, 1), ...fanout('recovered', 45, 3),
      ['probe:24h', 3], ['services:latest', 1], ...fanout('ai:analysis', 9, 4),
      ['suppressions', 5], ...ids('suppressions:x', 12),
    ])
    const inputTotal = [...counts.values()].reduce((a, b) => a + b, 0)
    for (const depth of [1, 2, 3]) {
      expect(rollupByDepth(counts, depth).reduce((a, [, n]) => a + n, 0), `depth ${depth}`).toBe(inputTotal)
    }
  })

  it('produces no duplicate bucket names', () => {
    const counts = m([...ids('a:b:c', 20), ...ids('a:b:d', 20), ['a:b', 1], ['a', 1]])
    for (const depth of [1, 2]) {
      const names = rollupByDepth(counts, depth).map(([b]) => b)
      expect(new Set(names).size, `depth ${depth}`).toBe(names.length)
    }
  })

  it('is empty for an empty run', () => {
    expect(rollupByDepth(m([]), 1)).toEqual([])
  })
})

describe('createReadCensus — counting', () => {
  it('counts every get — total equals the namespace\'s own call count', async () => {
    const { kv, calls } = fakeKv()
    const census = createReadCensus()
    const wrapped = census.wrapKv(kv)
    for (const id of ['a', 'b', 'c', 'd']) await wrapped.get(`alerted:new:${id}`)
    await wrapped.get('probe:24h')
    // Ground truth, not a hand-written 5: an off-by-one cannot hide behind a matching expectation
    // written by the same author in the same sitting. The literal guards `calls.get` being 0.
    expect(census.snapshot().total).toBe(calls.get.length)
    expect(calls.get).toHaveLength(5)
  })

  it('counts getWithMetadata — it is billed as a read too', async () => {
    const { kv, calls } = fakeKv()
    const census = createReadCensus()
    const wrapped = census.wrapKv(kv)
    await wrapped.get('tracking:state')
    await wrapped.getWithMetadata('services:latest')
    expect(census.snapshot().total).toBe(calls.get.length + calls.getWithMetadata.length)
    expect(calls.getWithMetadata).toHaveLength(1)
  })

  it('counts a bulk get per key, and hands the array through as ONE call', async () => {
    const { kv, calls } = fakeKv()
    const census = createReadCensus()
    const keys = ['alerted:new:a', 'alerted:new:b', 'alerted:new:c']
    await (census.wrapKv(kv).get as unknown as (k: string[]) => Promise<unknown>)(keys)
    expect(calls.get).toEqual([keys])                       // one call, array intact
    expect(census.snapshot().total).toBe(keys.length)       // counted per key, as KV bills it
  })

  it('counts NOTHING for put / delete / list — they are not read operations', async () => {
    const { kv, calls } = fakeKv()
    const census = createReadCensus()
    const wrapped = census.wrapKv(kv)
    await wrapped.put('tracking:state', '{}')
    await wrapped.delete('tracking:state')
    await wrapped.list({ prefix: 'security:seen:' })
    expect(calls.put + calls.delete + calls.list).toBe(3) // the calls really happened...
    expect(census.snapshot().total).toBe(0)               // ...and none of them was counted
  })

  it('counts a read at the CALL, not at the settle — the invariant waitUntil safety rests on', async () => {
    // `ctx.waitUntil(maybeDispatchDeepseekFeed(env))` issues `deepseek:dispatch:cooldown` and can
    // outlive the handler. It is counted because `record()` runs before the underlying call. A
    // "count only successful/settled reads" change would silently make that read escape.
    let release!: (v: unknown) => void
    const pending = new Promise((r) => { release = r })
    const kv = { get: (_k: unknown) => pending } as unknown as KVNamespace
    const census = createReadCensus()
    const read = census.wrapKv(kv).get('deepseek:dispatch:cooldown')
    expect(census.snapshot().total).toBe(1)  // counted while still in flight
    release(null)
    await read
    expect(census.snapshot().total).toBe(1)  // and not double-counted on settle
  })

  it('counts a non-string key into its own bucket rather than dropping it', async () => {
    const kv = { get: () => Promise.resolve(null) } as unknown as KVNamespace
    const census = createReadCensus()
    const wrapped = census.wrapKv(kv)
    const badGet = wrapped.get as unknown as (k: unknown) => Promise<unknown>
    for (let i = 0; i < 5; i++) await badGet(undefined)
    await wrapped.get('probe:24h')
    const snap = census.snapshot()
    expect(snap.total).toBe(6)
    // Present in BOTH lists — a read that only showed up at one depth would make the two disagree.
    // Exact, ORDERED equality on both: the extras are concatenated after rollupByDepth has already
    // sorted, so `toContainEqual` alone passes even when a list never goes back through
    // reconcileBuckets — and that is the only thing that would notice a shortfall.
    expect(snap.families).toEqual([[NON_STRING_BUCKET, 5], ['probe:*', 1]])
    // Descending, INCLUDING the appended buckets: they are concatenated after rollupByDepth has
    // already sorted, so this ordering is only correct if snapshot() runs them back through
    // reconcileBuckets — which is also the only thing that would notice a shortfall.
    expect(snap.detail).toEqual([[NON_STRING_BUCKET, 5], ['probe:24h', 1]])
  })

  it('caps tracked keys but keeps `total` exact, and says so', async () => {
    const kv = { get: () => Promise.resolve(null) } as unknown as KVNamespace
    const census = createReadCensus()
    const wrapped = census.wrapKv(kv)
    const overBy = 3
    const keys = Array.from({ length: MAX_TRACKED_KEYS + overBy }, (_, i) => `k${i}:v`)
    await Promise.all(keys.map(k => wrapped.get(k)))
    const snap = census.snapshot()
    expect(snap.total).toBe(keys.length)          // the falsifiable number survives the cap
    expect(snap.distinct).toBe(MAX_TRACKED_KEYS)  // attribution is what degrades
    expect(snap.families).toContainEqual([OVERFLOW_BUCKET, overBy])
    expect(snap.detail).toContainEqual([OVERFLOW_BUCKET, overBy])
  })

  it('passes the value, the options and a rejection straight through — for BOTH read methods', async () => {
    const seen: unknown[] = []
    const kv = {
      get: (key: unknown, opts?: unknown) => {
        seen.push(['get', key, opts])
        return key === 'boom' ? Promise.reject(new Error('kv down')) : Promise.resolve('payload')
      },
      getWithMetadata: (key: unknown, opts?: unknown) => {
        seen.push(['gwm', key, opts])
        return Promise.resolve({ value: 'v', metadata: { m: 1 } })
      },
    } as unknown as KVNamespace
    const census = createReadCensus()
    const wrapped = census.wrapKv(kv)
    await expect(wrapped.get('services:latest', 'text')).resolves.toBe('payload')
    await expect(wrapped.getWithMetadata('services:latest', 'json')).resolves.toEqual({ value: 'v', metadata: { m: 1 } })
    await expect(wrapped.get('boom')).rejects.toThrow('kv down')
    // Options must reach the namespace on BOTH methods: a dropped `'json'` silently returns text,
    // a dropped `cacheTtl` silently changes caching — bugs the census would INTRODUCE into callers.
    expect(seen).toEqual([['get', 'services:latest', 'text'], ['gwm', 'services:latest', 'json'], ['get', 'boom', undefined]])
    // Counted regardless of outcome, so a failing path cannot look cheap.
    expect(census.snapshot().total).toBe(3)
  })

  it('passes non-function properties through untouched', () => {
    const kv = { marker: 42, get: () => Promise.resolve(null) } as unknown as KVNamespace
    expect((createReadCensus().wrapKv(kv) as unknown as { marker: number }).marker).toBe(42)
  })

  it('snapshot() performs no KV I/O of its own — it must not consume the budget it measures', async () => {
    const { kv, calls } = fakeKv()
    const census = createReadCensus()
    await census.wrapKv(kv).get('probe:24h')
    const before = { ...calls, get: [...calls.get] }
    census.snapshot(); census.snapshot()
    expect(calls.get).toEqual(before.get)
    expect([calls.put, calls.delete, calls.list]).toEqual([0, 0, 0])
  })

  it('reports `families` at depth 1 and `detail` at depth 2 — not the same list twice', async () => {
    // rollupByDepth is tested at both depths directly, but nothing else pins WHICH depth snapshot()
    // hands to which field. `families` is the series meant to be subtracted between two runs, so a
    // depth mix-up silently destroys the one property the fixed-depth design exists to provide.
    const { kv } = fakeKv()
    const census = createReadCensus()
    const wrapped = census.wrapKv(kv)
    for (let i = 0; i < 3; i++) await wrapped.get(`alerted:new:${i}`)
    for (let i = 0; i < 5; i++) await wrapped.get(`alerted:down:svc${i}`)
    const snap = census.snapshot()
    expect(snap.families).toEqual([['alerted:*', 8]])
    expect(snap.detail).toEqual([['alerted:down:*', 5], ['alerted:new:*', 3]])
    // 8 distinct KEYS folding into 1 family bucket — the one shape where "distinct = keys" and
    // "distinct = bucket count" give different answers, so reporting the wrong one is visible here.
    expect(snap.distinct).toBe(8)
  })

  it('reports buckets summing to total, always', async () => {
    const { kv } = fakeKv()
    const census = createReadCensus()
    const wrapped = census.wrapKv(kv)
    for (let i = 0; i < 12; i++) await wrapped.get(`alerted:new:${i}`)
    await wrapped.get('pending:new:x')
    const snap = census.snapshot()
    for (const list of [snap.families, snap.detail]) {
      expect(list.reduce((a, [, n]) => a + n, 0)).toBe(snap.total)
      expect(list.map(([b]) => b)).not.toContain(UNATTRIBUTED_BUCKET)
    }
  })
})

describe('reconcileBuckets — the guard on the guard', () => {
  it('passes buckets through, sorted, when they already account for every read', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(reconcileBuckets([['a:*', 2], ['b:*', 5]], 7)).toEqual([['b:*', 5], ['a:*', 2]])
    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
  })

  it('names the shortfall and shouts when the buckets do not sum to total', () => {
    // Its passing state is the default, so the test that matters is the one that makes it fail: a
    // bucketing bug otherwise reports a correct total, a short sum, and reads attributed to nothing.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(reconcileBuckets([['a:*', 2]], 9)).toEqual([[UNATTRIBUTED_BUCKET, 7], ['a:*', 2]])
    expect(err).toHaveBeenCalledOnce()
    expect(String(err.mock.calls[0].join(' '))).toContain('BUCKETS DO NOT SUM TO TOTAL')
    err.mockRestore()
  })

  it('reports an over-count too — a negative shortfall is still a disagreement', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(reconcileBuckets([['a:*', 9]], 4)).toContainEqual([UNATTRIBUTED_BUCKET, -5])
    expect(err).toHaveBeenCalledOnce()
    err.mockRestore()
  })
})

describe('formatCensus', () => {
  const snap = (pairs: Array<[string, number]>) => pairs

  it('renders bucket=count pairs in order', () => {
    expect(formatCensus(snap([['alerted:new:*', 14], ['probe:24h', 2]]))).toBe('alerted:new:*=14 probe:24h=2')
  })

  it('rolls the tail into `other=` carrying BOTH its reads and its bucket count', () => {
    // A truncation that hid its own size would let the heaviest source sit inside the tail and read
    // as absent — the exact misreading this whole issue is trying to stop making.
    expect(formatCensus(snap([['a:b:*', 10], ['c:d:*', 5], ['e:f:*', 3], ['g:h:*', 1]]), 2))
      .toBe('a:b:*=10 c:d:*=5 other=4(2 buckets)')
  })

  it('omits `other=` when nothing was truncated', () => {
    expect(formatCensus(snap([['a:b:*', 1]]), 12)).toBe('a:b:*=1')
  })

  it('renders an empty census as the empty string', () => {
    expect(formatCensus(snap([]))).toBe('')
  })
})

// ── Wiring: drive the real handler ───────────────────────────────────────────
//
// Source-text assertions are a hand-written parser and the language always wins
// (`feedback_pin_the_decision_not_the_spelling`). These invoke `scheduled()` for real and read the
// line it emits, so unwiring it, gating it behind a condition, returning early, or throwing are all
// caught by the same assertion — and a rename is not.
describe('cron wiring (#1224 Phase 2)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
  const event = { scheduledTime: Date.parse('2026-08-25T03:45:00Z'), cron: '*/5 * * * *' } as ScheduledEvent

  /** Run the cron with no network and a recording KV; return the census line and the KV's own tally. */
  async function runCron(env: Record<string, unknown>) {
    const { kv, calls } = fakeKv()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network disabled in test'))
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await workerModule.scheduled(event, { STATUS_CACHE: kv, ...env } as never, ctx)
    return { line: logs.find(l => l.includes('#1224 kv read census')), calls }
  }

  const totalOf = (line: string | undefined): number => {
    expect(line, 'no census line was emitted').toBeDefined()
    const m2 = /total=(\d+)/.exec(line as string)
    expect(m2, `census line has no total=: ${line}`).not.toBeNull()
    return Number((m2 as RegExpExecArray)[1])
  }

  it('total equals the KV binding\'s own read count across the FULL handler body', async () => {
    // With DISCORD_WEBHOOK_URL set the handler runs past `if (!env.DISCORD_WEBHOOK_URL) return` and
    // through the alert/analysis/aggregation body — where the 5,861-vs-560 swing actually lives. A
    // run without it exits ~11% in, so a conservation claim measured there proves almost nothing.
    // `fetch` is mocked to reject, so the Discord POST fails harmlessly.
    const { line, calls } = await runCron({ DISCORD_WEBHOOK_URL: 'https://example.invalid/hook' })
    const issued = calls.get.length + calls.getWithMetadata.length
    expect(issued, 'the cron made no KV reads — this test would be vacuous').toBeGreaterThan(0)
    // Ground truth for "the cron routes its binding through the census". Unwiring it, or letting any
    // read reach the raw binding, moves these two apart.
    expect(totalOf(line)).toBe(issued)
  }, 60_000)

  it('labels the depth-1 list `family:` and the depth-2 list `detail:`, not the other way round', async () => {
    // snapshot() pins which depth goes in which FIELD; nothing pinned which field goes under which
    // LABEL. Both are Array<[string, number]>, so swapping them typechecks and the census file stays
    // green — review reproduced exactly that. The consequence is the failure the fixed-depth design
    // was adopted to prevent: an operator subtracting two runs would subtract the wrong series.
    const { line } = await runCron({ DISCORD_WEBHOOK_URL: 'https://example.invalid/hook' })
    const parts = /\| family: (.*?) \| detail: (.*)$/.exec(line as string)
    expect(parts, `line had no family:/detail: split: ${line}`).not.toBeNull()
    const names = (half: string) => half.split(' ')
      .map(p => p.split('=')[0]).filter(n => n && !n.startsWith('other') && !n.startsWith('<'))
    // A depth-1 bucket names one segment before its `*`; a depth-2 bucket names two. Read off the
    // real emitted line, so it cannot pass against a hand-built fixture.
    const depthOf = (n: string) => n.endsWith(':*') ? n.slice(0, -2).split(':').length : n.split(':').length
    const fam = names((parts as RegExpExecArray)[1]), det = names((parts as RegExpExecArray)[2])
    expect(fam.length, 'family: half was empty').toBeGreaterThan(0)
    expect(det.length, 'detail: half was empty').toBeGreaterThan(0)
    expect(fam.every(n => depthOf(n) === 1), `family: had a non-depth-1 bucket: ${fam.join(' ')}`).toBe(true)
    expect(det.some(n => depthOf(n) === 2), `detail: had no depth-2 bucket: ${det.join(' ')}`).toBe(true)
  }, 60_000)

  it('reads MORE past the early return than before it — the contrast the previous test rests on', async () => {
    // Without this, both wiring runs could be exiting at the guard and nobody would notice.
    const short = await runCron({})
    const full = await runCron({ DISCORD_WEBHOOK_URL: 'https://example.invalid/hook' })
    expect(totalOf(full.line)).toBeGreaterThan(totalOf(short.line))
    // And the line is emitted on the early-return path too: before the try/finally it was simply
    // absent there, which under `wrangler tail` reads as "nothing to see here".
    expect(short.line).toBeDefined()
    expect(totalOf(short.line)).toBe(short.calls.get.length + short.calls.getWithMetadata.length)
  }, 60_000)

  it('emits the line even when the handler throws', async () => {
    // A read storm is plausibly an error storm, so the run that throws is one whose count matters.
    const { kv } = fakeKv()
    // Throws on a property the handler reads INSIDE the guarded region (`if (!env.DISCORD_WEBHOOK_URL)
    // return`), not on the wrap itself — the wrap runs before the try by construction.
    const exploding = new Proxy({ STATUS_CACHE: kv } as Record<string, unknown>, {
      get: (t, prop) => { if (prop === 'DISCORD_WEBHOOK_URL') throw new Error('binding exploded'); return Reflect.get(t, prop) },
    })
    const logs: string[] = []
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network disabled in test'))
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(workerModule.scheduled(event, exploding as never, ctx)).rejects.toThrow('binding exploded')
    expect(logs.find(l => l.includes('#1224 kv read census'))).toBeDefined()
  }, 30_000)

  it('never lets an instrument fault replace the handler\'s own error', async () => {
    // A throw inside `finally` REPLACES the in-flight exception, so a census bug would erase the
    // outage it was measuring. Forced by making the snapshot's own rendering throw.
    const { kv } = fakeKv()
    const exploding = new Proxy({ STATUS_CACHE: kv } as Record<string, unknown>, {
      get: (t, prop) => { if (prop === 'DISCORD_WEBHOOK_URL') throw new Error('the real error'); return Reflect.get(t, prop) },
    })
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network disabled in test'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errs: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.map(String).join(' ')) })
    vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('census rendering blew up') })
    // The body's error survives; the census failure is reported separately, not swapped in.
    await expect(workerModule.scheduled(event, exploding as never, ctx)).rejects.toThrow('the real error')
    expect(errs.some(e => e.includes('kv read census FAILED'))).toBe(true)
  }, 60_000)

  it('says so instead of reporting a plausible zero when there is no KV binding', async () => {
    // `total=0 distinct=0` with an empty bucket tail is indistinguishable from "this run read
    // nothing", which is the "everything is small" failure this module exists to end.
    const logs: string[] = []
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network disabled in test'))
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await workerModule.scheduled(event, {} as never, ctx)
    const line = logs.find(l => l.includes('#1224 kv read census'))
    expect(line).toContain('uninstrumented')
  }, 30_000)
})
