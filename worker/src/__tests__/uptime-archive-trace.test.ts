import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ARCHIVE_RESTORE_TRACE_KEY,
  foldRestoreObservations,
  recordRestoreObservations,
  type ArchiveRestoreTrace,
} from '../uptime-archive-trace'
import { isArchiveRestoreEligible } from '../uptime-archive'

const NOW = '2026-09-14T07:30:00.000Z'
const TODAY = '2026-09-14'

/** Key-AWARE on purpose: a fake whose `get` ignores its argument cannot catch a read key that has
 *  drifted from the write key, which is the #1256-shaped destruction this module exists to prevent
 *  (every read returns null -> every write replaces the whole permanent trace). */
function fakeKV(initial: string | null = null) {
  const store = new Map<string, string>()
  if (initial !== null) store.set(ARCHIVE_RESTORE_TRACE_KEY, initial)
  const get = vi.fn(async (k: string) => store.get(k) ?? null)
  const put = vi.fn(async (k: string, v: string, _opts?: KVNamespacePutOptions) => { store.set(k, v) })
  return { kv: { get, put } as unknown as KVNamespace, get, put, read: () => store.get(ARCHIVE_RESTORE_TRACE_KEY) ?? null }
}

/** The trace's only consumer is a human reading `wrangler kv key get`, so assertions are on the
 *  stored JSON, not on an intermediate. */
function storedTrace(put: ReturnType<typeof fakeKV>['put']): ArchiveRestoreTrace {
  return JSON.parse(put.mock.calls[0][1] as string)
}

describe('#1017 follow-up — isArchiveRestoreEligible (the ONE gate, shared with the trace)', () => {
  it('is eligible only when the live window is strictly narrower than the calendar', () => {
    expect(isArchiveRestoreEligible(30, 14)).toBe(true)
    expect(isArchiveRestoreEligible(30, 29)).toBe(true)
  })

  it('is NOT eligible when uptimeWindowDays is absent', () => {
    expect(isArchiveRestoreEligible(30, undefined)).toBe(false)
  })

  it('is NOT eligible when the window equals or exceeds the calendar (nothing to fill)', () => {
    expect(isArchiveRestoreEligible(30, 30)).toBe(false)
    expect(isArchiveRestoreEligible(30, 90)).toBe(false)
  })
})

describe('#1017 follow-up — foldRestoreObservations', () => {
  it('records an ELIGIBLE-but-nothing-restored service distinctly from a restoring one', () => {
    // This is the exact state langsmith sat in for weeks (short window, but every archived day
    // weightedOutageSec:0). The 2026-08-25 investigation existed because nothing recorded it.
    const next = foldRestoreObservations({}, [{ serviceId: 'langsmith', uptimeWindowDays: 14, daysRestored: 0, failed: false }], NOW)
    expect(next).toEqual({
      langsmith: {
        firstEligibleAt: NOW,
        firstRestoredAt: null,
        lastObservedDate: TODAY,
        lastRestoredDate: null,
        lastRestoreErrorDate: null,
        maxDaysRestored: 0,
        uptimeWindowDays: 14,
      },
    })
  })

  it('stamps firstRestoredAt and lastRestoredDate on the first cycle that actually merges days', () => {
    const next = foldRestoreObservations({}, [{ serviceId: 'junie', uptimeWindowDays: 6, daysRestored: 3, failed: false }], NOW)
    expect(next!.junie.firstRestoredAt).toBe(NOW)
    expect(next!.junie.lastRestoredDate).toBe(TODAY)
    expect(next!.junie.maxDaysRestored).toBe(3)
  })

  it('promotes a previously eligible-only service to restored without losing firstEligibleAt', () => {
    const prev: ArchiveRestoreTrace = {
      langsmith: { firstEligibleAt: '2026-08-01T00:00:00.000Z', firstRestoredAt: null, lastObservedDate: '2026-09-01', lastRestoredDate: null, lastRestoreErrorDate: null, maxDaysRestored: 0, uptimeWindowDays: 14 },
    }
    const next = foldRestoreObservations(prev, [{ serviceId: 'langsmith', uptimeWindowDays: 14, daysRestored: 2, failed: false }], NOW)
    expect(next!.langsmith.firstEligibleAt).toBe('2026-08-01T00:00:00.000Z')
    expect(next!.langsmith.firstRestoredAt).toBe(NOW)
  })

  it('keeps maxDaysRestored as a high-water mark when a later cycle restores fewer days', () => {
    // The gap shrinks as the live window catches up, so the latest count understates the path.
    const prev: ArchiveRestoreTrace = {
      junie: { firstEligibleAt: '2026-09-01T00:00:00.000Z', firstRestoredAt: '2026-09-01T00:00:00.000Z', lastObservedDate: '2026-09-01', lastRestoredDate: '2026-09-01', lastRestoreErrorDate: null, maxDaysRestored: 9, uptimeWindowDays: 6 },
    }
    const next = foldRestoreObservations(prev, [{ serviceId: 'junie', uptimeWindowDays: 6, daysRestored: 2, failed: false }], NOW)
    expect(next!.junie.maxDaysRestored).toBe(9)
    expect(next!.junie.lastRestoredDate).toBe(TODAY)
  })

  it('preserves lastRestoredDate when a later cycle is eligible but restores nothing', () => {
    const prev: ArchiveRestoreTrace = {
      junie: { firstEligibleAt: '2026-09-01T00:00:00.000Z', firstRestoredAt: '2026-09-01T00:00:00.000Z', lastObservedDate: '2026-09-01', lastRestoredDate: '2026-09-01', lastRestoreErrorDate: null, maxDaysRestored: 9, uptimeWindowDays: 6 },
    }
    const next = foldRestoreObservations(prev, [{ serviceId: 'junie', uptimeWindowDays: 6, daysRestored: 0, failed: false }], NOW)
    expect(next!.junie.lastRestoredDate).toBe('2026-09-01') // carried, not cleared
    expect(next!.junie.firstRestoredAt).toBe('2026-09-01T00:00:00.000Z')
  })

  it('returns null when every observation is already recorded (this is the write bound)', () => {
    const prev: ArchiveRestoreTrace = {
      junie: { firstEligibleAt: '2026-09-01T00:00:00.000Z', firstRestoredAt: '2026-09-01T00:00:00.000Z', lastObservedDate: TODAY, lastRestoredDate: TODAY, lastRestoreErrorDate: null, maxDaysRestored: 4, uptimeWindowDays: 6 },
    }
    expect(foldRestoreObservations(prev, [{ serviceId: 'junie', uptimeWindowDays: 6, daysRestored: 4, failed: false }], NOW)).toBeNull()
  })

  it('leaves an unrelated service\'s record untouched', () => {
    const prev: ArchiveRestoreTrace = {
      old: { firstEligibleAt: '2026-01-01T00:00:00.000Z', firstRestoredAt: null, lastObservedDate: '2026-09-01', lastRestoredDate: null, lastRestoreErrorDate: null, maxDaysRestored: 0, uptimeWindowDays: 3 },
    }
    const next = foldRestoreObservations(prev, [{ serviceId: 'new', uptimeWindowDays: 5, daysRestored: 1, failed: false }], NOW)
    expect(next!.old).toEqual(prev.old)
  })

  it('keeps uptimeWindowDays as a LOW-water mark — a widening window must not overwrite it', () => {
    // After a migration the window widens daily and eligibility only ends at >= calendarDays, so
    // last-write-wins would always end up storing calendarDays-1 — the widest, least informative
    // window the service ever had, and the opposite of what the field is for.
    const prev: ArchiveRestoreTrace = {
      junie: { firstEligibleAt: '2026-09-01T00:00:00.000Z', firstRestoredAt: null, lastObservedDate: '2026-09-01', lastRestoredDate: null, lastRestoreErrorDate: null, maxDaysRestored: 0, uptimeWindowDays: 6 },
    }
    const next = foldRestoreObservations(prev, [{ serviceId: 'junie', uptimeWindowDays: 11, daysRestored: 0, failed: false }], NOW)
    expect(next!.junie.uptimeWindowDays).toBe(6)
  })

  it('lowers uptimeWindowDays when the window is observed narrower than before', () => {
    const prev: ArchiveRestoreTrace = {
      junie: { firstEligibleAt: '2026-09-01T00:00:00.000Z', firstRestoredAt: null, lastObservedDate: '2026-09-01', lastRestoredDate: null, lastRestoreErrorDate: null, maxDaysRestored: 0, uptimeWindowDays: 11 },
    }
    const next = foldRestoreObservations(prev, [{ serviceId: 'junie', uptimeWindowDays: 6, daysRestored: 0, failed: false }], NOW)
    expect(next!.junie.uptimeWindowDays).toBe(6)
  })

  it('accumulates two observations for the SAME service in one batch (no lost high-water mark)', () => {
    const next = foldRestoreObservations({}, [
      { serviceId: 'junie', uptimeWindowDays: 6, daysRestored: 5, failed: false },
      { serviceId: 'junie', uptimeWindowDays: 6, daysRestored: 0, failed: false },
    ], NOW)
    expect(next!.junie.maxDaysRestored).toBe(5)
  })

  it('folds several services in one call', () => {
    const next = foldRestoreObservations({}, [
      { serviceId: 'a', uptimeWindowDays: 6, daysRestored: 1, failed: false },
      { serviceId: 'b', uptimeWindowDays: 9, daysRestored: 2, failed: false },
    ], NOW)
    expect(Object.keys(next!).sort()).toEqual(['a', 'b'])
  })

  it('preserves an unknown field written by a newer worker (deploy -> rollback safety)', () => {
    const prev = {
      junie: { firstEligibleAt: '2026-09-01T00:00:00.000Z', firstRestoredAt: null, lastRestoredDate: null, maxDaysRestored: 0, uptimeWindowDays: 6, futureField: 'keepme' },
    } as unknown as ArchiveRestoreTrace
    const next = foldRestoreObservations(prev, [{ serviceId: 'junie', uptimeWindowDays: 6, daysRestored: 3, failed: false }], NOW)
    expect((next!.junie as unknown as Record<string, unknown>).futureField).toBe('keepme')
  })
})

describe('#1017 follow-up — recordRestoreObservations at the kv.put boundary', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('costs neither a read nor a write on the common path (nothing eligible)', async () => {
    const { kv, get, put } = fakeKV('{}')
    await recordRestoreObservations(kv, [], NOW)
    expect(get).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it('writes the first record when the key is genuinely ABSENT (a successful read of nothing)', async () => {
    const { kv, put, get } = fakeKV(null)
    await recordRestoreObservations(kv, [{ serviceId: 'junie', uptimeWindowDays: 6, daysRestored: 2, failed: false }], NOW)
    expect(put).toHaveBeenCalledTimes(1)
    // The literal, not the constant — `toBe(ARCHIVE_RESTORE_TRACE_KEY)` would be a tautology, and this
    // key's entire product is being findable years later by a human running the documented command.
    expect(put.mock.calls[0][0]).toBe('uptime-archive:restored')
    expect(get).toHaveBeenCalledWith('uptime-archive:restored')
    expect(storedTrace(put).junie.maxDaysRestored).toBe(2)
  })

  it('writes with NO expirationTtl — the value must outlive any future check', async () => {
    // A migration may be a year away; a TTL would silently make the trace undecidable exactly the
    // way #1179's 7h/24h keys did on 2026-08-05.
    const { kv, put } = fakeKV(null)
    await recordRestoreObservations(kv, [{ serviceId: 'junie', uptimeWindowDays: 6, daysRestored: 1, failed: false }], NOW)
    expect(put.mock.calls[0][2]).toBeUndefined()
  })

  it('merges into an existing trace rather than replacing it', async () => {
    const prior = JSON.stringify({
      old: { firstEligibleAt: '2026-01-01T00:00:00.000Z', firstRestoredAt: null, lastObservedDate: '2026-09-01', lastRestoredDate: null, lastRestoreErrorDate: null, maxDaysRestored: 0, uptimeWindowDays: 3 },
    })
    const { kv, put } = fakeKV(prior)
    await recordRestoreObservations(kv, [{ serviceId: 'junie', uptimeWindowDays: 6, daysRestored: 1, failed: false }], NOW)
    const stored = storedTrace(put)
    expect(Object.keys(stored).sort()).toEqual(['junie', 'old'])
  })

  it('skips the write when nothing changed', async () => {
    const prior = JSON.stringify({
      junie: { firstEligibleAt: '2026-09-01T00:00:00.000Z', firstRestoredAt: '2026-09-01T00:00:00.000Z', lastObservedDate: TODAY, lastRestoredDate: TODAY, lastRestoreErrorDate: null, maxDaysRestored: 4, uptimeWindowDays: 6 },
    })
    const { kv, put } = fakeKV(prior)
    await recordRestoreObservations(kv, [{ serviceId: 'junie', uptimeWindowDays: 6, daysRestored: 4, failed: false }], NOW)
    expect(put).not.toHaveBeenCalled()
  })

  // #1256 — its own correction: of the four states that reached the destructive write, THREE parsed
  // successfully. Parseability is not the test, and neither is the container's type.
  // `['a zero-byte value', '']` and `['a JSON-encoded empty string', '""']` exercise DIFFERENT arms,
  // so both are needed: relaxing `raw === null` to `!raw` — the most likely future refactor of that
  // line — would read a zero-byte value as "key absent" and wipe the trace.
  it.each([
    ['null', 'null'],
    ['a zero-byte value', ''],
    ['a JSON-encoded empty string', '""'],
    ['an array', '[]'],
    ['a number', '0'],
    ['an empty object (no legitimate write produces one)', '{}'],
    ['unparseable JSON', '{not json'],
  ])('FAIL-CLOSED: refuses to overwrite when the stored value is %s', async (_label, raw) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv, put, read } = fakeKV(raw)
    const before = read()
    await recordRestoreObservations(kv, [{ serviceId: 'junie', uptimeWindowDays: 6, daysRestored: 2, failed: false }], NOW)
    expect(put).not.toHaveBeenCalled()
    expect(read()).toBe(before) // the stored value is untouched, not merely un-put
    // The message must name the remedy — a wedge needs an operator, unlike a failed put.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('is WEDGED'), expect.anything())
    // The offending value must actually be PRINTED — `expect.anything()` alone passes on an empty
    // string, and the prescribed remedy permanently destroys whatever is there.
    const payloads = errorSpy.mock.calls.map((c) => String(c[1]))
    expect(payloads.some((v) => v.length > 0)).toBe(true)
    if (raw !== '') expect(payloads.some((v) => v === raw || v === '<unreadable>')).toBe(true)
    // The remedy destroys the only durable record there is, so it must be exact AND the operator must
    // be shown what they are about to destroy.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('wrangler kv key delete "uptime-archive:restored" --config worker/wrangler.toml --binding STATUS_CACHE --remote'),
      expect.anything(),
    )
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('CAPTURES it'), expect.anything())
  })

  it('FAIL-CLOSED: refuses to overwrite when the read itself throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const put = vi.fn()
    const kv = { get: vi.fn(async () => { throw new Error('KV unavailable') }), put } as unknown as KVNamespace
    await recordRestoreObservations(kv, [{ serviceId: 'junie', uptimeWindowDays: 6, daysRestored: 2, failed: false }], NOW)
    expect(put).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('is WEDGED'), expect.anything())
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('KV unavailable'), expect.anything())
  })

  it('never throws out of a failed write, and reports it as TRANSIENT rather than a wedge', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const kv = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => { throw new Error('KV write limit') }),
    } as unknown as KVNamespace
    await expect(recordRestoreObservations(kv, [{ serviceId: 'junie', uptimeWindowDays: 6, daysRestored: 1, failed: false }], NOW)).resolves.toBeUndefined()
    // An operator on `wrangler tail` must be able to tell "ignore, it retries" from "this instrument
    // is dead until you intervene". Same severity, opposite remedies.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('transient'), expect.anything())
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('is WEDGED'))
  })

  it.each([
    ['a non-string firstEligibleAt', { firstEligibleAt: 12345 }, 'firstEligibleAt'],
    ['a non-string firstRestoredAt', { firstRestoredAt: 42 }, 'firstRestoredAt'],
    ['a non-string lastRestoredDate', { lastRestoredDate: [] }, 'lastRestoredDate'],
    ['a non-numeric maxDaysRestored', { maxDaysRestored: 'nine' }, 'maxDaysRestored'],
    ['a non-numeric uptimeWindowDays', { uptimeWindowDays: 'six' }, 'uptimeWindowDays'],
  ])('COERCES %s back to a sane value instead of propagating or freezing', async (_label, corrupt, field) => {
    // Every one of these previously flowed straight through. `Math.max('nine', 2)` and
    // `Math.min('six', 14)` are both NaN, which JSON.stringify writes as `null` — permanently
    // corrupting a no-TTL key. And a healthy sibling must keep being recorded regardless.
    const prior = JSON.stringify({
      bad: { firstEligibleAt: 'x', firstRestoredAt: null, lastObservedDate: '2026-09-01', lastRestoredDate: null, lastRestoreErrorDate: null, maxDaysRestored: 0, uptimeWindowDays: 6, ...corrupt },
      healthy: { firstEligibleAt: 'y', firstRestoredAt: null, lastObservedDate: '2026-09-01', lastRestoredDate: null, lastRestoreErrorDate: null, maxDaysRestored: 0, uptimeWindowDays: 6 },
    })
    const { kv, put } = fakeKV(prior)
    await recordRestoreObservations(kv, [
      { serviceId: 'bad', uptimeWindowDays: 6, daysRestored: 2, failed: false },
      { serviceId: 'healthy', uptimeWindowDays: 6, daysRestored: 3, failed: false },
    ], NOW)
    const stored = storedTrace(put)
    expect(field).toBeTruthy() // the corrupted field is named per-row for failure legibility
    expect(stored.bad).toEqual(expect.objectContaining({
      firstEligibleAt: expect.any(String),
      lastObservedDate: expect.any(String),
      maxDaysRestored: expect.any(Number),
      uptimeWindowDays: expect.any(Number),
    }))
    for (const k of ['firstRestoredAt', 'lastRestoredDate', 'lastRestoreErrorDate'] as const) {
      expect(stored.bad[k] === null || typeof stored.bad[k] === 'string').toBe(true)
    }
    expect(Number.isFinite(stored.bad.maxDaysRestored)).toBe(true)
    expect(Number.isFinite(stored.bad.uptimeWindowDays)).toBe(true)
    // The blast radius of one bad record must never be the whole key.
    expect(stored.healthy.maxDaysRestored).toBe(3)
  })

  it('distinguishes a FAILED restore from a clean archive — both leave daysRestored 0', () => {
    const clean = foldRestoreObservations({}, [{ serviceId: 'a', uptimeWindowDays: 6, daysRestored: 0, failed: false }], NOW)
    const broken = foldRestoreObservations({}, [{ serviceId: 'a', uptimeWindowDays: 6, daysRestored: 0, failed: true }], NOW)
    expect(clean!.a.lastRestoreErrorDate).toBeNull()
    expect(broken!.a.lastRestoreErrorDate).toBe(TODAY)
    expect(JSON.stringify(clean)).not.toBe(JSON.stringify(broken))
  })

  it('stamps lastObservedDate every eligible cycle, so a stalled instrument is visible', () => {
    const prev = foldRestoreObservations({}, [{ serviceId: 'a', uptimeWindowDays: 6, daysRestored: 0, failed: false }], '2026-09-14T07:00:00.000Z')!
    const next = foldRestoreObservations(prev, [{ serviceId: 'a', uptimeWindowDays: 6, daysRestored: 0, failed: false }], '2026-09-15T07:00:00.000Z')
    expect(next!.a.lastObservedDate).toBe('2026-09-15')
  })

  it('folds an UPDATE onto an already-recorded service across two cycles at the kv boundary', async () => {
    // Every update transition (day rollover, eligible->restored promotion, rising high-water mark)
    // was previously pure-fold-only: each boundary test had an absent, disjoint, or unchanged prior.
    const { kv, put, read } = fakeKV(null)
    await recordRestoreObservations(kv, [{ serviceId: 'junie', uptimeWindowDays: 6, daysRestored: 0, failed: false }], '2026-09-14T07:00:00.000Z')
    expect(JSON.parse(read()!).junie.firstRestoredAt).toBeNull()

    await recordRestoreObservations(kv, [{ serviceId: 'junie', uptimeWindowDays: 6, daysRestored: 4, failed: false }], '2026-09-15T07:00:00.000Z')

    expect(put).toHaveBeenCalledTimes(2)
    const after = JSON.parse(read()!).junie
    expect(after.firstEligibleAt).toBe('2026-09-14T07:00:00.000Z') // set once, not rewritten
    expect(after.firstRestoredAt).toBe('2026-09-15T07:00:00.000Z') // promoted
    expect(after.lastRestoredDate).toBe('2026-09-15')              // rolled over
    expect(after.maxDaysRestored).toBe(4)                          // raised
  })
})
