// #1106 Part 5 — the durable withdrawal log.
//
// The feature's own exit condition is a production OBSERVATION that cannot be scheduled (it needs a
// provider to delete an announced incident), and every trace of a withdrawal expires within a week.
// This log is the only thing that can answer "did it fire, and did the thread close?" months later —
// so the tests here are mostly about the two ways a log LIES: overwriting its own history on a
// transient read failure, and reporting a row as closed (or never-closed) when it wasn't.
//
// Both write points are pinned in BOTH directions (#1032/#1052): the prune must record, ordinary
// accumulation must NOT, the announce stamp must land, and a non-withdrawal alert key must not stamp
// anything. The cron half has no harness (nothing drives `scheduled`), so it is pinned at the source
// level with the same idiom as withdrawn.test.ts.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import workerModule from '../index'
import {
  monthOfIso,
  monthsBackFrom,
  upsertPrunedRows,
  markRowsAnnounced,
  isPermanentlyUnclosed,
  readWithdrawalLog,
  recordWithdrawalsPruned,
  markWithdrawalsAnnounced,
  withdrawalIdsFromAlertKeys,
  withdrawalLogKey,
  WITHDRAWAL_LOG_MAX,
  WITHDRAWN_LOG_UNCLOSED_AFTER_MS,
  type WithdrawalLogEntry,
} from '../withdrawal-log'
import { appendWithdrawn, WITHDRAWN_KEY, WITHDRAWN_TTL_S, type WithdrawnIncident } from '../withdrawn'
import { accumulateIncidentsOnlyIfChanged, PHANTOM_PRUNE_AFTER_MISSED_RUNS } from '../monthly-archive'
import type { ServiceStatus, Incident } from '../types'

const KEY = 'incidents:withdrawn:log:2026-07'

const makeKV = (seed: Record<string, string> = {}) => {
  const store: Record<string, string> = { ...seed }
  // The third parameter is declared (unused here) so a test can assert on the TTL options `kvPut`
  // forwards — the durable log must carry none, the 48h roster must keep its own.
  const put = vi.fn(async (k: string, v: string, _opts?: { expirationTtl?: number }) => { store[k] = v })
  return {
    store,
    put,
    kv: {
      get: async (k: string) => store[k] ?? null,
      put,
      delete: async (k: string) => { delete store[k] },
    } as unknown as KVNamespace,
  }
}

const tomb = (over: Partial<WithdrawnIncident> = {}): WithdrawnIncident => ({
  svcId: 'mistral', incId: 'aud-1', title: 'Audio API Degraded',
  startedAt: '2026-07-17T08:18:00Z', prunedAt: '2026-07-21T09:00:00Z', ...over,
})

const row = (over: Partial<WithdrawalLogEntry> = {}): WithdrawalLogEntry => ({
  svcId: 'mistral', incId: 'aud-1', title: 'Audio API Degraded',
  startedAt: '2026-07-17T08:18:00Z', prunedAt: '2026-07-21T09:00:00Z', ...over,
})

// Faithful fixture (#1021) — a resolved incident carries a duration, an unresolved one does not.
const inc = (id: string, startedAt: string, status: Incident['status'] = 'investigating'): Incident => ({
  id, title: `inc ${id}`, status, impact: null, startedAt,
  duration: status === 'resolved' ? '10m' : null,
  ...(status === 'resolved' ? { resolvedAt: '2026-07-17T08:28:00Z' } : {}),
  timeline: [],
})
const svc = (incidents: Incident[]): ServiceStatus => ({
  id: 'mistral', name: 'Mistral API', provider: 'Mistral', category: 'api',
  status: 'down', uptime30d: null, latency: null, incidents,
} as ServiceStatus)

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

/** The ONE console.error line matching `needle`, or undefined. Per-line rather than a joined blob:
 *  joining every call together means a mutation that moves an id onto a DIFFERENT line still passes. */
type ErrSpy = { mock: { calls: unknown[][] } }
const errLines = (spy: ErrSpy): string[] => spy.mock.calls.map((c) => c.join(' '))
const errLine = (spy: ErrSpy, needle: string): string | undefined =>
  errLines(spy).find((l) => l.includes(needle))
/** Anchored on the stable `[withdrawal-log]` tag + "under-report", not on the sentence, so a copy
 *  edit does not fail the test while a behaviour change still does. */
const underReportLine = (spy: ErrSpy): string | undefined =>
  errLines(spy).find((l) => /\[withdrawal-log\].*under-report/.test(l))

// ── Pure: month bucketing ───────────────────────────────────────────────────

describe('monthOfIso', () => {
  it('takes the month WRITTEN in the string, not a local-timezone re-derivation', () => {
    expect(monthOfIso('2026-07-31T23:30:00Z')).toBe('2026-07')
    expect(monthOfIso('2026-01-01T00:00:00Z')).toBe('2026-01')
  })

  it('rejects anything unparseable rather than inventing a bucket', () => {
    expect(monthOfIso('not a date')).toBeNull()
    expect(monthOfIso('')).toBeNull()
    expect(monthOfIso(undefined as unknown as string)).toBeNull()
  })
})

describe('monthsBackFrom', () => {
  it('walks back across a year boundary', () => {
    expect(monthsBackFrom('2026-01-15T00:00:00Z', 3)).toEqual(['2026-01', '2025-12', '2025-11'])
  })

  it('returns exactly `count` months, newest first', () => {
    expect(monthsBackFrom('2026-07-22T00:00:00Z', 1)).toEqual(['2026-07'])
    expect(monthsBackFrom('2026-03-31T00:00:00Z', 2)).toEqual(['2026-03', '2026-02'])
  })

  it('yields nothing for an unusable anchor rather than inventing months', () => {
    expect(monthsBackFrom('nonsense', 3)).toEqual([])
  })
})

// ── Pure: the id extraction the cron feeds the stamp ────────────────────────

describe('withdrawalIdsFromAlertKeys', () => {
  // Extracted from index.ts precisely so this is behavioural, not source-pinned: an off-by-one in
  // the slice yields `wd:aud-1`, matches no row, and makes EVERY withdrawal report never-closed.
  it('takes the id after the alerted:wd: prefix', () => {
    expect([...withdrawalIdsFromAlertKeys(['alerted:wd:aud-1'])]).toEqual(['aud-1'])
  })

  it('ignores every other alert kind', () => {
    const ids = withdrawalIdsFromAlertKeys(['alerted:new:n-1', 'alerted:res:r-1', 'alerted:down:claude', 'alerted:wd:aud-1'])
    expect([...ids]).toEqual(['aud-1'])
  })

  it('drops a bare prefix with no id — it would match nothing and stamp nothing', () => {
    expect(withdrawalIdsFromAlertKeys(['alerted:wd:']).size).toBe(0)
  })

  it('is empty for an empty key list', () => {
    expect(withdrawalIdsFromAlertKeys([]).size).toBe(0)
  })
})

// ── Pure: upsert ────────────────────────────────────────────────────────────

describe('upsertPrunedRows', () => {
  it('records a fresh tombstone with no announcedAt — the thread is open until something closes it', () => {
    const out = upsertPrunedRows([], [tomb()])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ svcId: 'mistral', incId: 'aud-1', title: 'Audio API Degraded' })
    expect(out[0].announcedAt).toBeUndefined()
  })

  it('is first-write-wins: a re-prune must not move prunedAt', () => {
    // prunedAt is the clock the "permanently unclosed" verdict is derived from, so a moving value
    // would keep resetting the 48h window and make a lost notice look forever pending.
    const out = upsertPrunedRows([row()], [tomb({ prunedAt: '2026-07-22T09:00:00Z' })])
    expect(out).toHaveLength(1)
    expect(out[0].prunedAt).toBe('2026-07-21T09:00:00Z')
  })

  it('and must not erase an announcedAt already stamped on the row', () => {
    const out = upsertPrunedRows([row({ announcedAt: '2026-07-21T09:05:00Z' })], [tomb()])
    expect(out[0].announcedAt).toBe('2026-07-21T09:05:00Z')
  })

  it('keys by (svcId, incId), so one provider id across two services is two rows', () => {
    const out = upsertPrunedRows([], [tomb(), tomb({ svcId: 'claude' })])
    expect(out.map((r) => r.svcId)).toEqual(['mistral', 'claude'])
  })

  it('caps the month, evicting the OLDEST rows', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const existing = Array.from({ length: WITHDRAWAL_LOG_MAX }, (_, i) => row({ incId: `old-${i}` }))
    const out = upsertPrunedRows(existing, [tomb({ incId: 'new-1' })])
    expect(out).toHaveLength(WITHDRAWAL_LOG_MAX)
    expect(out.at(-1)?.incId).toBe('new-1')
    expect(out.some((r) => r.incId === 'old-0')).toBe(false)
  })

  it('names what eviction erased, and flags the never-announced ones as permanently lost', () => {
    // Eviction only trips on the pathological mass-deletion the cap exists for — i.e. exactly when
    // the rows matter most. A bare count would leave the loss unreconstructible.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const existing = Array.from({ length: WITHDRAWAL_LOG_MAX }, (_, i) =>
      row({ incId: `old-${i}`, ...(i === 0 ? {} : { announcedAt: '2026-07-21T09:05:00Z' }) }))
    upsertPrunedRows(existing, [tomb({ incId: 'new-1' })])
    const line = errLine(err, 'evicting')!
    expect(line).toContain('mistral/old-0')
    expect(line).toMatch(/\b1 never/)
  })
})

// ── Pure: the announce stamp ────────────────────────────────────────────────

describe('markRowsAnnounced', () => {
  it('stamps only the ids given, and reports the change', () => {
    const res = markRowsAnnounced([row(), row({ incId: 'other' })], new Set(['aud-1']), '2026-07-21T09:05:00Z')
    expect(res.changed).toBe(true)
    expect(res.rows[0].announcedAt).toBe('2026-07-21T09:05:00Z')
    expect(res.rows[1].announcedAt).toBeUndefined()
  })

  it('is first-write-wins — a re-sent notice must not move the moment the thread closed', () => {
    const res = markRowsAnnounced([row({ announcedAt: '2026-07-21T09:05:00Z' })], new Set(['aud-1']), '2026-07-21T10:00:00Z')
    expect(res.changed).toBe(false)
    expect(res.rows[0].announcedAt).toBe('2026-07-21T09:05:00Z')
  })

  it('reports changed=false when no row matches, so the caller can skip the KV write', () => {
    expect(markRowsAnnounced([row()], new Set(['nope']), '2026-07-21T09:05:00Z').changed).toBe(false)
  })

  it('reports which ids it actually stamped — a failure log must not name rows that were fine', () => {
    const res = markRowsAnnounced([row(), row({ incId: 'other' })], new Set(['aud-1', 'elsewhere']), '2026-07-21T09:05:00Z')
    expect(res.stamped).toEqual(['aud-1'])
  })

  it('reports an ALREADY-stamped row as matched, so a re-fire is not read as a lost record', () => {
    // A withdrawal re-fires whenever the `alerted:wd:` write failed or its dedup read errored. The
    // row is there and correctly stamped — conflating that with "no row" fires the under-report
    // alarm on the healthy path, and an alarm that fires on the normal case is a dead alarm.
    const res = markRowsAnnounced([row({ announcedAt: '2026-07-21T09:05:00Z' })], new Set(['aud-1']), '2026-07-21T10:00:00Z')
    expect(res.changed).toBe(false)
    expect(res.stamped).toEqual([])
    expect(res.matched).toEqual(['aud-1'])
  })
})

// ── Pure: the verdict ───────────────────────────────────────────────────────

describe('isPermanentlyUnclosed', () => {
  const at = (iso: string) => Date.parse(iso)

  it('is false once announced', () => {
    expect(isPermanentlyUnclosed(row({ announcedAt: '2026-07-21T09:05:00Z' }), at('2026-08-01T00:00:00Z'))).toBe(false)
  })

  it('is false while the tombstone still lives — the notice may yet go out', () => {
    expect(isPermanentlyUnclosed(row(), at('2026-07-22T09:00:00Z'))).toBe(false)
  })

  it('is true once the tombstone has aged out, because nothing can render the notice any more', () => {
    expect(isPermanentlyUnclosed(row(), at('2026-07-23T09:01:00Z'))).toBe(true)
  })

  // Probe the boundary itself, not a value halfway to it: a mutated `/ 2` threshold survives a
  // 24h-false + 48h-true pair, and would report routine 25h holds as #1106 regressions.
  it('flips exactly at the roster TTL, not before', () => {
    const pruned = Date.parse('2026-07-21T09:00:00Z')
    expect(isPermanentlyUnclosed(row(), pruned + WITHDRAWN_LOG_UNCLOSED_AFTER_MS - 60_000)).toBe(false)
    expect(isPermanentlyUnclosed(row(), pruned + WITHDRAWN_LOG_UNCLOSED_AFTER_MS)).toBe(false)
    expect(isPermanentlyUnclosed(row(), pruned + WITHDRAWN_LOG_UNCLOSED_AFTER_MS + 1000)).toBe(true)
  })

  it('never claims a permanent loss from an unparseable prunedAt', () => {
    expect(isPermanentlyUnclosed(row({ prunedAt: 'garbage' }), at('2026-09-01T00:00:00Z'))).toBe(false)
  })

  // The threshold is DERIVED from the roster's TTL. Restating it as a literal is how the two drift
  // into disagreeing about when a pending row becomes a loss.
  it('derives its threshold from the tombstone roster TTL', () => {
    expect(WITHDRAWN_LOG_UNCLOSED_AFTER_MS).toBe(WITHDRAWN_TTL_S * 1000)
  })
})

// ── KV: read ────────────────────────────────────────────────────────────────

describe('readWithdrawalLog', () => {
  it('distinguishes "no withdrawals" from "could not read" — the whole point of the endpoint', async () => {
    const { kv } = makeKV()
    expect(await readWithdrawalLog(kv, '2026-07')).toEqual({ rows: [], readable: true, droppedMalformed: 0 })
  })

  it('reports a corrupt value as UNREADABLE, not as zero withdrawals', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv } = makeKV({ [KEY]: '{ not json' })
    expect(await readWithdrawalLog(kv, '2026-07')).toEqual({ rows: [], readable: false, droppedMalformed: 0 })
  })

  it('reports a KV throw as unreadable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const kv = { get: async () => { throw new Error('kv down') }, put: async () => {} } as unknown as KVNamespace
    expect(await readWithdrawalLog(kv, '2026-07')).toEqual({ rows: [], readable: false, droppedMalformed: 0 })
  })

  // VALID JSON of the wrong shape — a `{rows:[…]}` migration, a rollback, a hand-edit. Read as
  // "empty and fine", the very next prune would overwrite the month with a single row.
  it.each([['null', 'null'], ['a string', '"hello"'], ['an object', '{"rows":[]}']])(
    'reports %s as unreadable rather than empty',
    async (_label, raw) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { kv } = makeKV({ [KEY]: raw })
      expect(await readWithdrawalLog(kv, '2026-07')).toEqual({ rows: [], readable: false, droppedMalformed: 0 })
    },
  )

  it('and a non-array value therefore survives a following prune untouched', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv, store } = makeKV({ [KEY]: '{"rows":[]}' })
    await recordWithdrawalsPruned(kv, [tomb()])
    expect(store[KEY]).toBe('{"rows":[]}')
  })

  it('drops malformed rows (shape drift across a rollback) but keeps the good ones, and counts the loss', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv } = makeKV({ [KEY]: JSON.stringify([row(), { svcId: 'x' }, null, row({ incId: 'b', announcedAt: '' })]) })
    const { rows, readable, droppedMalformed } = await readWithdrawalLog(kv, '2026-07')
    expect(readable).toBe(true)
    expect(rows.map((r) => r.incId)).toEqual(['aud-1'])
    // Reported, not just counted: the next write erases these permanently, so the line has to carry
    // enough to reconstruct them.
    expect(droppedMalformed).toBe(3)
    expect(err.mock.calls.at(-1)!.join(' ')).toContain('"svcId":"x"')
  })
})

// ── KV: write point 1 ───────────────────────────────────────────────────────

describe('recordWithdrawalsPruned', () => {
  it('files each row under the month of its own prunedAt, not "now"', async () => {
    const { kv, store } = makeKV()
    await recordWithdrawalsPruned(kv, [tomb(), tomb({ incId: 'jun-1', prunedAt: '2026-06-30T23:50:00Z' })])
    expect(JSON.parse(store[KEY]).map((r: WithdrawalLogEntry) => r.incId)).toEqual(['aud-1'])
    expect(JSON.parse(store[withdrawalLogKey('2026-06')]).map((r: WithdrawalLogEntry) => r.incId)).toEqual(['jun-1'])
  })

  it('is idempotent — a repeated prune of the same id writes nothing further', async () => {
    const { kv, put } = makeKV()
    await recordWithdrawalsPruned(kv, [tomb()])
    const writes = put.mock.calls.length
    await recordWithdrawalsPruned(kv, [tomb()])
    expect(put.mock.calls.length).toBe(writes)
  })

  it('does NOT overwrite the month when the existing value could not be read', async () => {
    // The failure this guards: starting from [] on a transient blip republishes an empty month and
    // destroys every row the log exists to keep.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store: Record<string, string> = { [KEY]: JSON.stringify([row({ incId: 'historic' })]) }
    const kv = {
      get: async () => { throw new Error('kv down') },
      put: async (k: string, v: string) => { store[k] = v },
    } as unknown as KVNamespace
    await recordWithdrawalsPruned(kv, [tomb()])
    expect(JSON.parse(store[KEY]).map((r: WithdrawalLogEntry) => r.incId)).toEqual(['historic'])
  })

  it('same for a corrupt existing value — refuse the write rather than silently truncate the month', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv, store } = makeKV({ [KEY]: 'not json' })
    await recordWithdrawalsPruned(kv, [tomb()])
    expect(store[KEY]).toBe('not json')
  })

  it('writes it with NO expirationTtl — the durability IS the feature', async () => {
    // The sibling call in withdrawn.ts passes `{ expirationTtl: WITHDRAWN_KEY_TTL_S }`; copy-pasting
    // it here would evaporate the log after 48h and nothing would notice until the #1106 question is
    // asked months later.
    const { kv, put } = makeKV()
    await recordWithdrawalsPruned(kv, [tomb()])
    // `kvPut` always forwards a third argument, so the assertion is that it carries no TTL — not
    // that it is absent.
    expect(put.mock.calls.at(-1)?.[2]).toBeUndefined()
  })

  it('while the 48h tombstone roster KEEPS its TTL — the two must not converge from either side', async () => {
    const { kv, put } = makeKV()
    await appendWithdrawn(kv, [tomb()])
    expect((put.mock.calls.at(-1)?.[2] as { expirationTtl?: number } | undefined)?.expirationTtl).toBeGreaterThan(0)
  })

  it('records a NEW id even once the month has hit the cap — the skip is by identity, not length', async () => {
    // The mutation this catches: `if (merged.length === rows.length) continue`. Once a month is
    // full, the cap evicts as many as it adds, so length is always equal and every subsequent
    // withdrawal is silently discarded forever.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const full = Array.from({ length: WITHDRAWAL_LOG_MAX }, (_, i) => row({ incId: `old-${i}` }))
    const { kv, store, put } = makeKV({ [KEY]: JSON.stringify(full) })
    await recordWithdrawalsPruned(kv, [tomb({ incId: 'fresh-1' })])
    expect(put).toHaveBeenCalled()
    expect(JSON.parse(store[KEY]).some((r: WithdrawalLogEntry) => r.incId === 'fresh-1')).toBe(true)
  })

  it('an unreadable month does not stop a healthy one in the same call', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const junKey = withdrawalLogKey('2026-06')
    const store: Record<string, string> = { [junKey]: 'not json' }
    const kv = {
      get: async (k: string) => store[k] ?? null,
      put: async (k: string, v: string) => { store[k] = v },
    } as unknown as KVNamespace
    await recordWithdrawalsPruned(kv, [tomb({ incId: 'jun-1', prunedAt: '2026-06-30T23:50:00Z' }), tomb()])
    expect(store[junKey]).toBe('not json')
    expect(JSON.parse(store[KEY]).map((r: WithdrawalLogEntry) => r.incId)).toEqual(['aud-1'])
  })

  it('names the tombstones it refused to record — their identity exists nowhere else afterwards', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv } = makeKV({ [KEY]: 'not json' })
    await recordWithdrawalsPruned(kv, [tomb()])
    expect(errLine(err, 'skipping write')).toContain('mistral/aud-1')
  })

  it('skips a tombstone whose prunedAt cannot be bucketed, without losing the others', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { kv, store } = makeKV()
    await recordWithdrawalsPruned(kv, [tomb({ incId: 'bad', prunedAt: 'garbage' }), tomb()])
    expect(JSON.parse(store[KEY]).map((r: WithdrawalLogEntry) => r.incId)).toEqual(['aud-1'])
  })
})

// ── KV: write point 2 ───────────────────────────────────────────────────────

describe('markWithdrawalsAnnounced', () => {
  it('stamps the row in the current month', async () => {
    const { kv, store } = makeKV({ [KEY]: JSON.stringify([row()]) })
    await markWithdrawalsAnnounced(kv, new Set(['aud-1']), new Date('2026-07-21T09:05:00Z'))
    expect(JSON.parse(store[KEY])[0].announcedAt).toBe('2026-07-21T09:05:00.000Z')
  })

  it('also stamps a row in the PREVIOUS month — a tombstone lives 48h and can cross the boundary', async () => {
    // Without this the row would read "never closed" forever, which is the false positive the log
    // exists to make impossible.
    const junKey = withdrawalLogKey('2026-06')
    const { kv, store } = makeKV({ [junKey]: JSON.stringify([row({ prunedAt: '2026-06-30T23:50:00Z' })]) })
    await markWithdrawalsAnnounced(kv, new Set(['aud-1']), new Date('2026-07-01T00:10:00Z'))
    expect(JSON.parse(store[junKey])[0].announcedAt).toBe('2026-07-01T00:10:00.000Z')
  })

  it('crosses a YEAR boundary too', async () => {
    const decKey = withdrawalLogKey('2025-12')
    const { kv, store } = makeKV({ [decKey]: JSON.stringify([row({ prunedAt: '2025-12-31T23:50:00Z' })]) })
    await markWithdrawalsAnnounced(kv, new Set(['aud-1']), new Date('2026-01-01T00:10:00Z'))
    expect(JSON.parse(store[decKey])[0].announcedAt).toBe('2026-01-01T00:10:00.000Z')
  })

  it('crosses a FEBRUARY boundary — a fixed-day-offset implementation would skip the month entirely', async () => {
    // `now - 30d` on 2026-03-01 lands in January, so a Feb-28 prune announced on Mar-1 would read
    // never-closed forever. Only real calendar arithmetic passes this.
    const febKey = withdrawalLogKey('2026-02')
    const { kv, store } = makeKV({ [febKey]: JSON.stringify([row({ prunedAt: '2026-02-28T23:50:00Z' })]) })
    await markWithdrawalsAnnounced(kv, new Set(['aud-1']), new Date('2026-03-01T00:10:00Z'))
    expect(JSON.parse(store[febKey])[0].announcedAt).toBe('2026-03-01T00:10:00.000Z')
  })

  it('still checks the previous month MID-month, not only on the 1st', async () => {
    const junKey = withdrawalLogKey('2026-06')
    const { kv, store } = makeKV({ [junKey]: JSON.stringify([row({ prunedAt: '2026-06-28T00:00:00Z' })]) })
    await markWithdrawalsAnnounced(kv, new Set(['aud-1']), new Date('2026-07-20T12:00:00Z'))
    expect(JSON.parse(store[junKey])[0].announcedAt).toBe('2026-07-20T12:00:00.000Z')
  })

  it('reads exactly the current and previous month — never a third', async () => {
    const reads: string[] = []
    const kv = {
      get: async (k: string) => { reads.push(k); return null },
      put: async () => {},
    } as unknown as KVNamespace
    await markWithdrawalsAnnounced(kv, new Set(['aud-1']), new Date('2026-07-20T12:00:00Z'))
    expect(reads).toEqual([withdrawalLogKey('2026-07'), withdrawalLogKey('2026-06')])
  })

  it('writes nothing when no row matches the ids', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv, put } = makeKV({ [KEY]: JSON.stringify([row()]) })
    await markWithdrawalsAnnounced(kv, new Set(['unknown-id']), new Date('2026-07-21T09:05:00Z'))
    expect(put).not.toHaveBeenCalled()
  })

  it('but SAYS SO — a notice with no row anywhere means the durable log under-reports it', async () => {
    // There is exactly one attempt to stamp any id, ever (the `alerted:wd:` key stops the alert
    // re-firing and the tombstone dies at 48h), so this discrepancy is permanent and must not be silent.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv } = makeKV({ [KEY]: JSON.stringify([row()]) })
    await markWithdrawalsAnnounced(kv, new Set(['unknown-id']), new Date('2026-07-21T09:05:00Z'))
    expect(underReportLine(err)).toContain('unknown-id')
  })

  // The other direction, without which the alarm could be mutated to fire always and stay green — a
  // diagnostic that fires on the healthy path is worth less than none (#761).
  it('stays SILENT on a normal successful stamp', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv } = makeKV({ [KEY]: JSON.stringify([row()]) })
    await markWithdrawalsAnnounced(kv, new Set(['aud-1']), new Date('2026-07-21T09:05:00Z'))
    expect(underReportLine(err)).toBeUndefined()
  })

  it('and silent when the row was stamped in the PREVIOUS month', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const junKey = withdrawalLogKey('2026-06')
    const { kv } = makeKV({ [junKey]: JSON.stringify([row({ prunedAt: '2026-06-30T23:50:00Z' })]) })
    await markWithdrawalsAnnounced(kv, new Set(['aud-1']), new Date('2026-07-01T00:10:00Z'))
    expect(underReportLine(err)).toBeUndefined()
  })

  it('and silent on a RE-FIRED notice whose row is already stamped — the row is not lost', async () => {
    // Reachable two ways the codebase already handles: a failed `alerted:wd:` write, or a dedup read
    // that threw. Both re-send the same notice; neither is a durable-log problem.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv } = makeKV({ [KEY]: JSON.stringify([row({ announcedAt: '2026-07-21T09:05:00Z' })]) })
    await markWithdrawalsAnnounced(kv, new Set(['aud-1']), new Date('2026-07-21T10:00:00Z'))
    expect(underReportLine(err)).toBeUndefined()
  })

  it('a write failure reports over-reporting (the row exists), NOT under-reporting', async () => {
    // Two different failures: this one leaves a real row reading never-closed; the under-report line
    // means the withdrawal has no row at all. Firing both sends the operator at the healthy prune path.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store: Record<string, string> = { [KEY]: JSON.stringify([row()]) }
    const kv = {
      get: async (k: string) => store[k] ?? null,
      put: async () => { throw new Error('kv down') },
    } as unknown as KVNamespace
    await markWithdrawalsAnnounced(kv, new Set(['aud-1']), new Date('2026-07-21T09:05:00Z'))
    expect(errLine(err, 'announce stamp FAILED')).toContain('aud-1')
    expect(underReportLine(err)).toBeUndefined()
  })

  it('does NOT claim an under-report when a month was unreadable — we cannot tell', async () => {
    // Third narrowing of this alarm. "We could not open the month" is not evidence that no row
    // exists, and the SKIPPED line above already carries the fact; asserting a loss from it sends
    // the operator at a healthy prune path.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv } = makeKV({ [KEY]: 'not json' })
    await markWithdrawalsAnnounced(kv, new Set(['aud-1']), new Date('2026-07-21T09:05:00Z'))
    expect(errLine(err, 'announce stamp SKIPPED')).toBeDefined()
    expect(underReportLine(err)).toBeUndefined()
  })

  it('an unreadable CURRENT month must not stop the previous one from being stamped', async () => {
    // `continue`, not `return`: otherwise a corrupt current month silently drops the stamp for a row
    // living in the previous one, and that row reads never-closed forever.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const junKey = withdrawalLogKey('2026-06')
    const store: Record<string, string> = { [KEY]: 'not json', [junKey]: JSON.stringify([row({ prunedAt: '2026-06-30T23:50:00Z' })]) }
    const kv = {
      get: async (k: string) => store[k] ?? null,
      put: async (k: string, v: string) => { store[k] = v },
    } as unknown as KVNamespace
    await markWithdrawalsAnnounced(kv, new Set(['aud-1']), new Date('2026-07-01T00:10:00Z'))
    expect(JSON.parse(store[junKey])[0].announcedAt).toBe('2026-07-01T00:10:00.000Z')
  })

  it('logs an UNREADABLE month distinctly — the row will read never-closed although the notice went out', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv } = makeKV({ [KEY]: 'not json' })
    await markWithdrawalsAnnounced(kv, new Set(['aud-1']), new Date('2026-07-21T09:05:00Z'))
    // Anchored on the branch being DISTINGUISHABLE (its own line, naming the month + the id),
    // not on the sentence: the point of round 1's fix was that this case stops being silent.
    const line = errLine(err, 'announce stamp SKIPPED')!
    expect(line).toContain('2026-07')
    expect(line).toContain('aud-1')
  })

  it('a write failure names only the rows it tried to stamp, not every id the cron asked about', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store: Record<string, string> = { [KEY]: JSON.stringify([row()]) }
    const kv = {
      get: async (k: string) => store[k] ?? null,
      put: async () => { throw new Error('kv down') },
    } as unknown as KVNamespace
    await markWithdrawalsAnnounced(kv, new Set(['aud-1', 'elsewhere-1']), new Date('2026-07-21T09:05:00Z'))
    const failLine = errLine(err, 'announce stamp FAILED')!
    expect(failLine).toContain('aud-1')
    expect(failLine).not.toContain('elsewhere-1')
  })

  it('writes nothing for an empty id set', async () => {
    const { kv, put } = makeKV({ [KEY]: JSON.stringify([row()]) })
    await markWithdrawalsAnnounced(kv, new Set(), new Date('2026-07-21T09:05:00Z'))
    expect(put).not.toHaveBeenCalled()
  })
})

// ── Wiring 1: the prune actually records ────────────────────────────────────
//
// A green pure-function suite says nothing about whether the accumulator calls any of this. This
// drives the REAL #975 prune to its threshold, so deleting the call site turns these red.

describe('accumulateIncidentsOnlyIfChanged → withdrawal-log wiring (#1106 Part 5)', () => {
  const live = (ids: Array<[string, string]>) => [svc(ids.map(([id, at]) => inc(id, at)))]

  it('writes a durable row for the incident the prune deletes, un-announced', async () => {
    const { kv, store } = makeKV()
    await accumulateIncidentsOnlyIfChanged(kv, live([['aud-1', '2026-07-17T08:18:00Z'], ['conv-1', '2026-07-17T08:03:00Z']]), '2026-07')
    expect(Object.keys(store).some((k) => k.startsWith('incidents:withdrawn:log:'))).toBe(false)
    for (let i = 0; i < PHANTOM_PRUNE_AFTER_MISSED_RUNS; i++) {
      await accumulateIncidentsOnlyIfChanged(kv, live([['conv-1', '2026-07-17T08:03:00Z']]), '2026-07')
    }
    const logged: WithdrawalLogEntry[] = JSON.parse(store[KEY])
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ svcId: 'mistral', incId: 'aud-1', startedAt: '2026-07-17T08:18:00Z' })
    expect(logged[0].announcedAt).toBeUndefined()
    expect(logged[0].prunedAt).toBeTruthy()
  })

  it('writes nothing on ordinary accumulation — a new incident, and a resolution', async () => {
    const { kv, store } = makeKV()
    await accumulateIncidentsOnlyIfChanged(kv, live([['a', '2026-07-01T00:00:00Z']]), '2026-07')
    await accumulateIncidentsOnlyIfChanged(kv, live([['a', '2026-07-01T00:00:00Z'], ['b', '2026-07-02T00:00:00Z']]), '2026-07')
    await accumulateIncidentsOnlyIfChanged(kv, [svc([inc('a', '2026-07-01T00:00:00Z', 'resolved'), inc('b', '2026-07-02T00:00:00Z')])], '2026-07')
    expect(Object.keys(store).some((k) => k.startsWith('incidents:withdrawn:log:'))).toBe(false)
  })

  it('the log write cannot break the accumulation it rides on', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store: Record<string, string> = {}
    const kv = {
      get: async (k: string) => store[k] ?? null,
      put: async (k: string, v: string) => {
        if (k.startsWith('incidents:withdrawn:log:')) throw new Error('kv write down')
        store[k] = v
      },
    } as unknown as KVNamespace
    await accumulateIncidentsOnlyIfChanged(kv, live([['aud-1', '2026-07-17T08:18:00Z'], ['conv-1', '2026-07-17T08:03:00Z']]), '2026-07')
    for (let i = 0; i < PHANTOM_PRUNE_AFTER_MISSED_RUNS; i++) {
      expect(await accumulateIncidentsOnlyIfChanged(kv, live([['conv-1', '2026-07-17T08:03:00Z']]), '2026-07')).toBe('written')
    }
    expect(JSON.parse(store['incidents:monthly:2026-07']).services.mistral.incidentIds).toEqual(['conv-1'])
    // AND the tombstone still landed: the log write is ordered AFTER the roster precisely so its
    // failure cannot cost the ⚪ notice. Swap the two lines and this is what goes red — otherwise the
    // #1106 bug itself regresses while every other test stays green.
    expect(JSON.parse(store[WITHDRAWN_KEY]).map((w: WithdrawnIncident) => w.incId)).toContain('aud-1')
  })
})

// ── Wiring 2: the cron announce stamp, pinned at source level ───────────────
//
// Nothing drives the cron `scheduled` handler, so the stamp can be deleted with every test above
// still green — and the log would then report every withdrawal as never-closed.

describe('#1106 Part 5 index.ts wiring', () => {
  const src = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')

  const block = (from: string, to: string): string => {
    const start = src.indexOf(from)
    expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1)
    const end = src.indexOf(to, start)
    expect(end, `anchor not found after ${from}: ${to}`).toBeGreaterThan(start)
    return src.slice(start, end)
  }

  it('stamps announcedAt AFTER the send, gated on the send result', () => {
    // Round 2's finding: stamping in the dedup-key block recorded "the thread was closed" for a
    // notice Discord rejected — `sendDiscordAlert` returns false rather than throwing, and the
    // `alerted:wd:` key is already written, so that alert never retries.
    const b = block('const operatorSent = await sendDiscordAlert', '#936 — send the tweet-reply draft')
    expect(b).toMatch(/const wdIds = withdrawalIdsFromAlertKeys\(/)
    expect(b).toMatch(/if \(!operatorSent\)/)
    expect(b).toMatch(/markWithdrawalsAnnounced\(env\.STATUS_CACHE/)
    // The send's result is actually CAPTURED, not discarded as it is for the other alert kinds.
    // (Asserted against the whole file — inside `b` the anchor makes it tautological.)
    expect(src).toMatch(/const operatorSent = await sendDiscordAlert\(env\.DISCORD_WEBHOOK_URL/)
  })

  it('a REJECTED send leaves the row un-announced and says so — it will never retry', () => {
    const b = block('if (!operatorSent)', 'markWithdrawalsAnnounced')
    expect(b).toMatch(/console\.error/)
    expect(b).toMatch(/never retry/)
  })

  it('derives the stamped ids through the unit-tested extractor, over ALL keys written', () => {
    // Two mutations this catches: an inline filter+slice (a source pin cannot assert the slice
    // OFFSET, and an off-by-one stamps nothing), and gating the ids on the dedup write's `ok` —
    // that write failing means the notice will RE-fire, not that it was never sent.
    const b = block('const wdIds = withdrawalIdsFromAlertKeys(', 'if (!operatorSent)')
    expect(b).toMatch(/withdrawalIdsFromAlertKeys\(keysToWrite\)/)
    expect(b).not.toMatch(/\.ok|filter\(/)
    expect(b).not.toMatch(/alerted:new:|alerted:down:|alerted:res:/)
  })

  it('the stamp is fail-soft — bookkeeping must never abort the alerting around it', () => {
    const b = block('const wdIds = withdrawalIdsFromAlertKeys(', '#936 — send the tweet-reply draft')
    expect(b).toMatch(/try \{[\s\S]*markWithdrawalsAnnounced[\s\S]*\} catch/)
  })

  it('the prune records BEFORE the cron reads the roster, so a row exists for the same-run notice', () => {
    const accumulate = src.indexOf('accumulateIncidentsOnlyIfChanged(env.STATUS_CACHE')
    const stamp = src.indexOf('markWithdrawalsAnnounced(env.STATUS_CACHE')
    expect(accumulate).toBeGreaterThan(-1)
    expect(stamp).toBeGreaterThan(accumulate)
  })
})

// ── The read surface ────────────────────────────────────────────────────────

describe('GET /api/admin/withdrawals', () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
  const envWith = (kv: KVNamespace, adminKey: string | undefined = 'test-admin-key') =>
    ({ ALLOWED_ORIGIN: '*', STATUS_CACHE: kv, ADMIN_API_KEY: adminKey }) as Parameters<typeof workerModule.fetch>[1]
  const get = (qs = '', headers: Record<string, string> = {}) =>
    new Request(`https://example.com/api/admin/withdrawals${qs}`, { method: 'GET', headers })

  it('401s without a matching admin key', async () => {
    const { kv } = makeKV()
    expect((await workerModule.fetch(get('', { 'X-Admin-Key': 'wrong' }), envWith(kv), ctx)).status).toBe(401)
    expect((await workerModule.fetch(get(), envWith(kv), ctx)).status).toBe(401)
  })

  it('401s when no admin key is configured at all', async () => {
    const { kv } = makeKV()
    expect((await workerModule.fetch(get('', { 'X-Admin-Key': 'anything' }), envWith(kv, undefined), ctx)).status).toBe(401)
  })

  it('503s when the KV binding is missing, rather than diagnosing it as an unreadable log', async () => {
    const env = { ALLOWED_ORIGIN: '*', ADMIN_API_KEY: 'test-admin-key' } as Parameters<typeof workerModule.fetch>[1]
    const res = await workerModule.fetch(get('', { 'X-Admin-Key': 'test-admin-key' }), env, ctx)
    expect(res.status).toBe(503)
  })

  it.each(['july', '2026-13', '2026-00', '2026-7', '26-07'])(
    'rejects the malformed month %s rather than reading a key that cannot exist',
    async (month) => {
      // An impossible month would otherwise answer `200 {count: 0}` — a misleading zero on the one
      // endpoint whose contract is never to give one.
      const { kv } = makeKV()
      const res = await workerModule.fetch(get(`?month=${month}`, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)
      expect(res.status).toBe(400)
    },
  )

  it.each(['0', '25', 'many', '1.5'])('rejects months=%s', async (months) => {
    const { kv } = makeKV()
    const res = await workerModule.fetch(get(`?months=${months}`, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)
    expect(res.status).toBe(400)
  })

  it('a months=N lookback aggregates the range, so "did it EVER fire?" is answerable in one call', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T00:00:00Z'))
    const { kv } = makeKV({
      [KEY]: JSON.stringify([row({ incId: 'jul-1', announcedAt: '2026-07-21T09:05:00Z' })]),
      [withdrawalLogKey('2026-05')]: JSON.stringify([row({ incId: 'may-1', prunedAt: '2026-05-02T00:00:00Z' })]),
    })
    const res = await workerModule.fetch(get('?months=3', { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)
    const body = await res.json() as { months: string[]; count: number; withdrawals: Array<{ incId: string }> }
    expect(body.months).toEqual(['2026-07', '2026-06', '2026-05'])
    expect(body.count).toBe(2)
    expect(body.withdrawals.map((r) => r.incId).sort()).toEqual(['jul-1', 'may-1'])
  })

  it('reports a partially-eaten month as partial instead of a confident count', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv } = makeKV({ [KEY]: JSON.stringify([row(), { svcId: 'x' }]) })
    const res = await workerModule.fetch(get('?month=2026-07', { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)
    expect(await res.json()).toMatchObject({ ok: false, partial: true, count: 1, droppedMalformed: 1 })
  })

  it('counts an unageable row apart from pending, so the benign bucket stays honest', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { kv } = makeKV({ [KEY]: JSON.stringify([row({ prunedAt: 'garbage' })]) })
    const res = await workerModule.fetch(get('?month=2026-07', { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)
    expect(await res.json()).toMatchObject({ count: 1, pending: 0, neverClosed: 0, malformedTimestamp: 1 })
  })

  it('the four buckets PARTITION count — an announced row with a bad timestamp is counted once', async () => {
    // Without an ANNOUNCED malformed-timestamp fixture, dropping `!r.announcedAt` from the
    // malformedTimestamp filter is invisible, and the partition equation the docs assert twice
    // silently stops holding.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T00:00:00Z'))
    const { kv } = makeKV({
      [KEY]: JSON.stringify([
        row({ incId: 'weird', prunedAt: 'garbage', announcedAt: '2026-07-21T09:05:00Z' }),
        row({ incId: 'open', prunedAt: 'garbage' }),
        row({ incId: 'lost', prunedAt: '2026-07-21T09:00:00Z' }),
        row({ incId: 'pending', prunedAt: '2026-07-23T23:00:00Z' }),
        row({ incId: 'closed', announcedAt: '2026-07-21T09:05:00Z' }),
      ]),
    })
    const res = await workerModule.fetch(get('?month=2026-07', { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)
    const b = await res.json() as { count: number; announced: number; pending: number; neverClosed: number; malformedTimestamp: number }
    expect(b).toMatchObject({ count: 5, announced: 2, pending: 1, neverClosed: 1, malformedTimestamp: 1 })
    expect(b.announced + b.pending + b.neverClosed + b.malformedTimestamp).toBe(b.count)
  })

  it('returns the rows with a derived neverClosed verdict, split from still-pending', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T00:00:00Z'))
    const { kv } = makeKV({
      [KEY]: JSON.stringify([
        row({ incId: 'closed', announcedAt: '2026-07-21T09:05:00Z' }),
        row({ incId: 'lost', prunedAt: '2026-07-21T09:00:00Z' }),          // >48h ago, never announced
        row({ incId: 'pending', prunedAt: '2026-07-23T23:00:00Z' }),        // still inside the window
      ]),
    })
    const res = await workerModule.fetch(get('?month=2026-07', { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      count: number; announced: number; pending: number; neverClosed: number
      withdrawals: Array<WithdrawalLogEntry & { neverClosed: boolean }>
    }
    expect(body).toMatchObject({ count: 3, announced: 1, pending: 1, neverClosed: 1 })
    expect(body.withdrawals.find((r) => r.incId === 'lost')?.neverClosed).toBe(true)
    expect(body.withdrawals.find((r) => r.incId === 'pending')?.neverClosed).toBe(false)
    expect(body.withdrawals.find((r) => r.incId === 'closed')?.neverClosed).toBe(false)
  })

  it('defaults to the current month', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T00:00:00Z'))
    const { kv } = makeKV({ [KEY]: JSON.stringify([row()]) })
    const res = await workerModule.fetch(get('', { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)
    expect(await res.json()).toMatchObject({ months: ['2026-07'], count: 1 })
  })

  it('?month actually ANCHORS the read — a past month must not answer with the current one', async () => {
    // Without this, dropping the anchor entirely is invisible: every other seeded test happens to use
    // the month that is current at run time. An operator asking about May would get July's answer.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T00:00:00Z'))
    const { kv } = makeKV({
      [KEY]: JSON.stringify([row({ incId: 'jul-1' })]),
      [withdrawalLogKey('2026-05')]: JSON.stringify([row({ incId: 'may-1', prunedAt: '2026-05-02T00:00:00Z' })]),
    })
    const res = await workerModule.fetch(get('?month=2026-05', { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)
    const body = await res.json() as { months: string[]; withdrawals: Array<{ incId: string }> }
    expect(body.months).toEqual(['2026-05'])
    expect(body.withdrawals.map((r) => r.incId)).toEqual(['may-1'])
  })

  it('?month combines with ?months — the requested month is the END of the range', async () => {
    const { kv } = makeKV()
    const res = await workerModule.fetch(get('?month=2026-05&months=3', { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)
    expect(await res.json()).toMatchObject({ months: ['2026-05', '2026-04', '2026-03'] })
  })

  it('supports the maximum 24-month lookback', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T00:00:00Z'))
    const { kv } = makeKV()
    const res = await workerModule.fetch(get('?months=24', { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)
    const body = await res.json() as { months: string[] }
    expect(body.months).toHaveLength(24)
    expect(body.months.at(-1)).toBe('2024-08')
  })

  it('502s when EVERY month in a range is unreadable — never a clean zero for "did it ever fire?"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T00:00:00Z'))
    const { kv } = makeKV({ [KEY]: 'not json', [withdrawalLogKey('2026-06')]: 'also not json' })
    const res = await workerModule.fetch(get('?months=2', { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ ok: false, months: ['2026-07', '2026-06'] })
  })

  it('attributes dropped rows PER MONTH and sums them across the range', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T00:00:00Z'))
    const { kv } = makeKV({
      [KEY]: JSON.stringify([row(), { bad: 1 }]),
      [withdrawalLogKey('2026-06')]: JSON.stringify([{ bad: 1 }, { bad: 2 }]),
    })
    const res = await workerModule.fetch(get('?months=2', { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)
    // Per month, because the remedy is a by-hand repair of ONE key.
    expect(await res.json()).toMatchObject({ malformedByMonth: { '2026-07': 1, '2026-06': 2 }, droppedMalformed: 3, count: 1 })
  })

  it('a partial answer is not ok:true — a caller branching on ok must not trust the counts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T00:00:00Z'))
    const { kv } = makeKV({ [KEY]: JSON.stringify([row()]), [withdrawalLogKey('2026-06')]: 'not json' })
    const res = await workerModule.fetch(get('?months=2', { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: false, partial: true, unreadableMonths: ['2026-06'], count: 1 })
  })

  it('a clean answer is ok:true and not partial', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T00:00:00Z'))
    const { kv } = makeKV({ [KEY]: JSON.stringify([row()]) })
    const res = await workerModule.fetch(get('', { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)
    expect(await res.json()).toMatchObject({ ok: true, partial: false, unreadableMonths: [], droppedMalformed: 0 })
  })

  it('reports an empty month as zero withdrawals', async () => {
    const { kv } = makeKV()
    const res = await workerModule.fetch(get('?month=2026-05', { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, count: 0, withdrawals: [] })
  })

  it('502s on an UNREADABLE log instead of answering zero — the false negative this endpoint exists to remove', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv } = makeKV({ [KEY]: 'not json' })
    const res = await workerModule.fetch(get('?month=2026-07', { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ ok: false })
  })

  it('is read-only — GET is routed, POST is NOT', async () => {
    // Both halves in one test on purpose: `not.toBe(200)` alone also passes for a deleted route, and
    // would pass for a POST handler answering 201 — the "operator falsifies history" mutation.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T00:00:00Z'))
    const { kv } = makeKV()
    expect((await workerModule.fetch(get('', { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)).status).toBe(200)
    const res = await workerModule.fetch(
      new Request('https://example.com/api/admin/withdrawals', { method: 'POST', headers: { 'X-Admin-Key': 'test-admin-key' } }),
      envWith(kv), ctx,
    )
    expect(res.status).toBe(404)
  })
})
