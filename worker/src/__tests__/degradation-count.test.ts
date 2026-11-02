import { describe, it, expect } from 'vitest'
import { recordDegradation } from '../degradation-count'
import { DEGRADATION_DEDUP_TTL_SEC, type ProbeSpike } from '../probe'

function makeKV() {
  const store = new Map<string, string>()
  const ttl = new Map<string, number | undefined>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, opts?: { expirationTtl?: number }) => { store.set(k, v); ttl.set(k, opts?.expirationTtl) },
    delete: async (k: string) => { store.delete(k) },
    store,
    ttl,
  }
}

const spike = (serviceId = 'deepgram', since = '2026-10-30T13:05:00.000Z'): ProbeSpike => ({
  serviceId, consecutiveCount: 3, avgRtt: 0, medianRtt: 200, threshold: 600, since, failedCount: 3,
})

const NOW = new Date('2026-10-30T13:15:00.000Z')
const DAILY = 'probe-degradation:daily:deepgram:2026-10-30'
const NOSTATUS = 'probe-degradation:nostatus:daily:deepgram:2026-10-30'
const MONTHLY = 'probe-degradation:monthly:2026-10'
const DEDUP = 'alerted:probe-spike:deepgram'

const monthly = (kv: ReturnType<typeof makeKV>) => JSON.parse(kv.store.get(MONTHLY) ?? 'null')

describe('recordDegradation (#1896)', () => {
  it('counts a run once and writes the dedup key with the hourly TTL', async () => {
    const kv = makeKV()
    expect(await recordDegradation(kv, spike(), 'operational', NOW)).toBe(true)
    expect(kv.store.get(DAILY)).toBe('1')
    expect(kv.store.get(DEDUP)).toBe('1')
    expect(kv.ttl.get(DEDUP)).toBe(DEGRADATION_DEDUP_TTL_SEC)
    expect(DEGRADATION_DEDUP_TTL_SEC).toBe(3600)
    expect(monthly(kv).byService).toEqual({ deepgram: 1 })
    expect(monthly(kv).events).toHaveLength(1)
  })

  it('does not count the same service again while the dedup key is live', async () => {
    const kv = makeKV()
    await recordDegradation(kv, spike(), 'operational', NOW)
    expect(await recordDegradation(kv, spike(), 'operational', new Date('2026-10-30T13:20:00.000Z'))).toBe(false)
    expect(kv.store.get(DAILY)).toBe('1')
    expect(kv.store.get(NOSTATUS)).toBe('1')
    expect(monthly(kv).byService).toEqual({ deepgram: 1 })
    expect(monthly(kv).events).toHaveLength(1)
  })

  it('counts a still-running run again once the dedup key has expired', async () => {
    const kv = makeKV()
    await recordDegradation(kv, spike(), 'operational', NOW)
    kv.store.delete(DEDUP)
    expect(await recordDegradation(kv, spike(), 'operational', new Date('2026-10-30T14:20:00.000Z'))).toBe(true)
    expect(kv.store.get(DAILY)).toBe('2')
    expect(kv.store.get(NOSTATUS)).toBe('2')
    expect(monthly(kv).byService).toEqual({ deepgram: 2 })
    expect(monthly(kv).noStatusByService).toEqual({ deepgram: 2 })
  })

  it('stamps detected: with the run start, keeping an earlier existing stamp', async () => {
    const kv = makeKV()
    await recordDegradation(kv, spike(), 'operational', NOW)
    expect(JSON.parse(kv.store.get('detected:deepgram') ?? 'null')).toEqual({ t: '2026-10-30T13:05:00.000Z', incId: null })

    const earlier = makeKV()
    earlier.store.set('detected:deepgram', JSON.stringify({ t: '2026-10-30T12:00:00.000Z', incId: 'inc1' }))
    await recordDegradation(earlier, spike(), 'operational', NOW)
    expect(JSON.parse(earlier.store.get('detected:deepgram') ?? 'null')).toEqual({ t: '2026-10-30T12:00:00.000Z', incId: 'inc1' })
  })

  it('dedups per service, not globally', async () => {
    const kv = makeKV()
    await recordDegradation(kv, spike('deepgram'), 'operational', NOW)
    expect(await recordDegradation(kv, spike('gemini'), 'operational', NOW)).toBe(true)
    expect(monthly(kv).byService).toEqual({ deepgram: 1, gemini: 1 })
  })

  it('counts "not on status page" only when the cached status is operational', async () => {
    for (const [status, noStatus] of [['operational', 1], ['degraded', 0], ['down', 0], [undefined, 0]] as const) {
      const kv = makeKV()
      await recordDegradation(kv, spike(), status, NOW)
      expect(kv.store.get(DAILY), `daily for ${status}`).toBe('1')
      expect(kv.store.get(NOSTATUS) ?? '0', `nostatus for ${status}`).toBe(String(noStatus))
      expect(monthly(kv).noStatusByService.deepgram ?? 0, `monthly nostatus for ${status}`).toBe(noStatus)
    }
  })
})
