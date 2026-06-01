import { describe, it, expect, vi } from 'vitest'
import { v1Variant, recordV1Traffic } from '../api-traffic'

describe('v1Variant (#518)', () => {
  it('classifies the bare endpoint as all-services', () => {
    expect(v1Variant('/api/v1/status')).toBe('v1-status-all')
    expect(v1Variant('/api/v1/status/')).toBe('v1-status-all')
  })

  it('classifies a per-service path as service', () => {
    expect(v1Variant('/api/v1/status/claude')).toBe('v1-status-service')
    expect(v1Variant('/api/v1/status/openai')).toBe('v1-status-service')
  })
})

describe('recordV1Traffic (#518)', () => {
  it('writes one data point with the pinned blob/double/index shape', () => {
    const wae = { writeDataPoint: vi.fn() }
    recordV1Traffic(wae as unknown as AnalyticsEngineDataset, '/api/v1/status')
    expect(wae.writeDataPoint).toHaveBeenCalledOnce()
    expect(wae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ['v1-status-all'],
      doubles: [1],
      indexes: ['v1-status'],
    })
  })

  it('tags the per-service variant in blob1 but keeps the shared index', () => {
    const wae = { writeDataPoint: vi.fn() }
    recordV1Traffic(wae as unknown as AnalyticsEngineDataset, '/api/v1/status/claude')
    const call = wae.writeDataPoint.mock.calls[0][0]
    expect(call.blobs[0]).toBe('v1-status-service')
    expect(call.indexes[0]).toBe('v1-status') // shared dimension → total-v1 queryable with one filter
  })

  it('keeps the index within the 32-byte WAE cap', () => {
    const wae = { writeDataPoint: vi.fn() }
    recordV1Traffic(wae as unknown as AnalyticsEngineDataset, '/api/v1/status')
    const call = wae.writeDataPoint.mock.calls[0][0]
    expect(call.indexes[0].length).toBeLessThanOrEqual(32)
    expect(call.blobs[0].length).toBeLessThanOrEqual(32)
  })

  it('does not write when the binding is absent (local dev / tests)', () => {
    const wae = { writeDataPoint: vi.fn() }
    recordV1Traffic(undefined, '/api/v1/status')
    expect(wae.writeDataPoint).not.toHaveBeenCalled()
  })

  it('swallows a writeDataPoint failure (best-effort, never aborts the response)', () => {
    const wae = { writeDataPoint: vi.fn(() => { throw new Error('WAE down') }) }
    expect(() => recordV1Traffic(wae as unknown as AnalyticsEngineDataset, '/api/v1/status')).not.toThrow()
  })
})
