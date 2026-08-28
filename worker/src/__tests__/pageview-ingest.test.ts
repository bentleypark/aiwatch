// #1055 — wiring test for POST /api/pageview.
//
// Why this exists as a HANDLER test and not more unit tests: `classifyReferrer` and
// `parsePageviewBody` are already pure + covered in outage-audience.test.ts, but green pure
// functions do NOT prove the bucket reaches storage — the endpoint returns 204 with an empty body,
// so a curl against a local worker shows nothing either way, and the WAE binding is absent locally.
// The only observable is the `writeDataPoint` blob, so we assert on that: real Request → route →
// parse → classify → blob1. Without this, a future refactor could drop the classifier from the
// handler and every existing test would stay green (memory: fix-the-called-path-not-the-tested-twin).

import { describe, it, expect, vi } from 'vitest'
import workerModule from '../index'

const ORIGIN = 'https://ai-watch.dev'

function makeEnv() {
  const writeDataPoint = vi.fn()
  return {
    writeDataPoint,
    env: {
      ALLOWED_ORIGIN: ORIGIN,
      ANALYTICS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    } as never,
  }
}

function post(body: unknown): Request {
  return new Request('https://worker.example/api/pageview', {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** The single recorded data point's blobs: [source, 'active'|'clear', svcId, surface]. */
function recordedBlobs(writeDataPoint: ReturnType<typeof vi.fn>): string[] {
  expect(writeDataPoint).toHaveBeenCalledTimes(1)
  return writeDataPoint.mock.calls[0][0].blobs
}
const recordedSource = (w: ReturnType<typeof vi.fn>): string => recordedBlobs(w)[0]

describe('POST /api/pageview → recorded source bucket (#1055 wiring)', () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

  it('records a Reddit referrer as the reddit bucket, not direct — with the active flag and svc', async () => {
    const { env, writeDataPoint } = makeEnv()
    const res = await workerModule.fetch(post({ svc: 'claude', ref: 'www.reddit.com', utm: '', active: true, surface: 'service' }), env, ctx)
    expect(res.status).toBe(204)
    // All three blobs, not just the source: the handler passes `active` and `svc` as separate
    // arguments to recordOutageView, and a unit test calling that fn directly cannot see a bad
    // argument at the CALL SITE. `activeTotal` is the sponsor-evidence number, so a dropped `active`
    // would silently collapse it to zero. #1280 added `surface` as a fourth argument with exactly the
    // same exposure — it is the one dimension that separates a group-page view from a per-service one.
    expect(recordedBlobs(writeDataPoint)).toEqual(['reddit', 'active', 'claude', 'service'])
  })

  it('records a self-referral (our own is-down cross-links) as owned, not refhost (#1055)', async () => {
    const { env, writeDataPoint } = makeEnv()
    await workerModule.fetch(post({ svc: 'openai', ref: 'ai-watch.dev', utm: '', active: false, surface: 'service' }), env, ctx)
    expect(recordedBlobs(writeDataPoint)).toEqual(['owned', 'clear', 'openai', 'service'])
  })

  // #1280 — the surface dimension, asserted at the CALL SITE. A unit test of parsePageviewBody or
  // recordOutageView cannot see the handler dropping the field between them, and that failure is
  // invisible in production: every view still lands, just all on one surface, which reads as a
  // plausible number rather than as an error.
  it('records a group-page view as the group surface, keeping the member id it reported', async () => {
    const { env, writeDataPoint } = makeEnv()
    // A family page posts the WORST-OF member's id by design (api/is-down-group.ts), so this row is
    // indistinguishable from a view of claudecode's own page without blob4.
    await workerModule.fetch(post({ svc: 'claudecode', ref: '', utm: 'x', active: true, surface: 'group' }), env, ctx)
    expect(recordedBlobs(writeDataPoint)).toEqual(['x', 'active', 'claudecode', 'group'])
  })

  it('records a body with NO surface as unknown, never as service (the deploy window)', async () => {
    const { env, writeDataPoint } = makeEnv()
    // is-down is edge-cached, so pre-deploy HTML keeps posting this shape for a while. The view must
    // still be counted — dropping it would render the deploy window as a traffic dip — but it must
    // not be attributed, because folding it into `service` under-reports the group surface in exactly
    // the direction of the bug #1280 exists to fix.
    await workerModule.fetch(post({ svc: 'claude', ref: '', utm: 'x', active: false }), env, ctx)
    expect(recordedBlobs(writeDataPoint)).toEqual(['x', 'clear', 'claude', 'unknown'])
  })

  it('records a junk surface as unknown rather than trusting or rejecting it', async () => {
    const { env, writeDataPoint } = makeEnv()
    // /api/pageview is public, so the surface is caller-controlled. It collapses to a fixed sentinel,
    // which is what keeps blob4's cardinality bounded.
    await workerModule.fetch(post({ svc: 'claude', ref: '', utm: 'x', active: false, surface: 'haxx' }), env, ctx)
    expect(recordedBlobs(writeDataPoint)).toEqual(['x', 'clear', 'claude', 'unknown'])
  })

  it('records an unnamed referring host as refhost', async () => {
    const { env, writeDataPoint } = makeEnv()
    await workerModule.fetch(post({ svc: 'claude', ref: 'some-blog.example', utm: '', active: false }), env, ctx)
    expect(recordedSource(writeDataPoint)).toBe('refhost')
  })

  it('still records a referrer-less view as direct', async () => {
    const { env, writeDataPoint } = makeEnv()
    await workerModule.fetch(post({ svc: 'claude', ref: '', utm: '', active: false }), env, ctx)
    expect(recordedSource(writeDataPoint)).toBe('direct')
  })

  it('rejects an unknown service id without recording (public endpoint abuse guard)', async () => {
    const { env, writeDataPoint } = makeEnv()
    const res = await workerModule.fetch(post({ svc: 'not-a-service', ref: 'www.reddit.com', active: true }), env, ctx)
    expect(res.status).toBe(400)
    expect(writeDataPoint).not.toHaveBeenCalled()
  })

  it('rejects a disallowed Origin without recording', async () => {
    const { env, writeDataPoint } = makeEnv()
    const req = new Request('https://worker.example/api/pageview', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ svc: 'claude', ref: 'www.reddit.com', active: true }),
    })
    const res = await workerModule.fetch(req, env, ctx)
    expect(res.status).toBe(403)
    expect(writeDataPoint).not.toHaveBeenCalled()
  })
})
