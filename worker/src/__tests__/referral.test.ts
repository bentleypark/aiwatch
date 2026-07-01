import { describe, it, expect, vi } from 'vitest'
import { parseReferralBody, addReferral, recordReferral, referralKey, type ReferralCounts } from '../referral'
import type { KVLike } from '../utils'

const VALID = new Set(['claude', 'openai', 'gemini'])

describe('parseReferralBody', () => {
  it('accepts a known `to`, keeps a known `from`', () => {
    expect(parseReferralBody({ from: 'claude', to: 'gemini' }, VALID)).toEqual({ from: 'claude', to: 'gemini' })
  })
  it('drops an unknown `from` to "" but keeps a known `to`', () => {
    expect(parseReferralBody({ from: 'nope', to: 'openai' }, VALID)).toEqual({ from: '', to: 'openai' })
    expect(parseReferralBody({ to: 'openai' }, VALID)).toEqual({ from: '', to: 'openai' })
  })
  it('rejects an unknown / missing `to` (abuse guard — no arbitrary bucket)', () => {
    expect(parseReferralBody({ from: 'claude', to: 'evil' }, VALID)).toBeNull()
    expect(parseReferralBody({ from: 'claude' }, VALID)).toBeNull()
    expect(parseReferralBody({ to: 123 }, VALID)).toBeNull()
  })
  it('rejects non-object bodies', () => {
    expect(parseReferralBody(null, VALID)).toBeNull()
    expect(parseReferralBody('x', VALID)).toBeNull()
    expect(parseReferralBody(42, VALID)).toBeNull()
  })
})

describe('addReferral', () => {
  it('initializes from null and increments total + per-service', () => {
    expect(addReferral(null, 'gemini')).toEqual({ total: 1, byService: { gemini: 1 } })
  })
  it('accumulates onto existing counts', () => {
    const a = addReferral({ total: 2, byService: { gemini: 2 } }, 'gemini')
    expect(a).toEqual({ total: 3, byService: { gemini: 3 } })
    const b = addReferral(a, 'openai')
    expect(b).toEqual({ total: 4, byService: { gemini: 3, openai: 1 } })
  })
  it('treats a malformed existing value as empty (missing total, or non-object byService)', () => {
    expect(addReferral({} as ReferralCounts, 'openai')).toEqual({ total: 1, byService: { openai: 1 } })
    // corrupt byService (null / non-object) must not throw — review #2
    expect(addReferral({ total: 3, byService: null } as unknown as ReferralCounts, 'openai')).toEqual({ total: 1, byService: { openai: 1 } })
    expect(addReferral({ total: 3, byService: 'x' } as unknown as ReferralCounts, 'openai')).toEqual({ total: 1, byService: { openai: 1 } })
  })
})

function makeKV(initial?: Record<string, string>) {
  const store = new Map(Object.entries(initial ?? {}))
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
    _store: store,
  } as unknown as KVLike & { _store: Map<string, string>; get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> }
}

describe('recordReferral', () => {
  it('writes referral:out:{date} with a 2d TTL (read-modify-write)', async () => {
    const kv = makeKV()
    expect(await recordReferral(kv, '2026-07-01', 'gemini')).toBe(true)
    expect(kv.put).toHaveBeenCalledWith(referralKey('2026-07-01'), expect.any(String), { expirationTtl: 172800 })
    expect(JSON.parse(kv._store.get('referral:out:2026-07-01')!)).toEqual({ total: 1, byService: { gemini: 1 } })
    await recordReferral(kv, '2026-07-01', 'gemini')
    await recordReferral(kv, '2026-07-01', 'openai')
    expect(JSON.parse(kv._store.get('referral:out:2026-07-01')!)).toEqual({ total: 3, byService: { gemini: 2, openai: 1 } })
  })
  it('starts fresh on a corrupt existing value', async () => {
    const kv = makeKV({ 'referral:out:2026-07-01': 'not json{' })
    expect(await recordReferral(kv, '2026-07-01', 'gemini')).toBe(true)
    expect(JSON.parse(kv._store.get('referral:out:2026-07-01')!)).toEqual({ total: 1, byService: { gemini: 1 } })
  })
  it('best-effort — returns false (never throws) on a KV put failure', async () => {
    const kv = makeKV()
    kv.put.mockRejectedValueOnce(new Error('KV down'))
    expect(await recordReferral(kv, '2026-07-01', 'gemini')).toBe(false)
  })
})
