// Shared harness for driving `fetchAllServices` with a status page we CANNOT read.
//
// Extracted at its second copy (#1232): `probe-contradicted-wiring.test.ts` (#1230) built this to
// prove the `probeContradicted` wiring, and the operational-leak invariant needs the identical
// premise — an unreadable source on a PROBED service — with different tracking seeds and probe
// samples. Two copies of a stub whose margins are this load-bearing (see `HEALTHY_SUMMARY`) drift
// apart silently.
//
// NOT a `*.test.ts` file on purpose: `worker/vitest.config.ts` collects `src/**/*.test.ts`, so a
// helper named this way is imported, never collected as an empty suite.
import { vi } from 'vitest'
import type { ProbeSnapshot } from '../../probe'

export const TEST_TIMEOUT_MS = 30_000

/** A benign Atlassian Statuspage summary for every service whose page is NOT status.claude.com, so the
 *  platform-quorum phase (70%+ of one platform degraded → hold everything operational) cannot fire and
 *  take the subject out of the `degradedFromFetch` set before the probe phase runs. Note the margin
 *  does not rest on the stub alone: `claudeai`/`claudecode` share the failing page, but whichever seed
 *  helper the caller uses, only `claude` is ever driven into `degraded` — and `detectPlatformOutage`
 *  needs `total >= 3` with `degraded/total >= 0.7`, which one service can never reach in any group
 *  large enough to be evaluated. A parser that rejects this shape likewise stops at
 *  failCount 1. */
export const HEALTHY_SUMMARY = {
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: [], incidents: [], scheduled_maintenances: [],
}

export function mockKV(seed: Record<string, string> = {}) {
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
export function seededTracking(ids: string[]) {
  const at = new Date().toISOString()
  const blob: Record<string, unknown> = {}
  for (const id of ids) blob[id] = { failCount: 2, failCountAt: at }
  return { 'tracking:state': JSON.stringify(blob) }
}

/** Seed the blob as it looks MID-OUTAGE, one decay window after the crossing (#1232): the count is at
 *  the threshold, `failCountAt` stopped being refreshed there (the `next <= threshold` write gate), and
 *  `failSince` records that no successful fetch has happened since. This is the state the re-climb loop
 *  passes through every cycle — the count decays to 0 from here, so the count alone says "first
 *  failure" about a source that has been unreadable for hours. */
export function decayedTracking(ids: string[]) {
  const now = Date.now()
  const blob: Record<string, unknown> = {}
  for (const id of ids) {
    blob[id] = {
      failCount: 3,
      failCountAt: new Date(now - 31 * 60_000).toISOString(), // past TRACKING_COUNT_DECAY_MS (30 min)
      failSince: new Date(now - 2 * 3_600_000).toISOString(),
    }
  }
  return { 'tracking:state': JSON.stringify(blob) }
}

/** fetch where the Anthropic status page answers a DEAD-SOURCE 4xx (#689 — a deactivated page), so the
 *  service is published `operational` + `sourceDead` and only the probe can corroborate reachability. */
export function stubFetchDeadClaudePage() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (url.includes('status.claude.com')) return new Response('page inactive', { status: 401 })
    return new Response(JSON.stringify(HEALTHY_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
}

/** fetch that fails ONLY for the Anthropic status page — everything else answers healthy. */
export function stubFetchFailingClaudePage() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (url.includes('status.claude.com')) throw new Error('TLS: cert does not match host')
    return new Response(JSON.stringify(HEALTHY_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
}

/** The Anthropic status page answers 5xx (the provider is having a bad day) — everything else healthy.
 *  Distinct from `stubFetchFailingClaudePage`, which THROWS and therefore only ever reaches
 *  `fetchService`'s outer catch. The 5xx branch is a separate return path (#714) and, being the way a
 *  struggling provider actually fails, the more likely one in production. */
export function stubFetch5xxClaudePage() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (url.includes('status.claude.com')) return new Response('upstream error', { status: 503 })
    return new Response(JSON.stringify(HEALTHY_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
}

// Timestamps are built INSIDE each test, so a sample's age cannot depend on collection order or on
// how long the suite ran before reaching this file. (Reviewers saw intermittent reds here during a
// session in which other agents were mutating this tree; that is NOT established as the cause, and
// this refactor is not a fix for it. If the flake returns, start the search fresh.)
export function probeFixture(recent: Array<{ minAgo: number; status: number; rtt: number }>): ProbeSnapshot[] {
  const now = Date.now()
  const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString()
  // Oldest first, like production (`index.ts` pushes each slot and `trimSnapshots` keeps the tail), so
  // a consumer that reads `snapshots[length - 1]` for "this cycle" gets the newest sample here too.
  return [
    // Median-bearing history at 67ms, outside the recent window, so it feeds the median only.
    ...Array.from({ length: 6 }, (_, i) => ({ t: at(45 - i * 5), data: { claude: { status: 200, rtt: 67 } } })),
    ...[...recent].sort((a, b) => b.minAgo - a.minAgo).map((r) => ({ t: at(r.minAgo), data: { claude: { status: r.status, rtt: r.rtt } } })),
  ]
}
