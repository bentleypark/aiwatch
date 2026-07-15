import { describe, it, expect } from 'vitest'
import {
  normalizeOverrides,
  overrideMap,
  applyDurationOverrides,
  mutateOverrides,
  readOverridesFresh,
  type DurationOverride,
} from '../overrides'
import {
  accumulateMonthlyIncidents,
  aggregateIncidentDurations,
  type MonthlyIncidents,
} from '../monthly-archive'
import type { ServiceStatus } from '../types'

// A monthly accumulator holding Cursor's real July shape: the 13h20m paperwork incident + a couple of
// short ones. 799 min = 13h 19m ≈ the observed h71m65my586h open→close span.
function cursorMonthly(): MonthlyIncidents {
  return {
    lastUpdated: '2026-07-15T10:00:00Z',
    services: {
      cursor: {
        count: 3,
        totalMinutes: 799 + 18 + 92,
        longestMinutes: 799,
        dates: ['2026-07-14', '2026-07-06'],
        incidentIds: ['h71m65my586h', '96m8j04k15r5', 'aaa'],
        durations: { h71m65my586h: 799, '96m8j04k15r5': 18, aaa: 92 },
        incidents: [
          { id: 'h71m65my586h', title: 'Investigating service degradation', startedAt: '2026-07-14T19:52:29Z', resolvedAt: '2026-07-15T09:11:48Z', durationMin: 799, finalStatus: 'resolved', impact: 'minor' },
          { id: '96m8j04k15r5', title: 'Investigating service degradation - Sol', startedAt: '2026-07-14T19:55:36Z', resolvedAt: '2026-07-14T20:10:38Z', durationMin: 18, finalStatus: 'resolved', impact: 'minor' },
          { id: 'aaa', title: 'Investigating service degradation', startedAt: '2026-07-06T00:00:00Z', resolvedAt: '2026-07-06T01:32:00Z', durationMin: 92, finalStatus: 'resolved', impact: 'minor' },
        ],
      },
    },
  }
}

describe('normalizeOverrides', () => {
  it('keeps well-formed rows and drops malformed ones', () => {
    const parsed = [
      { id: 'a', durationMin: 18, reason: 'paperwork left open' },
      { id: 'b', durationMin: 0 },                 // 0 is valid (zeroes downtime)
      { id: '', durationMin: 10 },                 // empty id → drop
      { id: 'c', durationMin: -5 },                // negative → drop
      { id: 'd', durationMin: 'nope' },            // non-number → drop
      { id: 'e' },                                 // missing durationMin → drop
      { durationMin: 10 },                         // missing id → drop
      null, 'x', 42,                               // non-objects → drop
    ]
    expect(normalizeOverrides(parsed)).toEqual([
      { id: 'a', durationMin: 18, reason: 'paperwork left open' },
      { id: 'b', durationMin: 0 },
    ])
  })
  it('returns [] for non-array input', () => {
    expect(normalizeOverrides(null)).toEqual([])
    expect(normalizeOverrides({})).toEqual([])
  })
})

describe('overrideMap', () => {
  it('last entry wins on duplicate id', () => {
    const m = overrideMap([{ id: 'a', durationMin: 10 }, { id: 'a', durationMin: 18 }])
    expect(m.get('a')).toBe(18)
  })
})

describe('applyDurationOverrides', () => {
  it('pins the paperwork incident and recomputes total + longest from survivors', () => {
    const out = applyDurationOverrides(cursorMonthly(), [{ id: 'h71m65my586h', durationMin: 18 }])
    const svc = out.services.cursor
    // Incident stays; only its duration is corrected.
    expect(svc.count).toBe(3)
    expect(svc.incidentIds).toContain('h71m65my586h')
    expect(svc.durations.h71m65my586h).toBe(18)
    expect(svc.incidents!.find(e => e.id === 'h71m65my586h')!.durationMin).toBe(18)
    // Aggregates recompute from the durations map: 18 + 18 + 92 = 128, longest now 92 (not 799).
    expect(svc.totalMinutes).toBe(128)
    expect(svc.longestMinutes).toBe(92)
  })

  it('recomputes resolvedAt = startedAt + durationMin so timestamp-derived surfaces agree', () => {
    const out = applyDurationOverrides(cursorMonthly(), [{ id: 'h71m65my586h', durationMin: 18 }])
    const e = out.services.cursor.incidents!.find(x => x.id === 'h71m65my586h')!
    // startedAt 2026-07-14T19:52:29Z + 18 min → 20:10:29Z (was the provider's next-day 09:11:48Z).
    expect(e.resolvedAt).toBe('2026-07-14T20:10:29.000Z')
    // resolvedAt − startedAt now equals the pinned duration.
    expect((Date.parse(e.resolvedAt!) - Date.parse(e.startedAt)) / 60000).toBe(18)
  })

  it('leaves resolvedAt untouched for an unresolved (open) entry — never fabricates a resolution', () => {
    const data = cursorMonthly()
    const open = data.services.cursor.incidents!.find(x => x.id === 'aaa')!
    open.resolvedAt = null
    open.finalStatus = 'monitoring'
    const out = applyDurationOverrides(data, [{ id: 'aaa', durationMin: 5 }])
    const e = out.services.cursor.incidents!.find(x => x.id === 'aaa')!
    expect(e.durationMin).toBe(5)      // duration still pinned
    expect(e.resolvedAt).toBeNull()    // but no synthetic resolution
  })

  it('corrects aggregates when the override id is TRUNCATED out of incidents[] (accumulator fallback)', () => {
    // A busy service caps its detail array (#375) but keeps the full `durations` map, so an override on
    // a truncated id must still correct totalMinutes/longestMinutes (aggregateIncidentDurations then
    // reads the corrected accumulator totals, since incidents.length < count).
    const data: MonthlyIncidents = {
      lastUpdated: '2026-07-15T10:00:00Z',
      services: {
        cursor: {
          count: 2,
          totalMinutes: 799 + 30,
          longestMinutes: 799,
          dates: ['2026-07-14'],
          incidentIds: ['h71m65my586h', 'kept'],
          durations: { h71m65my586h: 799, kept: 30 },
          // detail truncated: only 'kept' survived the cap, 'h71m65my586h' is gone from incidents[]
          incidents: [
            { id: 'kept', title: 'x', startedAt: '2026-07-14T00:00:00Z', resolvedAt: '2026-07-14T00:30:00Z', durationMin: 30, finalStatus: 'resolved', impact: 'minor' },
          ],
        },
      },
    }
    const out = applyDurationOverrides(data, [{ id: 'h71m65my586h', durationMin: 18 }])
    const svc = out.services.cursor
    expect(svc.durations.h71m65my586h).toBe(18)
    expect(svc.totalMinutes).toBe(48)     // 18 + 30
    expect(svc.longestMinutes).toBe(30)   // no longer 799
    const agg = aggregateIncidentDurations(svc.incidents, svc.count, svc.totalMinutes, svc.longestMinutes)
    expect(agg.longestMin).toBe(30)       // truncated → falls back to the corrected accumulator total
    expect(agg.totalMin).toBe(48)
  })

  it('flows through aggregateIncidentDurations (#915) — report longest/total corrected', () => {
    const out = applyDurationOverrides(cursorMonthly(), [{ id: 'h71m65my586h', durationMin: 18 }])
    const svc = out.services.cursor
    const agg = aggregateIncidentDurations(svc.incidents, svc.count, svc.totalMinutes, svc.longestMinutes)
    expect(agg.longestMin).toBe(92)   // was 799 before the override
    expect(agg.totalMin).toBe(128)
  })

  it('is identity when no id matches or the list is empty', () => {
    const data = cursorMonthly()
    expect(applyDurationOverrides(data, [])).toBe(data)
    expect(applyDurationOverrides(data, [{ id: 'not-here', durationMin: 5 }])).toBe(data)
  })

  it('returns structurally-corrupt input as-is (no throw)', () => {
    const bad = { lastUpdated: 'x' } as unknown as MonthlyIncidents
    expect(applyDurationOverrides(bad, [{ id: 'a', durationMin: 1 }])).toBe(bad)
  })

  it('REGRESSION: survives a re-accumulation cycle that would re-inflate a raw KV edit', () => {
    // The monotonic guard in accumulateMonthlyIncidents (`if (dur > oldDur)`) re-inflates any lowered
    // stored duration back to the provider value while the incident is still in the live feed. The
    // override is applied AFTER accumulation, so it wins regardless of what the accumulator holds.
    const stored = cursorMonthly()
    // Simulate the next cron re-seeing the still-live 799-min incident.
    const liveSvc: ServiceStatus = {
      id: 'cursor', name: 'Cursor', provider: 'Anysphere', category: 'agent',
      status: 'operational', uptime: null, uptime30d: null, latency: null,
      incidents: [{ id: 'h71m65my586h', title: 'Investigating service degradation', status: 'resolved', impact: 'minor', startedAt: '2026-07-14T19:52:29Z', resolvedAt: '2026-07-15T09:11:48Z', duration: '13h 19m', timeline: [] }],
    } as unknown as ServiceStatus
    const reAccumulated = accumulateMonthlyIncidents(stored, [liveSvc], '2026-07', [])
    expect(reAccumulated.services.cursor.durations.h71m65my586h).toBe(799) // guard re-inflated
    // Applying the override on read/build corrects it back down.
    const corrected = applyDurationOverrides(reAccumulated, [{ id: 'h71m65my586h', durationMin: 18 }])
    expect(corrected.services.cursor.durations.h71m65my586h).toBe(18)
    expect(corrected.services.cursor.longestMinutes).toBe(92)
  })
})

describe('mutateOverrides', () => {
  const base: DurationOverride[] = [{ id: 'a', durationMin: 10 }]
  it('add appends a new id', () => {
    const r = mutateOverrides(base, { action: 'add', id: 'b', durationMin: 18, reason: 'x' })
    expect(r.ok && r.changed).toBe(true)
    expect(r.ok && r.list).toEqual([{ id: 'a', durationMin: 10 }, { id: 'b', durationMin: 18, reason: 'x' }])
  })
  it('re-adding an id UPDATES its duration (a correction, not idempotent)', () => {
    const r = mutateOverrides(base, { action: 'add', id: 'a', durationMin: 18 })
    expect(r.ok && r.changed).toBe(true)
    expect(r.ok && r.list).toEqual([{ id: 'a', durationMin: 18 }])
  })
  it('re-adding the SAME value is a no-op change', () => {
    const r = mutateOverrides(base, { action: 'add', id: 'a', durationMin: 10 })
    expect(r.ok && r.changed).toBe(false)
  })
  it('remove drops the id', () => {
    const r = mutateOverrides(base, { action: 'remove', id: 'a' })
    expect(r.ok && r.changed).toBe(true)
    expect(r.ok && r.list).toEqual([])
  })
  it('rejects a missing id and an invalid durationMin', () => {
    expect(mutateOverrides(base, { action: 'add', durationMin: 5 }).ok).toBe(false)
    expect(mutateOverrides(base, { action: 'add', id: 'z', durationMin: -1 }).ok).toBe(false)
    expect(mutateOverrides(base, { action: 'add', id: 'z' }).ok).toBe(false)
  })
})

describe('readOverridesFresh', () => {
  const kvOf = (val: string | null, throwOn = false): KVNamespace =>
    ({ get: async () => { if (throwOn) throw new Error('kv down'); return val } }) as unknown as KVNamespace

  it('parses a stored list', async () => {
    const kv = kvOf(JSON.stringify([{ id: 'a', durationMin: 18 }, { id: 'bad' }]))
    expect(await readOverridesFresh(kv)).toEqual([{ id: 'a', durationMin: 18 }])
  })
  it('returns [] for absent kv / empty key / read error / bad JSON', async () => {
    expect(await readOverridesFresh(undefined)).toEqual([])
    expect(await readOverridesFresh(kvOf(null))).toEqual([])
    expect(await readOverridesFresh(kvOf('not json'))).toEqual([])
    expect(await readOverridesFresh(kvOf(null, true))).toEqual([])
  })
})
