import { describe, it, expect, vi } from 'vitest'
import workerModule from '../index'
import { applyDurationOverrides, applyDurationOverridesCounted, noOverridesApplied, findOverrideId, recentAccumulatorMonths, type DurationOverride } from '../overrides'
import type { MonthlyIncidents } from '../monthly-archive'

const svc = (ids: string[]) => ({
  count: ids.length, totalMinutes: 0, longestMinutes: 0, dates: [], incidentIds: ids,
  durations: Object.fromEntries(ids.map((id) => [id, 800])), incidents: [],
})
const DATA: MonthlyIncidents = { lastUpdated: '', services: { cursor: svc(['A', 'B']), claude: svc(['C']) } }
const o = (id: string): DurationOverride => ({ id, durationMin: 18 })
const matches = (data: MonthlyIncidents | null, list: DurationOverride[]) => applyDurationOverridesCounted(data as MonthlyIncidents, list).matches

describe('applyDurationOverridesCounted', () => {
  it('splits the listed ids into those the data names and those it does not', () => {
    expect(matches(DATA, [o('A'), o('typo'), o('C')])).toEqual({ matched: ['A', 'C'], unmatched: ['typo'] })
  })

  it('names an id once however many times it is listed', () => {
    expect(matches(DATA, [o('A'), o('A'), o('typo'), o('typo')])).toEqual({ matched: ['A'], unmatched: ['typo'] })
  })

  it('matches nothing in absent data', () => {
    expect(matches(null, [o('A')])).toEqual({ matched: [], unmatched: ['A'] })
    expect(matches(null, [])).toEqual({ matched: [], unmatched: [] })
  })

  it('counts an id as applied exactly when the data it returns carries the pinned value', () => {
    const data: MonthlyIncidents = {
      ...DATA,
      services: {
        ...DATA.services,
        listedOnly: { ...svc(['G']), durations: {} },
        timedOnly: { ...svc([]), durations: { X: 800 } },
        rowOnly: { ...svc(['H']), durations: {}, incidents: [{ id: 'H', title: 't', startedAt: '2026-10-01T00:00:00Z', resolvedAt: null, durationMin: 800, finalStatus: 'resolved', impact: 'minor' }] },
      },
    }
    for (const id of ['A', 'B', 'C', 'G', 'H', 'X', 'typo']) {
      const out = applyDurationOverridesCounted(data, [{ id, durationMin: 18 }])
      const pinned = Object.values(out.data.services).some((s) => s.durations?.[id] === 18 || s.incidents?.some((e) => e.id === id && e.durationMin === 18))
      expect(out.matches.matched.length > 0, id).toBe(pinned)
    }
  })

  it('returns the same data as applyDurationOverrides', () => {
    expect(applyDurationOverridesCounted(DATA, [o('A')]).data).toEqual(applyDurationOverrides(DATA, [o('A')]))
    expect(applyDurationOverridesCounted(DATA, [o('typo')]).data).toBe(DATA)
  })

  it('lists every id as unapplied when nothing was applied', () => {
    expect(noOverridesApplied([o('A'), o('A'), o('B')])).toEqual({ matched: [], unmatched: ['A', 'B'] })
  })
})

describe('recentAccumulatorMonths', () => {
  it('is the current month and the two before it, newest first', () => {
    expect(recentAccumulatorMonths(new Date(Date.UTC(2026, 10, 1)))).toEqual(['2026-11', '2026-10', '2026-09'])
  })

  it('crosses the year', () => {
    expect(recentAccumulatorMonths(new Date(Date.UTC(2026, 0, 15)))).toEqual(['2026-01', '2025-12', '2025-11'])
  })
})

describe('findOverrideId', () => {
  const NOW = new Date(Date.UTC(2026, 10, 1))
  const kvOf = (store: Record<string, string>, failKey?: string) => ({
    get: async (k: string) => { if (k === failKey) throw new Error('kv down'); return store[k] ?? null },
  }) as unknown as Pick<KVNamespace, 'get'>

  it('lists the months whose accumulator names the id, and the months it searched', async () => {
    const kv = kvOf({ 'incidents:monthly:2026-10': JSON.stringify(DATA) })
    expect(await findOverrideId(kv, 'A', NOW)).toEqual({ searched: ['2026-11', '2026-10', '2026-09'], months: ['2026-10'] })
  })

  it('finds an id that is in no recent accumulator as none, not as unknown', async () => {
    expect(await findOverrideId(kvOf({ 'incidents:monthly:2026-10': JSON.stringify(DATA) }), 'typo', NOW)).toEqual({ searched: ['2026-11', '2026-10', '2026-09'], months: [] })
  })

  it('is unknown when a read throws', async () => {
    expect(await findOverrideId(kvOf({}, 'incidents:monthly:2026-10'), 'A', NOW)).toBeNull()
  })

  it('is unknown when an accumulator does not parse', async () => {
    expect(await findOverrideId(kvOf({ 'incidents:monthly:2026-10': '{ not json' }), 'A', NOW)).toBeNull()
  })
})

describe('POST /api/admin/duration-override tells the operator whether the id matches anything', () => {
  const thisMonth = recentAccumulatorMonths(new Date())[0]
  function makeKV(initial: Record<string, string> = {}, failKey?: string) {
    const store = { ...initial }
    return {
      store,
      kv: {
        get: vi.fn(async (k: string) => { if (k === failKey) throw new Error('kv down'); return store[k] ?? null }),
        put: vi.fn(async (k: string, v: string) => { store[k] = v }),
        delete: vi.fn(async () => {}),
        list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
      } as unknown as KVNamespace,
    }
  }
  const post = async (kv: KVNamespace, body: unknown) => {
    const res = await workerModule.fetch(
      new Request('https://example.com/api/admin/duration-override', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'k' }, body: JSON.stringify(body) }),
      { ALLOWED_ORIGIN: '*', STATUS_CACHE: kv, ADMIN_API_KEY: 'k' } as Parameters<typeof workerModule.fetch>[1],
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
    )
    return { status: res.status, body: await res.json() as Record<string, any> }
  }
  const seeded = () => ({ [`incidents:monthly:${thisMonth}`]: JSON.stringify(DATA) })

  it('says matched, and in which month, for an id the accumulator holds', async () => {
    const { kv } = makeKV(seeded())
    const { status, body } = await post(kv, { action: 'add', id: 'A', durationMin: 18 })
    expect(status).toBe(200)
    expect(body.match).toMatchObject({ matched: true, months: [thisMonth] })
    expect(body.match.searched).toHaveLength(3)
  })

  it('says not matched for a mistyped id, and still stores it: no refusal', async () => {
    const { kv, store } = makeKV(seeded())
    const { status, body } = await post(kv, { action: 'add', id: 'Atypo', durationMin: 18 })
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, changed: true, match: { matched: false, months: [] } })
    expect(JSON.parse(store['incident:duration-overrides'])).toMatchObject([{ id: 'Atypo', durationMin: 18 }])
  })

  it('says unknown, not unmatched, when an accumulator cannot be read, and still stores it', async () => {
    const { kv, store } = makeKV(seeded(), `incidents:monthly:${thisMonth}`)
    const { status, body } = await post(kv, { action: 'add', id: 'A', durationMin: 18 })
    expect(status).toBe(200)
    expect(body.match).toEqual({ matched: null })
    expect(JSON.parse(store['incident:duration-overrides'])).toHaveLength(1)
  })

  it('reports it again when the same id is added again with nothing changed', async () => {
    const { kv } = makeKV({ ...seeded(), 'incident:duration-overrides': JSON.stringify([{ id: 'A', durationMin: 18 }]) })
    const { body } = await post(kv, { action: 'add', id: 'A', durationMin: 18 })
    expect(body).toMatchObject({ changed: false, match: { matched: true } })
  })

  it('has no match for a removal', async () => {
    const { kv } = makeKV({ ...seeded(), 'incident:duration-overrides': JSON.stringify([{ id: 'A', durationMin: 18 }]) })
    const { body } = await post(kv, { action: 'remove', id: 'A' })
    expect(body).not.toHaveProperty('match')
  })
})
