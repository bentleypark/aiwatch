import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchAllServices } from '../services'
import type { ProbeSnapshot } from '../probe'

// The WIRED half of the `probeContradicted` guard.
//
// `probe.test.ts` pins `isProbeFailing` as a pure function, but that is not where the flag is set —
// `services.ts` sets `svc.probeContradicted = true` inside `fetchAllServices`' probe cross-validation,
// and nothing asserted on it. Round-1 review proved the gap by mutation: neutering the production call
// to `} else if (false && isProbeFailing(...))` left the whole worker suite green. That is exactly the
// `debugging_fix_the_called_path_not_the_tested_twin` shape — and `junie-migration.test.ts` claimed in
// prose to be the guard against it while only calling the pure fn.
//
// So these drive the real entry point end to end: a status page we cannot read (fetch throws → the
// #714 `sourceUnknown` + three-strike `degraded`) on a PROBED service, with probe snapshots chosen so
// the two branches of the cross-validation are the only thing that differs between the cases.

const TEST_TIMEOUT_MS = 30_000

// A benign Atlassian Statuspage summary for every service whose page is NOT status.claude.com, so the
// platform-quorum phase (70%+ of one platform degraded → hold everything operational) cannot fire and
// take this test's subject out of the `degradedFromFetch` set before the probe phase runs. Note the
// margin does not rest on the stub alone: `claudeai`/`claudecode` share the failing page, but only
// `claude` is seeded to its third strike, so exactly ONE service in the group reaches `degraded` —
// and `detectPlatformOutage` needs `total >= 3` with `degraded/total >= 0.7`, which one service can
// never reach in any group large enough to be evaluated. A parser that rejects this shape likewise
// stops at failCount 1.
const HEALTHY_SUMMARY = {
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: [], incidents: [], scheduled_maintenances: [],
}

function mockKV(seed: Record<string, string> = {}) {
  const store: Record<string, string> = { ...seed }
  return {
    store,
    get: vi.fn(async (k: string) => store[k] ?? null),
    put: vi.fn(async (k: string, v: string) => { store[k] = v }),
    delete: vi.fn(async (k: string) => { delete store[k] }),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: undefined })),
  }
}

/** Seed the consolidated tracking blob so the NEXT failure is the third strike — `trackFetchFailure`
 *  returns `shouldDegrade` at `next >= 3`, so one `fetchAllServices` call lands on the fallback. */
function seededTracking(ids: string[]) {
  const at = new Date().toISOString()
  const blob: Record<string, unknown> = {}
  for (const id of ids) blob[id] = { failCount: 2, failCountAt: at }
  return { 'tracking:state': JSON.stringify(blob) }
}

/** fetch that fails ONLY for the Anthropic status page — everything else answers healthy. */
function stubFetchFailingClaudePage() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (url.includes('status.claude.com')) throw new Error('TLS: cert does not match host')
    return new Response(JSON.stringify(HEALTHY_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
}

// Timestamps are built INSIDE each test, so a sample's age cannot depend on collection order or on
// how long the suite ran before reaching this file. (Reviewers saw intermittent reds here during a
// session in which other agents were mutating this tree; that is NOT established as the cause, and
// this refactor is not a fix for it. If the flake returns, start the search fresh.)
function probeFixture(recent: Array<{ minAgo: number; status: number; rtt: number }>): ProbeSnapshot[] {
  const now = Date.now()
  const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString()
  return [
    ...recent.map((r) => ({ t: at(r.minAgo), data: { claude: { status: r.status, rtt: r.rtt } } })),
    // Median-bearing history at 67ms, outside the recent window, so it feeds the median only.
    ...Array.from({ length: 6 }, (_, i) => ({ t: at(20 + i * 5), data: { claude: { status: 200, rtt: 67 } } })),
  ]
}

afterEach(() => { vi.unstubAllGlobals() })

describe('probeContradicted is set from fetchAllServices, and the floor governs it there', () => {
  it('does NOT contradict when the unreadable source is paired with mere probe jitter', async () => {
    stubFetchFailingClaudePage()
    const kv = mockKV(seededTracking(['claude']))
    const jitter = probeFixture([
      { minAgo: 0, status: 200, rtt: 230 },
      { minAgo: 5, status: 200, rtt: 210 },
    ])

    const { raw } = await fetchAllServices(kv as unknown as KVNamespace, jitter)
    const claude = raw.find((s) => s.id === 'claude')

    // The premise: we genuinely could not read the page, so this IS the fetch-failure fallback.
    expect(claude?.status).toBe('degraded')
    expect(claude?.sourceUnknown).toBe(true)
    // The behaviour under test: nothing corroborates an outage, so the neutral badge is NOT suppressed.
    expect(claude?.probeContradicted).toBeFalsy()
  }, TEST_TIMEOUT_MS)

  it('DOES contradict when the probe is genuinely failing', async () => {
    stubFetchFailingClaudePage()
    const kv = mockKV(seededTracking(['claude']))
    const failing = probeFixture([
      { minAgo: 0, status: 0, rtt: -1 },
      { minAgo: 5, status: 0, rtt: -1 },
    ])

    const { raw } = await fetchAllServices(kv as unknown as KVNamespace, failing)
    const claude = raw.find((s) => s.id === 'claude')

    expect(claude?.status).toBe('degraded')
    expect(claude?.probeContradicted).toBe(true)
  }, TEST_TIMEOUT_MS)
})
