import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchAllServices } from '../services'
import type { ServiceStatus } from '../types'
import { TEST_TIMEOUT_MS, HEALTHY_SUMMARY, mockKV, seededTracking, decayedTracking, stubFetchFailingClaudePage, stubFetch5xxClaudePage, stubFetchDeadClaudePage, probeFixture } from './helpers/unreadable-source'

// #1232 — ONE invariant, two independent paths that broke it:
//
//   a source we could not read must not be published `operational` on the strength of the read
//   failure alone.
//
// Asserted on `raw` — what `CACHE_KEY` (is-down, badge, statusline) is written from. `/api/status`
// serves `enriched`, where a pre-existing one-poll cache smoothing can substitute a cached operational
// record (#1235). Since #1233 that smoothing keys on `degraded`, so an unreadable source no longer
// enters it — but a probe-CORROBORATED one still does, because the cross-validation promotes it to
// `degraded` before the smoothing runs. #1235 is unchanged by this file either way; it pins `raw`.
//
// Part 1: `trackFetchFailure`'s count decays 30 min after the crossing that froze its timestamp, so a
// still-unreadable source re-published `operational` in a loop.
// Part 2: `isProbeHealthy` judged a sample on RTT alone, so a fast 5xx counted as an all-clear and
// `services.ts`' cross-validation force-flipped the service to `operational`.
//
// Both are asserted through the real `fetchAllServices` entry point, not the pure predicates: #1230
// established by mutation that a pure-fn test does not pin the production path (the whole worker suite
// stayed green with the wired call neutered). Each case has a control that must NOT change, so the fix
// is pinned in both directions.
//
// The SCOPE of the invariant is worth stating, because one `operational` + `sourceUnknown` pair is
// deliberate and stays: the three-strike ramp before the first crossing (the first two failed polls of
// a source that may just be blipping). The `still ramps` control below pins it — the fix must not make
// a single failed read sticky.

afterEach(() => { vi.unstubAllGlobals() })

/** The published verdict for the unreadable service, from the real orchestrator. */
async function claudeAfterFetch(kv: ReturnType<typeof mockKV>, probes?: ReturnType<typeof probeFixture>): Promise<ServiceStatus | undefined> {
  const { raw } = await fetchAllServices(kv as unknown as KVNamespace, probes)
  return raw.find((s) => s.id === 'claude')
}

describe('#1232 Part 1 — a sustained fetch failure does not decay back to green', () => {
  it('stays unknown one decay window past the crossing, while the source is still unreadable', async () => {
    stubFetchFailingClaudePage()
    // Mid-outage: crossed hours ago, `failCountAt` frozen at the crossing and now past the 30-min
    // decay window. The count therefore reads as "first failure" this cycle — which is exactly what
    // used to publish green with `sourceUnknown` still set.
    const kv = mockKV(decayedTracking(['claude']))

    const claude = await claudeAfterFetch(kv)

    // `sourceUnknown` is the premise (our read failed); the published verdict is the behaviour under
    // test. #1233 moved that verdict from `degraded` to `unknown` — the invariant is unchanged (neither
    // is `operational`), and `unknown` states it without asserting an outage we cannot evidence.
    expect({ status: claude?.status, sourceUnknown: claude?.sourceUnknown }).toEqual({ status: 'unknown', sourceUnknown: true })
  }, TEST_TIMEOUT_MS)

  it('still ramps: a first failed read does NOT publish a verdict on its own (three-strike gate intact)', async () => {
    stubFetchFailingClaudePage()
    const kv = mockKV() // no prior state — this is strike 1

    const claude = await claudeAfterFetch(kv)

    expect(claude?.sourceUnknown).toBe(true)
    expect(claude?.status).toBe('operational')
  }, TEST_TIMEOUT_MS)

  it('recovers: a successful read clears the pin, so the NEXT failure ramps again instead of publishing', async () => {
    stubFetchFailingClaudePage()
    const kv = mockKV(decayedTracking(['claude']))
    expect((await claudeAfterFetch(kv))?.status).toBe('unknown')

    // Same KV throughout — each call reads the tracking blob the previous one wrote back.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(HEALTHY_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const recovered = await claudeAfterFetch(kv)
    expect(recovered?.status).toBe('operational')
    expect(recovered?.sourceUnknown).toBeFalsy()

    // The third call is what makes the recovery meaningful: the Atlassian success path never consults
    // `shouldDegrade` (it derives status from the parsed payload), so only a FAILING read afterwards can
    // show the pin was released. Neutering `resetFetchFailure` at its `services.ts` call sites reddens
    // this case — the one covering the statuspage leg; the others are `bad-read-legs`' azure/bedrock.
    stubFetchFailingClaudePage()
    const afterRecovery = await claudeAfterFetch(kv)
    expect(afterRecovery?.status).toBe('operational') // strike 1 of a fresh ramp, not a pinned degrade
    expect(afterRecovery?.sourceUnknown).toBe(true)
  }, TEST_TIMEOUT_MS)

  it('a FROZEN failSince does not degrade on strike 1 — the pin is gated on failCountAt liveness', async () => {
    stubFetchFailingClaudePage()
    // The #689 dead-source / flashduty-feed shape: the service crossed long ago, then its path stopped
    // calling trackFetchFailure and resetFetchFailure entirely, so `failCountAt` froze with it. Without
    // the liveness gate this single failed read would publish `degraded` for the rest of that source's
    // life; with it, the three-strike ramp is intact.
    const now = Date.now()
    const frozen = {
      'tracking:state': JSON.stringify({
        claude: {
          failCount: 3,
          failCountAt: new Date(now - 90 * 60_000).toISOString(), // past TRACKING_ALERT_STALE_MS (60 min)
          failSince: new Date(now - 30 * 3_600_000).toISOString(),
        },
      }),
    }

    const claude = await claudeAfterFetch(mockKV(frozen))

    expect(claude?.sourceUnknown).toBe(true)
    expect(claude?.status).toBe('operational')
  }, TEST_TIMEOUT_MS)
})

// #1233 — the SUMMARY-5xx leg, which every test above misses. `stubFetchFailingClaudePage` throws, so
// the whole #1232/#1233 claude corpus exercises `fetchService`'s outer catch; the 5xx branch is its own
// return path and is the way a provider under load actually fails. Mutating that line back to
// `degraded` was green across all 4350 tests before this case existed.
describe('#1233 — a status page answering 5xx publishes the same unreadable verdict', () => {
  it('crosses to unknown, not degraded', async () => {
    stubFetch5xxClaudePage()
    const claude = await claudeAfterFetch(mockKV(seededTracking(['claude'])))
    expect({ status: claude?.status, sourceUnknown: claude?.sourceUnknown })
      .toEqual({ status: 'unknown', sourceUnknown: true })
    // #1233 invariant — an unreadable source carries NO incident. Several modules omit an `unknown`
    // branch because of this (the X drafts, the feed's fallback line, the region/calendar fallbacks).
    expect(claude?.incidents).toEqual([])
  }, TEST_TIMEOUT_MS)

  it('control: under the threshold it still ramps rather than publishing a verdict', async () => {
    stubFetch5xxClaudePage()
    const claude = await claudeAfterFetch(mockKV())
    expect(claude?.status).toBe('operational')
    expect(claude?.sourceUnknown).toBe(true)
  }, TEST_TIMEOUT_MS)
})

describe('#1232 Part 2 — a fast 5xx probe is not an all-clear', () => {
  it('does not force operational when the probe answers 503 inside the RTT bar', async () => {
    stubFetchFailingClaudePage()
    const kv = mockKV(seededTracking(['claude']))
    // 80ms against a 67ms median — comfortably inside `median × 3`, so RTT alone reads as healthy.
    const fast5xx = probeFixture([
      { minAgo: 0, status: 503, rtt: 80 },
      { minAgo: 5, status: 503, rtt: 80 },
    ])

    const claude = await claudeAfterFetch(kv, fast5xx)

    // Not amber either — `isProbeFailing` is untouched and reads RTT only, so 80ms sits under its
    // floor. Whether an error response should instead raise the badge to amber is the open follow-up
    // on #1232; this change only stops it counting as an all-clear.
    expect({ status: claude?.status, sourceUnknown: claude?.sourceUnknown, probeContradicted: claude?.probeContradicted })
      .toEqual({ status: 'unknown', sourceUnknown: true, probeContradicted: undefined })
  }, TEST_TIMEOUT_MS)

  it('still cross-validates: a fast 2xx probe holds the service operational (#507 unchanged)', async () => {
    stubFetchFailingClaudePage()
    const kv = mockKV(seededTracking(['claude']))
    const fast2xx = probeFixture([
      { minAgo: 0, status: 200, rtt: 80 },
      { minAgo: 5, status: 200, rtt: 80 },
    ])

    const claude = await claudeAfterFetch(kv, fast2xx)

    expect(claude?.status).toBe('operational')
  }, TEST_TIMEOUT_MS)

  it('still cross-validates: an unauthenticated 4xx counts as healthy — the bar is >= 500, not non-2xx', async () => {
    stubFetchFailingClaudePage()
    const kv = mockKV(seededTracking(['claude']))
    const unauth = probeFixture([
      { minAgo: 0, status: 401, rtt: 80 },
      { minAgo: 5, status: 403, rtt: 80 },
    ])

    const claude = await claudeAfterFetch(kv, unauth)

    expect(claude?.status).toBe('operational')
  }, TEST_TIMEOUT_MS)

  // The predicate's second wired consumer (#689): a service whose status PAGE is gone is published
  // `operational`, and `probeConfirmed` is the only thing that says anything corroborates it.
  it('withholds probeConfirmed on a dead source when the probe answers 5xx', async () => {
    stubFetchDeadClaudePage()
    const claude = await claudeAfterFetch(mockKV(), probeFixture([
      { minAgo: 0, status: 503, rtt: 80 },
      { minAgo: 5, status: 503, rtt: 80 },
    ]))

    expect(claude?.sourceDead).toBe(true)
    expect(claude?.probeConfirmed).toBeFalsy()
  }, TEST_TIMEOUT_MS)

  it('still marks probeConfirmed on a dead source when the probe answers 2xx', async () => {
    stubFetchDeadClaudePage()
    const claude = await claudeAfterFetch(mockKV(), probeFixture([
      { minAgo: 0, status: 200, rtt: 80 },
      { minAgo: 5, status: 200, rtt: 80 },
    ]))

    expect(claude?.sourceDead).toBe(true)
    expect(claude?.probeConfirmed).toBe(true)
  }, TEST_TIMEOUT_MS)
})
