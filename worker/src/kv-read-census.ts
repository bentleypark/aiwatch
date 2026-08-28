/**
 * #1224 Phase 2 — per-run KV **read** attribution for the every-5-minute cron.
 *
 * ## Why key prefixes and not call sites
 *
 * A gate targets a KEY — "stop reading `alerted:new:` past the alert bound" was Phase 1's whole
 * shape. The prefix is therefore the unit a fix would name, and it survives the code moving between
 * files.
 *
 * ## What the numbers can and cannot be checked against
 *
 * It is **not** comparable to the account-level read count as an equality. The `fetch()` handler
 * reads the same namespace on every request (60s SPA polling, the is-down Edge pages), and none of
 * that is instrumented here. The honest check is a **one-directional bound**: for a given minute,
 * `census total <= account reads`.
 *
 * The invariant that is checkable from inside is conservation — every counted read lands in exactly
 * one bucket — so {@link ReadCensus.snapshot} verifies it on every call rather than trusting it.
 * A diagnostic that fails by quietly reporting "everything is small" is the failure mode this module
 * exists to end (`feedback_derived_signal_needs_scoped_diagnostic`).
 *
 * ## Counting happens at the CALL, not at the settle
 *
 * {@link createReadCensus} records the key synchronously, before invoking the underlying method. So a
 * read whose promise settles after the run's line is logged is still counted, which is what makes
 * `ctx.waitUntil(maybeDispatchDeepseekFeed(env))` safe: its one read (`deepseek:dispatch:cooldown`)
 * is issued synchronously and counted, even though the dispatch it guards outlives the handler. The
 * ordering is an invariant, not an accident — a "count only successful reads" change would break it.
 */

/**
 * Cap on distinct keys held in memory for one run. The instrument exists because read volume can
 * swing 10x between adjacent runs, so its own footprint must not be a function of that swing. Past
 * the cap, reads are counted into {@link OVERFLOW_BUCKET} instead of a per-key entry — `total` stays
 * exact, only the attribution degrades, and it says so.
 */
export const MAX_TRACKED_KEYS = 50_000

/** Reads past {@link MAX_TRACKED_KEYS} distinct keys: counted, not attributed. */
export const OVERFLOW_BUCKET = '<overflow>'
/** Reads issued with a non-string key. Counted rather than dropped, so it can never read as cheap. */
export const NON_STRING_BUCKET = '<non-string-key>'
/** Reads the bucketing failed to place. Non-zero means a bug in this module, not in KV. */
export const UNATTRIBUTED_BUCKET = '<unattributed>'

/**
 * Fold a run's exact key counts onto the first `depth` `:`-separated segments, marking a truncated
 * tail with `*`. `rollupByDepth(counts, 1)` puts `alerted:new:{incId}` and `alerted:down:{svcId}`
 * both in `alerted:*`; at depth 2 they separate.
 *
 * **Positional and unconditional, deliberately.** Two earlier cuts tried to INFER where the fixed
 * vocabulary ends and the ids begin, and review disproved both by execution. A rule that reads the
 * run makes the bucket NAMES a function of the data, so two runs cannot be subtracted — which is the
 * one thing this instrument exists to do. A fixed depth has no such failure. The rejected designs and
 * the shapes that broke them are asserted executably by the `rollupByDepth` tests, not restated here.
 *
 * Depth 2 keeps one bucket per id for the few families whose SECOND segment is an id
 * (`recovered:{svcId}:{incId}`), which is why both depths are reported: depth 1 is the comparable
 * series, depth 2 says where inside a family to look.
 *
 * Pure. Conserves totals: every input count lands in exactly one bucket, at any depth.
 */
export function rollupByDepth(counts: Map<string, number>, depth: number): Array<[string, number]> {
  const agg = new Map<string, number>()
  for (const [key, n] of counts) {
    const segs = key.split(':')
    const bucket = segs.length > depth ? `${segs.slice(0, depth).join(':')}:*` : key
    agg.set(bucket, (agg.get(bucket) ?? 0) + n)
  }
  return [...agg].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

export interface CensusSnapshot {
  /** Every read this run issued through the wrapped namespace. A lower bound on the account figure. */
  total: number
  /** Distinct KEYS read — a jump here means key cardinality, not read volume, grew. */
  distinct: number
  /** Depth-1 families, descending by count then name. Sums to `total`. The comparable series. */
  families: Array<[string, number]>
  /** Depth-2 detail, descending by count then name. Sums to `total`. Where inside a family to look. */
  detail: Array<[string, number]>
}

export interface ReadCensus {
  /** Wrap a KV namespace so every `get`/`getWithMetadata` is counted. Writes/deletes/lists pass through uncounted. */
  wrapKv(kv: KVNamespace): KVNamespace
  snapshot(): CensusSnapshot
}

/**
 * A read counter with no I/O of its own — it must not consume the budget it measures, so it holds
 * counts in the isolate and is emitted as a single log line.
 */
export function createReadCensus(): ReadCensus {
  let total = 0
  let overflow = 0
  let nonString = 0
  const counts = new Map<string, number>()

  const record = (key: unknown): void => {
    // A bulk get (`kv.get([...])`) is billed per key, so it must be counted per key.
    if (Array.isArray(key)) { for (const k of key) record(k); return }
    total++
    if (typeof key !== 'string') { nonString++; return }
    const prior = counts.get(key)
    if (prior === undefined && counts.size >= MAX_TRACKED_KEYS) { overflow++; return }
    counts.set(key, (prior ?? 0) + 1)
  }

  return {
    wrapKv(kv: KVNamespace): KVNamespace {
      // A Proxy rather than an object literal listing the five methods: the literal silently drops
      // any method this file did not anticipate, turning a KV API addition into a runtime TypeError
      // on the cron path. This forwards every other property, rebinding methods to the real
      // namespace (so method identity is not stable across accesses — `wrapped.put !== wrapped.put`).
      return new Proxy(kv, {
        get(target, prop) {
          // Deliberately NOT `Reflect.get(target, prop, receiver)`: passing the proxy as receiver is
          // how a host object that exposes state through a prototype accessor throws on the cron path
          // — another way a throw reaches the cron path.
          const value = Reflect.get(target, prop)
          if (typeof value !== 'function') return value
          if (prop === 'get' || prop === 'getWithMetadata') {
            return (key: unknown, ...rest: unknown[]) => {
              // Before the call, not after: see the module header's count-at-call invariant.
              record(key)
              return (value as (...a: unknown[]) => unknown).call(target, key, ...rest)
            }
          }
          return (value as (...a: unknown[]) => unknown).bind(target)
        },
      })
    },
    snapshot(): CensusSnapshot {
      const extra: Array<[string, number]> = []
      if (overflow > 0) extra.push([OVERFLOW_BUCKET, overflow])
      if (nonString > 0) extra.push([NON_STRING_BUCKET, nonString])
      return {
        total,
        distinct: counts.size,
        families: reconcileBuckets([...rollupByDepth(counts, 1), ...extra], total),
        detail: reconcileBuckets([...rollupByDepth(counts, 2), ...extra], total),
      }
    },
  }
}

/**
 * Make the buckets account for every counted read, or say loudly that they do not.
 *
 * Reconcile rather than assume: a bucketing bug reports a correct `total`, a short bucket sum, and
 * reads attributed to nothing — no throw, no warning, just smaller numbers, which is this module's
 * own worst failure mode. Exported so the guard itself can be tested; a guard whose passing
 * state is the default needs a test that makes it fail (`feedback_mutation_test_both_directions`).
 *
 * Returns the buckets sorted, with an {@link UNATTRIBUTED_BUCKET} entry appended when they fall short.
 */
export function reconcileBuckets(buckets: Array<[string, number]>, total: number): Array<[string, number]> {
  const attributed = buckets.reduce((sum, [, n]) => sum + n, 0)
  const out = attributed === total ? [...buckets] : [...buckets, [UNATTRIBUTED_BUCKET, total - attributed] as [string, number]]
  if (attributed !== total) {
    console.error('[cron] #1224 kv read census — BUCKETS DO NOT SUM TO TOTAL', `total=${total}`, `attributed=${attributed}`)
  }
  return out.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/**
 * Render a bucket list as part of one log line: the `topN` heaviest, then an `other=` rollup
 * carrying BOTH the reads and the bucket count it stands for — a truncation that hid its own size
 * would let the biggest source sit inside `other` and read as absent.
 *
 * Pure.
 */
export function formatCensus(buckets: Array<[string, number]>, topN = 12): string {
  const head = buckets.slice(0, topN)
  const tail = buckets.slice(topN)
  const parts = head.map(([bucket, n]) => `${bucket}=${n}`)
  if (tail.length > 0) {
    const rest = tail.reduce((sum, [, n]) => sum + n, 0)
    parts.push(`other=${rest}(${tail.length} buckets)`)
  }
  return parts.join(' ')
}
