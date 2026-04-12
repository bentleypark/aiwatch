import { describe, it, expect } from 'vitest'
import { detectServiceCountDrop } from '../alerts'

const CONFIGS = Array.from({ length: 30 }, (_, i) => ({ id: `svc${i}` }))

describe('detectServiceCountDrop (#221)', () => {
  it('returns not dropped when all services present', () => {
    const ids = CONFIGS.map(c => c.id)
    const result = detectServiceCountDrop(ids, CONFIGS)
    expect(result.dropped).toBe(false)
    expect(result.missing).toEqual([])
  })

  it('returns not dropped at 80% threshold (24/30)', () => {
    const ids = CONFIGS.slice(0, 24).map(c => c.id)
    const result = detectServiceCountDrop(ids, CONFIGS)
    expect(result.dropped).toBe(false)
  })

  it('returns dropped below 80% threshold (23/30)', () => {
    const ids = CONFIGS.slice(0, 23).map(c => c.id)
    const result = detectServiceCountDrop(ids, CONFIGS)
    expect(result.dropped).toBe(true)
    expect(result.missing).toHaveLength(7)
    expect(result.missing).toContain('svc23')
    expect(result.missing).toContain('svc29')
  })

  it('returns dropped for 13/30 services (actual incident scenario)', () => {
    const ids = CONFIGS.slice(0, 13).map(c => c.id)
    const result = detectServiceCountDrop(ids, CONFIGS)
    expect(result.dropped).toBe(true)
    expect(result.missing).toHaveLength(17)
  })

  it('returns dropped for 0 services', () => {
    const result = detectServiceCountDrop([], CONFIGS)
    expect(result.dropped).toBe(true)
    expect(result.missing).toHaveLength(30)
  })

  it('identifies correct missing service IDs', () => {
    const ids = ['svc0', 'svc5', 'svc10']
    const result = detectServiceCountDrop(ids, CONFIGS)
    expect(result.dropped).toBe(true)
    expect(result.missing).not.toContain('svc0')
    expect(result.missing).not.toContain('svc5')
    expect(result.missing).not.toContain('svc10')
    expect(result.missing).toContain('svc1')
    expect(result.missing).toContain('svc29')
  })

  it('supports custom threshold ratio', () => {
    const ids = CONFIGS.slice(0, 15).map(c => c.id) // 50%
    // Default 0.8 → dropped
    expect(detectServiceCountDrop(ids, CONFIGS).dropped).toBe(true)
    // Custom 0.5 → not dropped (15 >= floor(30*0.5)=15)
    expect(detectServiceCountDrop(ids, CONFIGS, 0.5).dropped).toBe(false)
    // Custom 0.5 with 14 → dropped
    const ids14 = CONFIGS.slice(0, 14).map(c => c.id)
    expect(detectServiceCountDrop(ids14, CONFIGS, 0.5).dropped).toBe(true)
  })
})
