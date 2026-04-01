import { describe, it, expect, vi } from 'vitest'
import { COMPONENT_ID_SERVICES } from '../services'
import { detectComponentMismatches, type KVLike } from '../utils'

function mockKV(store: Record<string, string> = {}): KVLike {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async (key: string, value: string) => { store[key] = value }),
    delete: vi.fn(async (key: string) => { delete store[key] }),
  }
}

describe('COMPONENT_ID_SERVICES', () => {
  it('contains only services with statusComponentId', () => {
    expect(COMPONENT_ID_SERVICES.length).toBeGreaterThan(0)
    for (const svc of COMPONENT_ID_SERVICES) {
      expect(svc.statusComponentId).toBeTruthy()
      expect(svc.id).toBeTruthy()
      expect(svc.name).toBeTruthy()
    }
  })

  it('includes known services that use statusComponentId', () => {
    const ids = COMPONENT_ID_SERVICES.map((s) => s.id)
    // Claude services use statusComponentId
    expect(ids).toContain('claude')
    expect(ids).toContain('claudeai')
    expect(ids).toContain('claudecode')
  })
})

describe('detectComponentMismatches (#135)', () => {
  const services = [
    { id: 'claude', name: 'Claude API', statusComponentId: 'comp-claude' },
    { id: 'openai', name: 'OpenAI API', statusComponentId: 'comp-openai' },
    { id: 'gemini', name: 'Gemini API', statusComponentId: 'comp-gemini' },
  ]

  it('returns service when miss count reaches threshold (3)', async () => {
    const kv = mockKV({ 'component-missing:claude': '3' })
    const results = await detectComponentMismatches(services, kv)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('claude')
    expect(results[0].missCount).toBe(3)
    expect(results[0].alertKey).toBe('alerted:component-missing:claude')
    expect(results[0].statusComponentId).toBe('comp-claude')
  })

  it('returns service when miss count exceeds threshold', async () => {
    const kv = mockKV({ 'component-missing:openai': '10' })
    const results = await detectComponentMismatches(services, kv)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('openai')
    expect(results[0].missCount).toBe(10)
  })

  it('does not return when miss count below threshold', async () => {
    const kv = mockKV({ 'component-missing:claude': '2' })
    const results = await detectComponentMismatches(services, kv)
    expect(results).toHaveLength(0)
  })

  it('does not return when no miss counter exists', async () => {
    const kv = mockKV()
    const results = await detectComponentMismatches(services, kv)
    expect(results).toHaveLength(0)
  })

  it('deduplicates: skips if already alerted (24h TTL)', async () => {
    const kv = mockKV({
      'component-missing:claude': '5',
      'alerted:component-missing:claude': '1',
    })
    const results = await detectComponentMismatches(services, kv)
    expect(results).toHaveLength(0)
  })

  it('returns multiple services simultaneously', async () => {
    const kv = mockKV({
      'component-missing:claude': '3',
      'component-missing:openai': '4',
      'component-missing:gemini': '1', // below threshold
    })
    const results = await detectComponentMismatches(services, kv)
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.id)).toEqual(['claude', 'openai'])
  })

  it('handles corrupted (non-numeric) KV value gracefully', async () => {
    const kv = mockKV({ 'component-missing:claude': 'invalid' })
    const results = await detectComponentMismatches(services, kv)
    expect(results).toHaveLength(0) // parseInt('invalid') → NaN → || 0 → below threshold
  })

  it('supports custom threshold', async () => {
    const kv = mockKV({ 'component-missing:claude': '4' })
    expect(await detectComponentMismatches(services, kv, 5)).toHaveLength(0) // 4 < 5
    expect(await detectComponentMismatches(services, kv, 4)).toHaveLength(1) // 4 >= 4
  })

  it('continues processing when KV read throws for one service', async () => {
    const kv = mockKV({ 'component-missing:openai': '5' })
    // Override get to throw for claude, return normally for others
    kv.get = vi.fn(async (key: string) => {
      if (key === 'component-missing:claude') throw new Error('KV read error')
      if (key === 'component-missing:openai') return '5'
      if (key === 'alerted:component-missing:openai') return null
      return null
    })
    // claude throws (caught by .catch(() => null) → count 0 → skipped)
    // openai has count 5 → returned
    const results = await detectComponentMismatches(services, kv)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('openai')
  })
})
