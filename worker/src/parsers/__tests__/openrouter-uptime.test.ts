import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchOpenRouterXaiUptime, isOpenRouterDegraded, XAI_OPENROUTER_MODEL_SLUGS } from '../openrouter-uptime'

// Build an /api/v1/models/{slug}/endpoints response with the given endpoint list.
function endpointsResponse(endpoints: Array<{ provider_name?: string; uptime_last_30m?: number }>) {
  return { ok: true, json: async () => ({ data: { endpoints } }) } as unknown as Response
}
const notOk = { ok: false, status: 404, json: async () => ({}) } as unknown as Response

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fetchOpenRouterXaiUptime', () => {
  it('averages the xAI-endpoint uptime across the resolved slugs (2dp)', async () => {
    // 3 slugs → 99.94, 99.98, 99.99 → avg 99.9700 → 99.97
    const values = [99.94231421784866, 99.98225062122825, 99.99007818391078]
    let i = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      endpointsResponse([{ provider_name: 'xAI', uptime_last_30m: values[i++] }]),
    )
    const res = await fetchOpenRouterXaiUptime()
    expect(res).not.toBeNull()
    expect(res!.sampleCount).toBe(3)
    expect(res!.uptimePct).toBeCloseTo(99.97, 2)
    expect(typeof res!.measuredAt).toBe('string')
    expect(Number.isNaN(Date.parse(res!.measuredAt))).toBe(false)
  })

  it('ignores slugs that 404 and averages only the resolved ones', async () => {
    let i = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      i++
      if (i === 2) return notOk // middle slug deprecated
      return endpointsResponse([{ provider_name: 'xAI', uptime_last_30m: 98 }])
    })
    const res = await fetchOpenRouterXaiUptime()
    expect(res).not.toBeNull()
    expect(res!.sampleCount).toBe(2)
    expect(res!.uptimePct).toBe(98)
  })

  it('picks the xAI endpoint when a model is multi-routed (ignores other providers)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      endpointsResponse([
        { provider_name: 'Together', uptime_last_30m: 50 },
        { provider_name: 'xAI', uptime_last_30m: 99 },
        { provider_name: 'Fireworks', uptime_last_30m: 60 },
      ]),
    )
    const res = await fetchOpenRouterXaiUptime()
    expect(res!.uptimePct).toBe(99)
    expect(res!.sampleCount).toBe(XAI_OPENROUTER_MODEL_SLUGS.length)
  })

  it('returns null when no slug has an xAI endpoint', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      endpointsResponse([{ provider_name: 'Together', uptime_last_30m: 99 }]),
    )
    expect(await fetchOpenRouterXaiUptime()).toBeNull()
  })

  it('returns null when every fetch fails (network / 404)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => notOk)
    expect(await fetchOpenRouterXaiUptime()).toBeNull()
  })

  it('returns null on malformed payload (no data.endpoints array)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      ({ ok: true, json: async () => ({ data: { endpoints: 'oops' } }) } as unknown as Response),
    )
    expect(await fetchOpenRouterXaiUptime()).toBeNull()
  })

  it('returns null when endpoints is an empty array (no xAI entry to read)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => endpointsResponse([]))
    expect(await fetchOpenRouterXaiUptime()).toBeNull()
  })

  it('skips an xAI endpoint whose uptime_last_30m is missing/undefined', async () => {
    let i = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      i++
      if (i === 1) return endpointsResponse([{ provider_name: 'xAI' }]) // no uptime field → skipped
      return endpointsResponse([{ provider_name: 'xAI', uptime_last_30m: 96 }])
    })
    const res = await fetchOpenRouterXaiUptime()
    expect(res!.sampleCount).toBe(2)
    expect(res!.uptimePct).toBe(96)
  })

  it('treats a rejecting json() as a failed slug (trailing .catch swallows it)', async () => {
    let i = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      i++
      if (i === 2) return { ok: true, json: async () => { throw new Error('bad json') } } as unknown as Response
      return endpointsResponse([{ provider_name: 'xAI', uptime_last_30m: 94 }])
    })
    const res = await fetchOpenRouterXaiUptime()
    expect(res!.sampleCount).toBe(2)
    expect(res!.uptimePct).toBe(94)
  })

  it('discards out-of-range / non-finite uptime values', async () => {
    let i = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const v = [101, NaN, 97.5][i++] // first two invalid → only 97.5 counts
      return endpointsResponse([{ provider_name: 'xAI', uptime_last_30m: v }])
    })
    const res = await fetchOpenRouterXaiUptime()
    expect(res!.sampleCount).toBe(1)
    expect(res!.uptimePct).toBe(97.5)
  })

  it('survives one slug throwing (rejected fetch) — Promise.allSettled, not all', async () => {
    let i = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      i++
      if (i === 1) throw new Error('boom')
      return endpointsResponse([{ provider_name: 'xAI', uptime_last_30m: 95 }])
    })
    const res = await fetchOpenRouterXaiUptime()
    expect(res!.sampleCount).toBe(2)
    expect(res!.uptimePct).toBe(95)
  })
})

describe('isOpenRouterDegraded', () => {
  const svc = (id: string, status: string) => ({ id, status })
  const wrap = (services: unknown[]) => JSON.stringify({ services })

  it('true when the openrouter service is non-operational', () => {
    expect(isOpenRouterDegraded(wrap([svc('claude', 'operational'), svc('openrouter', 'degraded')]))).toBe(true)
    expect(isOpenRouterDegraded(wrap([svc('openrouter', 'down')]))).toBe(true)
  })

  it('false when the openrouter service is operational', () => {
    expect(isOpenRouterDegraded(wrap([svc('openrouter', 'operational'), svc('xai', 'down')]))).toBe(false)
  })

  it('false when there is no openrouter entry (no positive evidence)', () => {
    expect(isOpenRouterDegraded(wrap([svc('claude', 'operational'), svc('xai', 'operational')]))).toBe(false)
  })

  it('false on null / empty / unparseable / wrong-shaped cache', () => {
    expect(isOpenRouterDegraded(null)).toBe(false)
    expect(isOpenRouterDegraded(undefined)).toBe(false)
    expect(isOpenRouterDegraded('')).toBe(false)
    expect(isOpenRouterDegraded('not json{')).toBe(false)
    expect(isOpenRouterDegraded(JSON.stringify({ services: 'oops' }))).toBe(false)
    expect(isOpenRouterDegraded(JSON.stringify({ notServices: [] }))).toBe(false)
  })
})
