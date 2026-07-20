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

/** The single recorded data point's blobs: [source, 'active'|'clear', svcId]. */
function recordedBlobs(writeDataPoint: ReturnType<typeof vi.fn>): string[] {
  expect(writeDataPoint).toHaveBeenCalledTimes(1)
  return writeDataPoint.mock.calls[0][0].blobs
}
const recordedSource = (w: ReturnType<typeof vi.fn>): string => recordedBlobs(w)[0]

describe('POST /api/pageview → recorded source bucket (#1055 wiring)', () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

  it('records a Reddit referrer as the reddit bucket, not direct — with the active flag and svc', async () => {
    const { env, writeDataPoint } = makeEnv()
    const res = await workerModule.fetch(post({ svc: 'claude', ref: 'www.reddit.com', utm: '', active: true }), env, ctx)
    expect(res.status).toBe(204)
    // All three blobs, not just the source: the handler passes `active` and `svc` as separate
    // arguments to recordOutageView, and a unit test calling that fn directly cannot see a bad
    // argument at the CALL SITE. `activeTotal` is the sponsor-evidence number, so a dropped `active`
    // would silently collapse it to zero.
    expect(recordedBlobs(writeDataPoint)).toEqual(['reddit', 'active', 'claude'])
  })

  it('records a self-referral (our own is-down cross-links) as owned, not refhost (#1055)', async () => {
    const { env, writeDataPoint } = makeEnv()
    await workerModule.fetch(post({ svc: 'openai', ref: 'ai-watch.dev', utm: '', active: false }), env, ctx)
    expect(recordedBlobs(writeDataPoint)).toEqual(['owned', 'clear', 'openai'])
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
