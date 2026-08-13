import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import workerModule, { shouldPersistSnapshot } from '../index'
import { CACHE_READ_INDEX, type CacheReadOutcome } from '../api-traffic'
import type { ServiceStatus } from '../types'

// #1227 — WIRING tests: these drive the real `workerModule.fetch`, not the pure builders.
//
// The pure builders were fully unit-tested and every mutation to them was caught, yet the review's
// mutation battery restored the down handler to its literal pre-fix code and the whole suite stayed
// green — because no test drove the statusline ROUTES. The bug was an HTTP status on the wire, and
// the wire was what nothing touched (the repo's recurring "순수fn 초록 ≠ 배선 초록" failure).
//
// Following `badge.test.ts` (#1157), which exists for the same reason and drives the route with a
// fake KV, rather than the weaker `cached-response.test.ts` simulate-the-dispatch pattern.
//
// The KV modes below cover every way `cacheRead` can end, so one table covers both the response
// wiring AND the outcome classification that lives in `cacheRead` itself.

type KvMode = 'null' | 'throws' | 'unparsed' | 'nonObject' | 'missingServices' | 'empty' | 'populated' | 'noBinding'

/** A realistic snapshot: the shape `cacheWrite` actually persists ({services, upstreamFeeds, cachedAt}). */
const SNAPSHOT = {
  cachedAt: '2026-08-13T02:52:50.000Z',
  upstreamFeeds: [],
  services: [
    { id: 'mistral', name: 'Mistral API', provider: 'Mistral AI', category: 'api', status: 'degraded', incidents: [] },
    { id: 'openai', name: 'OpenAI API', provider: 'OpenAI', category: 'api', status: 'operational', incidents: [] },
  ] as unknown as ServiceStatus[],
}

const ALL_OPERATIONAL = {
  ...SNAPSHOT,
  services: [SNAPSHOT.services[1]] as unknown as ServiceStatus[],
}

function makeEnv(mode: KvMode, snapshot: unknown = SNAPSHOT) {
  const writeDataPoint = vi.fn()
  const kv = {
    get: vi.fn(async (key: string) => {
      if (key !== 'services:latest') return null
      switch (mode) {
        case 'null': return null
        case 'throws': throw new Error('KV read failed')
        case 'unparsed': return '{not json'
        case 'nonObject': return '42'
        case 'missingServices': return JSON.stringify({ cachedAt: SNAPSHOT.cachedAt })
        case 'empty': return JSON.stringify({ services: [], upstreamFeeds: [], cachedAt: SNAPSHOT.cachedAt })
        case 'populated': return JSON.stringify(snapshot)
      }
    }),
    put: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
  }
  return {
    writeDataPoint,
    kv,
    env: {
      STATUS_CACHE: mode === 'noBinding' ? undefined : kv,
      ANALYTICS: { writeDataPoint },
    } as unknown as Parameters<typeof workerModule.fetch>[1],
  }
}

const get = (env: Parameters<typeof workerModule.fetch>[1], path: string, ctx: Partial<ExecutionContext> = {}) =>
  workerModule.fetch(new Request(`https://ai-watch.dev${path}`), env, ctx as ExecutionContext)

/** ext-claude is the one surface that writes its response into `caches.default`, so it needs the
 *  global stubbed to be drivable at all — and the stub is also what lets us assert the PUT never
 *  happens on a no-snapshot answer (the regression that branch exists to prevent). */
function stubCaches() {
  const put = vi.fn(async () => undefined)
  ;(globalThis as unknown as { caches: unknown }).caches = {
    default: { match: async () => undefined, put },
  }
  return put
}

/** The blob1 values recorded on the CACHE_READ_INDEX during this request. */
function outcomesRecorded(writeDataPoint: ReturnType<typeof vi.fn>): CacheReadOutcome[] {
  return writeDataPoint.mock.calls
    .map((c) => c[0])
    .filter((p) => p?.indexes?.[0] === CACHE_READ_INDEX)
    .map((p) => p.blobs[0])
}

// Every mode in which there is no usable snapshot. The whole point of #1227 is that these are
// indistinguishable to a consumer from "everything is fine" unless the wire says otherwise.
const NO_SNAPSHOT_MODES: Array<[KvMode, CacheReadOutcome]> = [
  ['null', 'miss'],
  ['throws', 'threw'],
  ['unparsed', 'unparsed'],
  ['nonObject', 'unparsed'],
  ['missingServices', 'unparsed'],
  ['empty', 'empty'],
  ['noBinding', 'no-binding'],
]

describe('#1227 wiring — no usable snapshot must never render as healthy', () => {
  describe('GET /api/statusline/down (the plugin monitor)', () => {
    it.each(NO_SNAPSHOT_MODES)('%s → 503 + no-store, so `curl -sf` fails and the monitor holds its set', async (mode) => {
      const { env } = makeEnv(mode)
      const res = await get(env, '/api/statusline/down')
      expect(res.status).toBe(503)
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    })

    it('a populated snapshot still lists the affected services at 200', async () => {
      const { env } = makeEnv('populated')
      const res = await get(env, '/api/statusline/down')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('degraded\tMistral API')
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=30')
    })

    it('an all-operational snapshot keeps the EMPTY 200 — the real all-clear must stay reachable', async () => {
      const { env } = makeEnv('populated', ALL_OPERATIONAL)
      const res = await get(env, '/api/statusline/down')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('')
    })
  })

  describe('GET /api/statusline/brief (the /aiwatch command)', () => {
    it.each(NO_SNAPSHOT_MODES)('%s → the unknown briefing, never the all-clear claim', async (mode) => {
      const { env } = makeEnv(mode)
      const res = await get(env, '/api/statusline/brief')
      const body = await res.text()
      expect(res.status).toBe(200) // 200 on purpose: a 503 makes the plugin blame "(network error)"
      expect(body).toContain('unknown')
      expect(body).not.toContain('all monitored AI services operational')
      expect(body).not.toContain('✅')
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    })

    it('a populated snapshot still briefs the affected service', async () => {
      const { env } = makeEnv('populated')
      const body = await (await get(env, '/api/statusline/brief')).text()
      expect(body).toContain('Mistral API')
    })
  })

  describe('GET /api/statusline/:preset (the server-rendered snippets)', () => {
    it.each(NO_SNAPSHOT_MODES)('%s → branded shows ⚪, never the healthy 🟢', async (mode) => {
      const { env } = makeEnv(mode)
      const res = await get(env, '/api/statusline/branded')
      const body = await res.text()
      expect(res.status).toBe(200) // 200 on purpose: a 503 blanks the line via `curl -sf … || true`
      expect(body).toContain('⚪')
      expect(body).not.toContain('🟢')
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    })

    it('a populated snapshot still renders the affected service', async () => {
      const { env } = makeEnv('populated')
      const body = await (await get(env, '/api/statusline/branded')).text()
      expect(body).toContain('Mistral API')
      expect(body).not.toContain('⚪')
    })

    it('an all-operational snapshot still shows the healthy 🟢 — ⚪ must mean UNKNOWN, not "quiet"', async () => {
      const { env } = makeEnv('populated', ALL_OPERATIONAL)
      const body = await (await get(env, '/api/statusline/branded')).text()
      expect(body).toContain('🟢')
      expect(body).not.toContain('⚪')
    })

    it('an unknown preset is still 404, ahead of any snapshot read', async () => {
      const { env, kv } = makeEnv('populated')
      expect((await get(env, '/api/statusline/not_a_preset')).status).toBe(404)
      expect(kv.get).not.toHaveBeenCalled()
    })
  })

  describe('GET /api/status/cached?src=statusline-* (the frozen pre-#918 jq installs)', () => {
    it.each(NO_SNAPSHOT_MODES)('%s → 503, so the frozen jq blanks instead of printing "AIWatch 🟢"', async (mode) => {
      const { env } = makeEnv(mode)
      const res = await get(env, '/api/status/cached?src=statusline-branded')
      expect(res.status).toBe(503)
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    })

    it('a populated snapshot still returns the lite projection at 200', async () => {
      const { env } = makeEnv('populated')
      const res = await get(env, '/api/status/cached?src=statusline-branded')
      expect(res.status).toBe(200)
      const body = await res.json() as { services: Array<{ id: string }> }
      expect(body.services.map((s) => s.id)).toEqual(['mistral', 'openai'])
    })
  })

  describe('GET /api/status/cached?src=ext-claude (the Chrome extension)', () => {
    it.each(NO_SNAPSHOT_MODES)('%s → 503, and the no-evidence answer is NOT edge-cached', async (mode) => {
      const put = stubCaches()
      const { env } = makeEnv(mode)
      const res = await get(env, '/api/status/cached?src=ext-claude')
      expect(res.status).toBe(503)
      expect(res.headers.get('Cache-Control')).toBe('no-store')
      // The branch's whole point: a 60s `s-maxage` entry would pin this answer per-PoP for a minute
      // after the snapshot returns, and the `cache.match` short-circuit serves it without re-reading.
      expect(put).not.toHaveBeenCalled()
    })

    it('a populated snapshot still serves the Claude projection at 200', async () => {
      stubCaches()
      const { env } = makeEnv('populated')
      const res = await get(env, '/api/status/cached?src=ext-claude', { waitUntil: () => {} })
      expect(res.status).toBe(200)
      expect(res.headers.get('Cache-Control')).toContain('s-maxage=60')
    })
  })

  describe('GET /api/v1/status (the documented public API)', () => {
    it.each(NO_SNAPSHOT_MODES)('%s → 503, never a 200 asserting an empty roster', async (mode) => {
      const { env } = makeEnv(mode)
      expect((await get(env, '/api/v1/status')).status).toBe(503)
    })
  })

  describe('GET /badge/:id', () => {
    it.each(NO_SNAPSHOT_MODES)('%s → "unknown", not a 404 "not found" for a service we monitor', async (mode) => {
      const { env, writeDataPoint } = makeEnv(mode)
      const res = await get(env, '/badge/mistral')
      expect(res.status).toBe(503)
      expect(res.headers.get('Cache-Control')).toBe('no-store')
      expect(await res.text()).toContain('unknown')
      // The read failure is ours; booking it as an unknown-service embed pollutes the #1157 signal.
      const badgeCalls = writeDataPoint.mock.calls.filter((c) => c[0]?.indexes?.[0] === 'badge-request')
      expect(badgeCalls).toHaveLength(0)
    })

    it('a genuinely unknown service id is still a 404 "not found"', async () => {
      const { env } = makeEnv('populated')
      const res = await get(env, '/badge/totally-made-up-svc')
      expect(res.status).toBe(404)
      expect(await res.text()).toContain('not found')
    })
  })
})

// The outcome split is what makes the NEXT incident diagnosable. It lives inside `cacheRead`,
// which is not exported — so the route is the only way to prove the right label is recorded.
describe('#1227 wiring — cacheRead books the right outcome', () => {
  it.each(NO_SNAPSHOT_MODES)('%s is recorded as "%s" on the shared cache-read index', async (mode, expected) => {
    const { env, writeDataPoint } = makeEnv(mode)
    await get(env, '/api/statusline/down')
    expect(outcomesRecorded(writeDataPoint)).toEqual([expected])
  })

  it('records NOTHING when the snapshot is healthy — a quiet worker writes no failure points', async () => {
    const { env, writeDataPoint } = makeEnv('populated')
    await get(env, '/api/statusline/down')
    expect(outcomesRecorded(writeDataPoint)).toEqual([])
  })

  it('survives an absent ANALYTICS binding without changing the response', async () => {
    const { env } = makeEnv('null')
    const noWae = { ...env, ANALYTICS: undefined } as unknown as Parameters<typeof workerModule.fetch>[1]
    expect((await get(noWae, '/api/statusline/down')).status).toBe(503)
  })
})

// The write-side guard. A guard's default is to pass, so it has to be mutated against itself: the
// `>= 0` slip below refuses EVERY write, which after #1227 turned every read surface fail-loud would
// be a total outage with a green suite.
describe('#1227 shouldPersistSnapshot — the write-side guard', () => {
  const svc = (id: string) => ({ id, name: id, provider: 'p', category: 'api', status: 'operational', incidents: [] } as unknown as ServiceStatus)

  it('refuses an empty roster', () => {
    expect(shouldPersistSnapshot([])).toBe(false)
  })

  it('permits any non-empty roster — a `>= 0` slip here would refuse every write', () => {
    expect(shouldPersistSnapshot([svc('mistral')])).toBe(true)
    expect(shouldPersistSnapshot(Array.from({ length: 45 }, (_, i) => svc(`s${i}`)))).toBe(true)
  })
})

// Source scans, in the `badge-wiring.test.ts` idiom: two couplings this fix depends on that no
// behavioural test can reach. Verify either by DELETING the scanned text, never by commenting it
// out — a scan looking for a substring is satisfied by a comment.
describe('#1227 source-scan guards', () => {
  const read = (...seg: string[]) => readFileSync(join(__dirname, '..', '..', '..', ...seg), 'utf8')

  // The down-list's 503 only prevents a false recovery because the monitor's curl FAILS on it.
  // Drop `-f` (or move to `--fail-with-body`) and the 503 body becomes the poll result: `cut -f2`
  // parses "no status snapshot available" as a service name and the next good poll emits
  // `✅ <name> has recovered` for everything still down — #1227, reproduced, with the worker green.
  it('the plugin monitor still fetches with `curl -sf`', () => {
    const sh = read('plugin', 'aiwatch', 'bin', 'aiwatch-monitor.sh')
    expect(sh).toContain('curl -sf')
    expect(sh).not.toContain('--fail-with-body')
  })

  // The brief is served as a 200 precisely BECAUSE this script prints its own "(network error)"
  // line on a non-2xx. If that changes, the 200 choice needs revisiting.
  it('the /aiwatch script still fetches with `curl -sf` and has its own failure line', () => {
    const sh = read('plugin', 'aiwatch', 'bin', 'aiwatch-status.sh')
    expect(sh).toContain('curl -sf')
    expect(sh).toContain('status unavailable')
  })

  // `analytics` being a REQUIRED parameter enumerates the call sites once, at the signature change;
  // it does not stop a later caller passing the legal value `undefined` and going dark. This scan
  // covers direct invocations only — passing `cacheRead` itself as a 1-arg reader is caught by
  // `typecheck:worker`, not here.
  it('no cacheRead call passes `undefined` for analytics', () => {
    const src = read('worker', 'src', 'index.ts')
    // Every INVOCATION threads a real analytics binding. Deliberately not a count — an arithmetic
    // offset for the definition and the adapter closure would break on unrelated edits and teach
    // the next author to bump the number rather than look.
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    const invocations = code.match(/(?<!function )cacheRead\([^)]*\)/g) ?? []
    expect(invocations.length).toBeGreaterThan(5)
    // Only the negative property, deliberately. Anchoring on `env.ANALYTICS)$` also fires on
    // formatting-only edits (a parenthesised argument, a prettier multi-line call), and a guard that
    // reddens CI for no defect teaches the next author to loosen it.
    for (const call of invocations) expect(call).not.toMatch(/undefined/)
  })
})
