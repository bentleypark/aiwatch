import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchAllServices } from '../services'
import { TEST_TIMEOUT_MS, mockKV, seededTracking, stubFetchFailingClaudePage, probeFixture } from './helpers/unreadable-source'

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
// the branch of the cross-validation each lands in is the only thing that differs between the cases.

// The harness (the failing-page fetch stub, the tracking seed, the probe fixture and the margins each
// one rests on) lives in `./helpers/unreadable-source` — shared with the #1232 operational-leak
// invariant, which needs the identical premise.

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
    expect(claude?.status).toBe('unknown')
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

    // #1233 — this assertion now carries weight it did not before. The unreadable-source verdict is
    // `unknown`; a failing probe is what PROMOTES it back to a real `degraded`, in the worker, so no
    // surface has to read `probeContradicted` to reach the same conclusion. Before #1233 the value was
    // `degraded` either way and only the flag distinguished the two cases — which is exactly why three
    // surfaces got it wrong. The pair above/below is the both-directions pin on that promotion.
    expect(claude?.status).toBe('degraded')
    expect(claude?.probeContradicted).toBe(true)
  }, TEST_TIMEOUT_MS)
})
