import { describe, it, expect, vi } from 'vitest'
import {
  parseVitals,
  writeVitalsToKV,
  computeP75,
  readVitalsSummary,
  formatVitalsSection,
  vitalsGrade,
  type VitalsDaily,
} from '../vitals'

describe('parseVitals', () => {
  it('parses valid payload', () => {
    const result = parseVitals({ metrics: { LCP: 2500, FCP: 1200, TTFB: 800 }, ts: Date.now() })
    expect(result).toEqual({ LCP: 2500, FCP: 1200, TTFB: 800 })
  })

  it('accepts partial metrics', () => {
    const result = parseVitals({ metrics: { LCP: 1500 }, ts: Date.now() })
    expect(result).toEqual({ LCP: 1500 })
  })

  it('returns null for null/undefined/non-object', () => {
    expect(parseVitals(null)).toBeNull()
    expect(parseVitals(undefined)).toBeNull()
    expect(parseVitals('string')).toBeNull()
  })

  it('returns null without metrics object', () => {
    expect(parseVitals({ ts: 123 })).toBeNull()
    expect(parseVitals({ metrics: 'invalid' })).toBeNull()
  })

  it('rejects negative, NaN, or Infinity values', () => {
    expect(parseVitals({ metrics: { LCP: -100 }, ts: 0 })).toBeNull()
    expect(parseVitals({ metrics: { LCP: NaN }, ts: 0 })).toBeNull()
    expect(parseVitals({ metrics: { LCP: Infinity }, ts: 0 })).toBeNull()
  })

  it('ignores unknown metric names', () => {
    expect(parseVitals({ metrics: { UNKNOWN: 100 }, ts: 0 })).toBeNull()
  })

  it('extracts only valid metrics from mixed payload', () => {
    const result = parseVitals({ metrics: { LCP: 2000, UNKNOWN: 50, FCP: -1 }, ts: 0 })
    expect(result).toEqual({ LCP: 2000 })
  })
})

describe('computeP75', () => {
  it('returns 0 for empty array', () => {
    expect(computeP75([])).toBe(0)
  })

  it('returns single value for single-element array', () => {
    expect(computeP75([500])).toBe(500)
  })

  it('computes correct p75 for sorted data', () => {
    // [100, 200, 300, 400] → p75 index = ceil(4*0.75)-1 = 2 → 300
    expect(computeP75([100, 200, 300, 400])).toBe(300)
  })

  it('computes p75 for unsorted data', () => {
    expect(computeP75([400, 100, 300, 200])).toBe(300)
  })

  it('computes p75 for larger dataset', () => {
    const values = Array.from({ length: 100 }, (_, i) => (i + 1) * 10) // 10, 20, ..., 1000
    // p75 index = ceil(100*0.75)-1 = 74 → value = 750
    expect(computeP75(values)).toBe(750)
  })
})

describe('writeVitalsToKV', () => {
  it('creates new entry when no existing data', async () => {
    const stored: Record<string, string> = {}
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockImplementation((key: string, value: string) => {
        stored[key] = value
        return Promise.resolve()
      }),
    }

    await writeVitalsToKV(kv as unknown as KVNamespace, { LCP: 2500, FCP: 1200 })

    expect(kv.put).toHaveBeenCalledTimes(1)
    const key = Object.keys(stored)[0]
    expect(key).toMatch(/^vitals:\d{4}-\d{2}-\d{2}$/)
    const data = JSON.parse(stored[key])
    expect(data.count).toBe(1)
    expect(data.allValues.LCP).toEqual([2500])
    expect(data.allValues.FCP).toEqual([1200])
    expect(data.allValues.TTFB).toEqual([])
  })

  it('merges with existing KV data', async () => {
    const existing = JSON.stringify({
      count: 5,
      allValues: { LCP: [1000, 2000], FCP: [800], TTFB: [], CLS: [], INP: [] },
    })
    const kv = {
      get: vi.fn().mockResolvedValue(existing),
      put: vi.fn().mockResolvedValue(undefined),
    }

    await writeVitalsToKV(kv as unknown as KVNamespace, { LCP: 3000 })

    const putCall = kv.put.mock.calls[0]
    const data = JSON.parse(putCall[1])
    expect(data.count).toBe(6) // 5 + 1
    expect(data.allValues.LCP).toEqual([1000, 2000, 3000])
  })

  it('caps samples at 2000 per metric', async () => {
    const bigArray = Array.from({ length: 2000 }, (_, i) => i)
    const existing = JSON.stringify({
      count: 2000,
      allValues: { LCP: bigArray, FCP: [], TTFB: [], CLS: [], INP: [] },
    })
    const kv = {
      get: vi.fn().mockResolvedValue(existing),
      put: vi.fn().mockResolvedValue(undefined),
    }

    await writeVitalsToKV(kv as unknown as KVNamespace, { LCP: 9999 })

    const data = JSON.parse(kv.put.mock.calls[0][1])
    expect(data.allValues.LCP).toHaveLength(2000)
    expect(data.allValues.LCP[data.allValues.LCP.length - 1]).toBe(9999)
  })

  it('handles corrupt existing data gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const kv = {
      get: vi.fn().mockResolvedValue('not-json{{{'),
      put: vi.fn().mockResolvedValue(undefined),
    }

    await writeVitalsToKV(kv as unknown as KVNamespace, { LCP: 1000 })

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[vitals] corrupt KV data'), expect.any(String), expect.any(String))
    const data = JSON.parse(kv.put.mock.calls[0][1])
    expect(data.count).toBe(1)
    expect(data.allValues.LCP).toEqual([1000])
    consoleSpy.mockRestore()
  })
})

describe('readVitalsSummary', () => {
  it('returns null when no data', async () => {
    const kv = { get: vi.fn().mockResolvedValue(null) }
    expect(await readVitalsSummary(kv as unknown as KVNamespace)).toBeNull()
  })

  it('returns p75 summary from stored data', async () => {
    const data = {
      count: 10,
      allValues: {
        LCP: [1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500],
        FCP: [500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400],
        TTFB: [200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100],
        CLS: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
        INP: [50, 100, 150, 200, 250, 300, 350, 400, 450, 500],
      },
    }
    const kv = { get: vi.fn().mockResolvedValue(JSON.stringify(data)) }
    const result = await readVitalsSummary(kv as unknown as KVNamespace)

    expect(result).not.toBeNull()
    expect(result!.count).toBe(10)
    expect(result!.p75.LCP).toBe(4500)
    expect(result!.p75.FCP).toBe(1200)
  })

  it('logs error on KV read failure', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const kv = { get: vi.fn().mockRejectedValue(new Error('KV timeout')) }
    const result = await readVitalsSummary(kv as unknown as KVNamespace)
    expect(result).toBeNull()
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[vitals] KV read failed'), expect.any(String), expect.any(String))
    consoleSpy.mockRestore()
  })
})

describe('vitalsGrade', () => {
  it('rates LCP correctly', () => {
    expect(vitalsGrade('LCP', 2000)).toBe('good')
    expect(vitalsGrade('LCP', 2500)).toBe('good')
    expect(vitalsGrade('LCP', 3000)).toBe('needs-improvement')
    expect(vitalsGrade('LCP', 5000)).toBe('poor')
  })

  it('rates CLS correctly (×1000 scale)', () => {
    expect(vitalsGrade('CLS', 50)).toBe('good')
    expect(vitalsGrade('CLS', 100)).toBe('good')
    expect(vitalsGrade('CLS', 150)).toBe('needs-improvement')
    expect(vitalsGrade('CLS', 300)).toBe('poor')
  })

  it('rates INP correctly', () => {
    expect(vitalsGrade('INP', 150)).toBe('good')
    expect(vitalsGrade('INP', 200)).toBe('good')
    expect(vitalsGrade('INP', 300)).toBe('needs-improvement')
    expect(vitalsGrade('INP', 600)).toBe('poor')
  })
})

describe('formatVitalsSection', () => {
  it('formats all metrics with grades and descriptions', () => {
    const vitals: VitalsDaily = {
      count: 50,
      p75: { LCP: 2000, FCP: 1500, TTFB: 700, CLS: 80, INP: 150 },
    }
    const output = formatVitalsSection(vitals)
    expect(output).toContain('Web Vitals')
    expect(output).toContain('n=50')
    expect(output).toContain('LCP')
    expect(output).toContain('2.00s')
    expect(output).toContain('🟢')
    expect(output).toContain('Good')
    expect(output).toContain('최대 요소 렌더링')
    expect(output).toContain('레이아웃 흔들림')
    expect(output).toContain('p75 = 사용자 75%')
  })

  it('shows poor metric with red emoji', () => {
    const vitals: VitalsDaily = {
      count: 10,
      p75: { LCP: 5000, FCP: 1000, TTFB: 500, CLS: 50, INP: 100 },
    }
    const output = formatVitalsSection(vitals)
    expect(output).toContain('🔴') // LCP poor
    expect(output).toContain('Poor')
  })
})
