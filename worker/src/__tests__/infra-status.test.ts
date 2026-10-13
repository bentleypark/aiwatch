import { describe, it, expect, vi } from 'vitest'
import {
  INFRA_PLATFORMS, INFRA_STATUS_KEY, parseInfraSummary, runInfraStatusCycle, readInfraContext, infraAlertKey,
  checkInfraStatus, type InfraPlatformStatus,
} from '../infra-status'
import { mockKV } from './helpers/unreadable-source'

const cloudflare = INFRA_PLATFORMS.find((p) => p.id === 'cloudflare')!

// Shape of www.cloudflarestatus.com/api/v2/summary.json (2026-10-12): components carry id + status,
// incidents name the components they affect.
const summary = (overrides: Record<string, string> = {}, incidents: unknown[] = []) => ({
  components: [
    ...Object.keys(cloudflare.components).map((id) => ({ id, name: 'renamed-on-purpose', status: overrides[id] ?? 'operational' })),
    { id: 'untracked1234', name: 'Pages', status: 'major_outage' },
  ],
  incidents,
})

describe('#1686 parseInfraSummary', () => {
  it('reads tracked components by id, ignoring their published names', () => {
    const s = parseInfraSummary(cloudflare, summary({ '57srcl8zcn7c': 'degraded_performance' }))!
    expect(s.status).toBe('degraded')
    expect(s.affected).toEqual([{ name: 'Workers', status: 'degraded' }])
  })
  it('an outage on an untracked component does not count', () => {
    expect(parseInfraSummary(cloudflare, summary())!.status).toBe('operational')
  })
  it('major_outage is down', () => {
    expect(parseInfraSummary(cloudflare, summary({ tmh50tx2nprs: 'major_outage' }))!.status).toBe('down')
  })
  it('keeps only unresolved incidents that name a tracked component', () => {
    const s = parseInfraSummary(cloudflare, summary({}, [
      { name: 'Workers API', status: 'investigating', components: [{ id: '57srcl8zcn7c' }] },
      { name: 'Pages builds', status: 'investigating', components: [{ id: 'untracked1234' }] },
      { name: 'Old', status: 'resolved', components: [{ id: '57srcl8zcn7c' }] },
    ]))!
    expect(s.incidents).toEqual(['Workers API'])
  })
  it('reports a tracked id the page no longer publishes', () => {
    const json = summary()
    json.components = json.components.filter((c) => c.id !== 'v4s7np92f0dh')
    expect(parseInfraSummary(cloudflare, json)!.missing).toEqual(['v4s7np92f0dh'])
  })
  it('is null for a body without a components array', () => {
    expect(parseInfraSummary(cloudflare, { status: 'ok' })).toBeNull()
  })
})

describe('#1686 checkInfraStatus', () => {
  it('leaves out a platform whose page cannot be read, never reporting it operational', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = vi.fn(async (url: string) => url.includes('cloudflare')
      ? new Response(JSON.stringify(summary()), { status: 200 })
      : new Response('down', { status: 503 }))
    const out = await checkInfraStatus(fetchImpl as never)
    expect(out.map((s) => s.id)).toEqual(['cloudflare'])
  })
})

const status = (id: InfraPlatformStatus['id'], s: InfraPlatformStatus['status']): InfraPlatformStatus => ({
  id, name: id, status: s, affected: s === 'operational' ? [] : [{ name: 'Workers', status: s }], incidents: [], missing: [],
})

describe('#1686 runInfraStatusCycle', () => {
  it('alerts once while affected, then recovers once', async () => {
    const kv = mockKV()
    const send = vi.fn(async () => true)
    await runInfraStatusCycle(kv as never, send, [status('cloudflare', 'degraded')])
    await runInfraStatusCycle(kv as never, send, [status('cloudflare', 'degraded')])
    expect(send).toHaveBeenCalledTimes(1)
    expect(kv.store[infraAlertKey('cloudflare')]).toBe('affected')
    await runInfraStatusCycle(kv as never, send, [status('cloudflare', 'operational')])
    expect(send).toHaveBeenCalledTimes(2)
    expect(kv.store[infraAlertKey('cloudflare')]).toBe('recovered')
  })
  it('a platform flapping across cycles sends at most one alert and one recovery per hold', async () => {
    const kv = mockKV()
    const send = vi.fn(async () => true)
    for (const s of ['degraded', 'operational', 'degraded', 'operational', 'degraded'] as const) {
      await runInfraStatusCycle(kv as never, send, [status('cloudflare', s)])
    }
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('writes the status key only while something is affected', async () => {
    const kv = mockKV()
    await runInfraStatusCycle(kv as never, async () => true, [status('cloudflare', 'operational')])
    expect(kv.store[INFRA_STATUS_KEY]).toBeUndefined()
    await runInfraStatusCycle(kv as never, async () => true, [status('cloudflare', 'degraded'), status('github', 'operational')])
    expect(await readInfraContext(kv as never)).toEqual(['🟡 **cloudflare**: Workers degraded'])
  })
  it('a failed send leaves no key, so the next cycle retries', async () => {
    const kv = mockKV()
    await runInfraStatusCycle(kv as never, async () => false, [status('vercel', 'down')])
    expect(kv.store[infraAlertKey('vercel')]).toBeUndefined()
  })
})
