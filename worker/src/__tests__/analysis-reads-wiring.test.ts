import { describe, it, expect, vi, beforeEach } from 'vitest'
import workerModule from '../index'

// #1772 — WIRING: drives the real routes with a fake KV (the statusline-wiring.test.ts harness), so a
// dropped context argument or a wrong live-analysis gate in index.ts fails here, not only in the pure fns.

const NOW = Date.now()
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()
const inc = (id: string, o: Record<string, unknown> = {}) =>
  ({ id, title: `T ${id}`, status: 'investigating', impact: 'major', startedAt: iso(90), duration: null, timeline: [], ...o })
const analysis = (incidentId: string, o: Record<string, unknown> = {}) => ({
  summary: `S ${incidentId}.`, progress: 'P.', estimatedRecovery: '4–8h', estimatedRecoveryHours: 8,
  affectedScope: ['X'], needsFallback: false, analyzedAt: iso(5), incidentId, model: 'gemma', ...o,
})
const svc = (id: string, name: string, category: string, incidents: unknown[]) =>
  ({ id, name, provider: 'Anthropic', category, status: 'operational', incidents })

const BASELINE = { claude: { n: 48, medianMin: 64, p80Min: 161, since: '2026-07-22' } }
const KV: Record<string, unknown> = {
  'services:latest': {
    cachedAt: iso(1),
    upstreamFeeds: [],
    services: [
      // A live analysed incident: its surface's recently resolved one stays hidden.
      svc('claude', 'Claude API', 'api', [inc('live'), inc('done1', { status: 'resolved', resolvedAt: iso(30) })]),
      // No live incident: the recently resolved one is shown.
      svc('claudeai', 'claude.ai', 'app', [inc('done2', { status: 'resolved', resolvedAt: iso(30) })]),
      svc('claudecode', 'Claude Code', 'agent', []),
    ],
  },
  'ai:analysis:claude:live': analysis('live'),
  'ai:analysis:claude:done1': analysis('done1', { resolvedAt: iso(30) }),
  'ai:analysis:claudeai:done2': analysis('done2', { resolvedAt: iso(30), firstEstimatedRecoveryHours: 1 }),
  'incident:recovery-baseline': BASELINE,
}

function env() {
  const kv = {
    get: vi.fn(async (key: string) => (key in KV ? JSON.stringify(KV[key]) : null)),
    put: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
  }
  return { STATUS_CACHE: kv, ANALYTICS: { writeDataPoint: vi.fn() }, ALLOWED_ORIGIN: '*' } as unknown as Parameters<typeof workerModule.fetch>[1]
}
const get = async (path: string) => {
  const res = await workerModule.fetch(new Request(`https://ai-watch.dev${path}`), env(), { waitUntil: () => {} } as unknown as ExecutionContext)
  expect(res.status).toBe(200)
  return res.json() as Promise<any>
}

beforeEach(() => {
  ;(globalThis as unknown as { caches: unknown }).caches = { default: { match: async () => undefined, put: async () => undefined } }
})

describe('#1772 wiring — /api/status/cached?src=ext-claude', () => {
  it('carries the analysis lines, the baselines, and only the recently resolved incidents the modal shows', async () => {
    const body = await get('/api/status/cached?src=ext-claude')
    const by = Object.fromEntries(body.services.map((s: any) => [s.id, s]))
    expect(by.claude.incidents[0].ai.lines).toEqual(['⏱ Est. Recovery: 4–8h', '📡 Scope: X'])
    expect(by.claude.recoveryBaseline).toEqual(BASELINE.claude)
    expect(by.claudeai.recoveryBaseline).toBeNull()
    expect(by.claude.recentlyResolved).toEqual([])
    expect(by.claudeai.recentlyResolved.map((i: any) => i.id)).toEqual(['done2'])
    expect(by.claudeai.recentlyResolved[0].ai.lines[0]).toMatch(/^🎯 Predicted vs actual: est ~1h · actual 1h/)
  })
})

describe('#1772 wiring — /api/status/cached (the dashboard modal)', () => {
  it('reads the recently resolved analysis only for a service with no live analysis', async () => {
    const body = await get('/api/status/cached')
    expect(body.aiAnalysis.claude.map((a: any) => a.incidentId)).toEqual(['live'])
    expect(body.aiAnalysis.claudeai.map((a: any) => a.incidentId)).toEqual(['done2'])
  })
})
