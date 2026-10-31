import { afterEach, describe, expect, it, vi } from 'vitest'
import workerModule from '../index'
import { CACHE_KEY } from '../services'
import { HEALTHY_SUMMARY, TEST_TIMEOUT_MS } from './helpers/unreadable-source'

const BASELINE = { n: 12, medianMin: 40, p80Min: 90, since: '2026-07-12' }
const ACCURACY = { total: 32, accurate: 12, overPredicted: 14, underPredicted: 6, since: '2026-09-01' }

function env(store: Map<string, string>) {
  return {
    STATUS_CACHE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v) },
      delete: async (k: string) => { store.delete(k) },
      list: async () => ({ keys: [], list_complete: true }),
    },
    ANALYTICS: { writeDataPoint: () => {} },
    ALLOWED_ORIGIN: '*',
  } as unknown as Parameters<typeof workerModule.fetch>[1]
}

async function pollLive(recoveryValue?: unknown) {
  const store = new Map<string, string>([[CACHE_KEY, JSON.stringify({
    services: [{ id: 'claude', name: 'Claude API', status: 'operational', incidents: [], lastChecked: new Date(Date.now() - 60_000).toISOString() }],
    upstreamFeeds: [],
    cachedAt: new Date(Date.now() - 60_000).toISOString(),
  })]])
  if (recoveryValue !== undefined) store.set('incident:recovery-baseline', JSON.stringify(recoveryValue))
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException: () => {} } as unknown as ExecutionContext
  const res = await workerModule.fetch(new Request('https://aiwatch.test/api/status'), env(store), ctx)
  const body = await res.json() as Record<string, unknown>
  await Promise.all(pending)
  return body
}

// The dashboard loads /api/status/cached once and then polls this route every 60 s, replacing its state
// from each response, so a figure missing here disappears from the Analyze modal after the first poll.
describe('/api/status (live) carries the recovery figures the dashboard polls for', () => {
  afterEach(() => vi.unstubAllGlobals())

  const healthy = () => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(HEALTHY_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } })))

  it('emits the service baselines and the estimate accuracy from the one KV value', async () => {
    healthy()
    const body = await pollLive({ claude: BASELINE, _estimateAccuracy: ACCURACY })
    expect(body.recoveryBaseline).toEqual({ claude: BASELINE })
    expect(body.estimateAccuracy).toEqual(ACCURACY)
  }, TEST_TIMEOUT_MS)

  it('emits only the baselines for a value written before the figure existed', async () => {
    healthy()
    const body = await pollLive({ claude: BASELINE })
    expect(body.recoveryBaseline).toEqual({ claude: BASELINE })
    expect(body).not.toHaveProperty('estimateAccuracy')
  }, TEST_TIMEOUT_MS)

  it('emits neither key when there is no value', async () => {
    healthy()
    const body = await pollLive()
    expect(body).not.toHaveProperty('recoveryBaseline')
    expect(body).not.toHaveProperty('estimateAccuracy')
  }, TEST_TIMEOUT_MS)
})
