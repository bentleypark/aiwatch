import { describe, it, expect } from 'vitest'
import { accumulateComponentCounters } from '../index'

// #605 — per-component daily uptime accumulation (rides the daily:{date} value).

describe('accumulateComponentCounters (#605)', () => {
  it('accumulates ok/total per component across cycles; ok only on operational', () => {
    const entry: { ok: number; total: number; components?: Record<string, { ok: number; total: number; name: string }> } = { ok: 0, total: 0 }
    // cycle 1: both operational
    accumulateComponentCounters(entry, [
      { id: 'api', name: 'API', status: 'operational' },
      { id: 'm1', name: 'Model 1', status: 'operational' },
    ])
    // cycle 2: m1 degraded
    accumulateComponentCounters(entry, [
      { id: 'api', name: 'API', status: 'operational' },
      { id: 'm1', name: 'Model 1', status: 'degraded' },
    ])
    expect(entry.components).toEqual({
      api: { ok: 2, total: 2, name: 'API' },
      m1: { ok: 1, total: 2, name: 'Model 1' }, // down 1 of 2 cycles
    })
  })

  it('is a no-op when the service has no components', () => {
    const entry: { ok: number; total: number; components?: Record<string, unknown> } = { ok: 5, total: 5 }
    accumulateComponentCounters(entry, undefined)
    accumulateComponentCounters(entry, [])
    expect(entry.components).toBeUndefined()
  })

  it('keeps the latest display name when a component is renamed', () => {
    const entry: { ok: number; total: number; components?: Record<string, { ok: number; total: number; name: string }> } = { ok: 0, total: 0 }
    accumulateComponentCounters(entry, [{ id: 'x', name: 'Old Name', status: 'operational' }])
    accumulateComponentCounters(entry, [{ id: 'x', name: 'New Name', status: 'operational' }])
    expect(entry.components!.x).toEqual({ ok: 2, total: 2, name: 'New Name' })
  })

  it('a new component appearing mid-day starts its own counter (total tracks since first seen)', () => {
    const entry: { ok: number; total: number; components?: Record<string, { ok: number; total: number; name: string }> } = { ok: 0, total: 0 }
    accumulateComponentCounters(entry, [{ id: 'a', name: 'A', status: 'operational' }])
    accumulateComponentCounters(entry, [
      { id: 'a', name: 'A', status: 'operational' },
      { id: 'b', name: 'B', status: 'down' },
    ])
    expect(entry.components).toEqual({
      a: { ok: 2, total: 2, name: 'A' },
      b: { ok: 0, total: 1, name: 'B' }, // appeared on cycle 2 only
    })
  })
})
