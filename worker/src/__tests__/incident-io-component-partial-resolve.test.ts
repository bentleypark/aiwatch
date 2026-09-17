import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchService } from '../services'
import type { ServiceConfig } from '../types'

// #957 sub-problems 2+3 — turbopuffer/fireworks configure a LIST `incidentIoComponentId` with no
// `statusComponentId`/`statusComponentIds` at all, so they were structurally exempt from every existing
// miss-detection signal (#135/#379/#606). This file drives the real `fetchService` wiring that reports
// their drift through the SAME `trackPartialResolve` (#1179) mechanism `statusComponentIds` already
// uses, tagged `scope: 'uptime'` so the alert body names the right symptom — gated on
// `!config.statusComponentIds` (see the last test below and the `#957` comment in services.ts for why:
// a service configuring both fields resolves its uptime scope from `statusComponentIds`, not
// `incidentIoComponentId`, so the gate is what keeps the alert body's field name correct).
//
// Reproduced live 2026-09-15: fireworks was ACTUALLY in this state in production at the time this
// shipped (7 of 12 configured ids absent from component_uptimes) — not a hypothetical.

const DAY = 86_400_000
const esc = (o: unknown) => JSON.stringify(o).replace(/"/g, '\\"')

/** A turbopuffer/fireworks-shaped config: a LIST `incidentIoComponentId`, no statusComponentId(s) at
 *  all — the exact roster shape #957 closes the gap for. Kept small (3 ids) and synthetic rather than
 *  spread from the real turbopuffer/fireworks config, so the test does not silently drift if either
 *  service's real id roster changes. */
function multiIoConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    id: 'test-multi-io',
    name: 'Test Multi IO',
    provider: 'Test',
    category: 'api',
    statusUrl: 'https://status.test-multi-io.example',
    apiUrl: 'https://status.test-multi-io.example/api/v2/summary.json',
    incidentIoBaseUrl: 'https://status.test-multi-io.example/incidents',
    incidentIoComponentId: ['id-a', 'id-b', 'id-c'],
    ...overrides,
  }
}

/** Page-root RSC chunk in the real byte shape `parseIncidentIoImpacts`/`parseIncidentIoDataAvailableSince`
 *  read. `resolvedIds` get a `data_available_since`; any configured id NOT in this list is absent from
 *  the page entirely (never a `component_uptimes` entry at all) — the real shape a provider reorg
 *  produces, verified against fireworks' live page. */
function ioPageHtml(resolvedIds: string[]): string {
  const uptimes = resolvedIds.map((id) => ({
    component_id: id,
    data_available_since: '2024-01-01T00:00:00Z',
    status_page_component_group_id: '$undefined',
    uptime: '100.00',
  }))
  const payload = `\\"component_impacts\\":[],\\"component_uptimes\\":${esc(uptimes)}`
  return `<script>self.__next_f.push([1,"${payload}"])</script>`
}

const summary = (components: string[]) => ({
  page: { id: 'p1', name: 'Test Multi IO', updated_at: new Date().toISOString() },
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: components.map((id) => ({ id, name: id, status: 'operational' })),
  incidents: [],
})

/** A KV stand-in that records every `put` call. `get` always misses (no prior record), matching a
 *  fresh drift's first-observed cycle. */
function fakeKv() {
  const puts: Array<{ key: string; value: string; opts?: { expirationTtl?: number } }> = []
  const kv = {
    get: async () => null,
    put: async (key: string, value: string, opts?: { expirationTtl?: number }) => { puts.push({ key, value, opts }) },
    delete: async () => {},
  }
  return { kv, puts }
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchService reports a partial incidentIoComponentId resolve to trackPartialResolve (#957)', () => {
  it('writes component-partial:{id} with exactly the ids that did not resolve', async () => {
    const config = multiIoConfig()
    const { kv, puts } = fakeKv()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html></html>', { status: 200 })))

    await fetchService(
      config,
      { summary: summary(['id-a', 'id-b', 'id-c']) as never, incidents: null, latency: 100, uptimeHtml: ioPageHtml(['id-a']) } as never,
      kv as never,
      {},
    )

    const partialPut = puts.find((p) => p.key === 'component-partial:test-multi-io')
    expect(partialPut, 'trackPartialResolve should have written a component-partial record').toBeDefined()
    const entry = JSON.parse(partialPut!.value)
    expect(entry.missing.sort()).toEqual(['id-b', 'id-c'])
    // #957 round-1 review: an earlier version of this alert claimed the BADGE was affected and named
    // `statusComponentIds`, which is false for turbopuffer/fireworks-shaped services (no badge id list
    // at all). `scope: 'uptime'` is what makes formatPartialResolveAlert describe the real symptom.
    expect(entry.scope).toBe('uptime')
  })

  it('does NOT write a partial-resolve record when every configured id resolves', async () => {
    const config = multiIoConfig()
    const { kv, puts } = fakeKv()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html></html>', { status: 200 })))

    await fetchService(
      config,
      { summary: summary(['id-a', 'id-b', 'id-c']) as never, incidents: null, latency: 100, uptimeHtml: ioPageHtml(['id-a', 'id-b', 'id-c']) } as never,
      kv as never,
      {},
    )

    expect(puts.find((p) => p.key === 'component-partial:test-multi-io')).toBeUndefined()
  })

  it('does NOT report when statusComponentIds is ALSO set — even against the real dual-config shape (scalar incidentIoComponentId)', async () => {
    // Real shape (not the synthetic list `multiIoConfig()` defaults to): every live dual-configured
    // service has `incidentIoComponentId` as a SCALAR member of `statusComponentIds` (not always
    // index 0 — langsmith's is index 1), which is exactly the shape a list-shaped fixture cannot
    // exercise faithfully — see the file header and the `#957` comment in services.ts.
    const config = multiIoConfig({
      statusComponentIds: ['id-a', 'id-b'],
      statusComponentId: 'id-a',
      incidentIoComponentId: 'id-a', // real shape: scalar, a member of statusComponentIds
    })
    const { kv, puts } = fakeKv()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html></html>', { status: 200 })))

    await fetchService(
      config,
      // breakdownComponents (summary.json) sees BOTH ids — the badge-side block finds no drift.
      // The incident.io HTML only carries id-a's data_available_since — id-b is missing THERE, a real
      // uptime-side drift the badge-side block cannot see and this gate deliberately does not report.
      { summary: summary(['id-a', 'id-b']) as never, incidents: null, latency: 100, uptimeHtml: ioPageHtml(['id-a']) } as never,
      kv as never,
      {},
    )

    expect(puts.find((p) => p.key === 'component-partial:test-multi-io')).toBeUndefined()
  })
})
