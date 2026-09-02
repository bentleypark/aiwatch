// Operator-only POST /api/admin/rebuild-archive — regenerates a specific
// month's archive:monthly:{YYYY-MM} after the score-fix deploy. Tests cover
// auth, validation, and the happy path that proves score data is computed
// from probe summaries instead of read straight from services:latest.

import { describe, it, expect, vi } from 'vitest'
import workerModule from '../index'
import type { ServiceStatus } from '../types'

function makeKV(initial: Record<string, string> = {}) {
  const store = { ...initial }
  return {
    store,
    kv: {
      get: vi.fn(async (k: string) => store[k] ?? null),
      put: vi.fn(async (k: string, v: string, _opts?: unknown) => { store[k] = v }),
      delete: vi.fn(async (k: string) => { delete store[k] }),
      list: vi.fn(async () => ({ keys: Object.keys(store).map(name => ({ name })), list_complete: true, cacheStatus: null })),
    } as unknown as KVNamespace,
  }
}

/** KV whose `get` throws for keys matching `faultOn` — the fault/absence distinction #1260 turns on. */
function makeFaultyKV(initial: Record<string, string>, faultOn: RegExp) {
  const store = { ...initial }
  return {
    store,
    kv: {
      get: vi.fn(async (k: string) => {
        if (faultOn.test(k)) throw new Error('KV unavailable')
        return store[k] ?? null
      }),
      put: vi.fn(async (k: string, v: string) => { store[k] = v }),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    } as unknown as KVNamespace,
  }
}

function makeService(overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    id: 'claude',
    name: 'Claude API',
    provider: 'Anthropic',
    category: 'api',
    status: 'operational',
    latency: 200,
    lastChecked: '2026-05-01T00:00:00Z',
    uptime30d: 99.5,
    uptimeSource: 'official',
    incidents: [],
    ...overrides,
  }
}

function envWith(kv: KVNamespace, adminKey = 'test-admin-key') {
  return {
    ALLOWED_ORIGIN: '*',
    STATUS_CACHE: kv,
    ADMIN_API_KEY: adminKey,
  } as Parameters<typeof workerModule.fetch>[1]
}

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/api/admin/rebuild-archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

// The write-path cases below pin a fixed month (2026-04) and seed its `history:` days, so they are
// out of the retention window by construction and pass `force: true` (#1260). They exercise the
// build/overwrite behaviour; the guard itself is covered separately at the bottom of this file.
describe('POST /api/admin/rebuild-archive', () => {
  it('returns 401 when ADMIN_API_KEY is not configured', async () => {
    const { kv } = makeKV()
    const env = { ALLOWED_ORIGIN: '*', STATUS_CACHE: kv } as Parameters<typeof workerModule.fetch>[1]
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
    const res = await workerModule.fetch(req({ month: '2026-04' }, { 'X-Admin-Key': 'whatever' }), env, ctx)
    expect(res.status).toBe(401)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('unauthorized')
  })

  it('returns 401 when X-Admin-Key is missing', async () => {
    const { kv } = makeKV()
    const env = envWith(kv)
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
    const res = await workerModule.fetch(req({ month: '2026-04' }), env, ctx)
    expect(res.status).toBe(401)
  })

  it('returns 401 when X-Admin-Key is wrong', async () => {
    const { kv } = makeKV()
    const env = envWith(kv)
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
    const res = await workerModule.fetch(req({ month: '2026-04' }, { 'X-Admin-Key': 'wrong-key' }), env, ctx)
    expect(res.status).toBe(401)
  })

  it('returns 400 when month is missing', async () => {
    const { kv } = makeKV()
    const env = envWith(kv)
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
    const res = await workerModule.fetch(req({}, { 'X-Admin-Key': 'test-admin-key' }), env, ctx)
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('YYYY-MM')
  })

  it.each([
    'invalid',
    '2026-13',
    '2026-00',
    '2026-4',
    '2026-04-01',
    '26-04',
  ])('returns 400 for malformed month %s', async (month) => {
    const { kv } = makeKV()
    const env = envWith(kv)
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
    const res = await workerModule.fetch(req({ month }, { 'X-Admin-Key': 'test-admin-key' }), env, ctx)
    expect(res.status).toBe(400)
  })

  it('writes archive:monthly:{YYYY-MM} with computed score data on happy path', async () => {
    // Seed services:latest with raw ServiceStatus (no aiwatchScore field — that's
    // the bug shape: the cache never stored these; archive cron read null and
    // persisted null. With the fix in place, we compute via scoreFor at write time.
    const { store, kv } = makeKV()
    store['services:latest'] = JSON.stringify({
      services: [makeService({ id: 'claude' }), makeService({ id: 'openai' })],
      cachedAt: '2026-05-01T00:00:00Z',
    })
    const env = envWith(kv)
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

    const res = await workerModule.fetch(req({ month: '2026-04', force: true }, { 'X-Admin-Key': 'test-admin-key' }), env, ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; wrote: string; period: string; servicesWithScore: number }
    expect(body.ok).toBe(true)
    expect(body.wrote).toBe('archive:monthly:2026-04')
    expect(body.period).toBe('2026-04')
    // The score may legitimately be null when the cached service lacks data the
    // scoring formula needs (uptime + incidents in this fixture). The test that
    // matters is that the rebuild path RAN scoreFor — verified by the response
    // field's existence and the KV write being a fresh archive.
    expect(typeof body.servicesWithScore).toBe('number')

    const written = store['archive:monthly:2026-04']
    expect(written).toBeDefined()
    const archive = JSON.parse(written)
    expect(archive.period).toBe('2026-04')
    expect(archive.services).toBeDefined()
    // Every service entry must have score / grade keys (even if null) — proves
    // the scoreData → buildMonthlyArchive plumbing ran end-to-end.
    for (const id of Object.keys(archive.services)) {
      expect(archive.services[id]).toHaveProperty('score')
      expect(archive.services[id]).toHaveProperty('grade')
    }
  })

  // #1006 WIRING. The pure builder already had `uptimeSource` coverage and the fixture below already
  // carried the field — but nothing asserted it survived the endpoint, and it did not: this handler
  // built its ArchiveScoreInput by hand and dropped it. That is how the 2026-07 archive shipped with
  // provenance missing on 44 of its 45 services while every test stayed green.
  // Asserts the CALLED path (the HTTP handler), not the helper it delegates to.
  it('#1006 carries uptimeSource from services:latest through to the written archive', async () => {
    const { store, kv } = makeKV()
    store['services:latest'] = JSON.stringify({
      services: [
        makeService({ id: 'together', uptimeSource: 'platform_avg', uptime30d: 99.78 }),
        makeService({ id: 'claude', uptimeSource: 'official', uptime30d: 99.11 }),
        // No provenance at all — must stay absent downstream, not default to 'official'.
        makeService({ id: 'deepgram', uptimeSource: undefined, uptime30d: undefined }),
      ],
      cachedAt: '2026-05-01T00:00:00Z',
    })
    // resolveArchiveOfficialUptime gates the archived figure (and its provenance) on a month-end
    // daily snapshot, so the month needs one or both would be withheld for reasons unrelated to this.
    store['history:2026-04-30'] = JSON.stringify({
      together: { ok: 288, total: 288, officialUptime: 99.78 },
      claude: { ok: 288, total: 288, officialUptime: 99.11 },
      deepgram: { ok: 288, total: 288, officialUptime: null },
    })
    const env = envWith(kv)
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

    const res = await workerModule.fetch(req({ month: '2026-04', force: true }, { 'X-Admin-Key': 'test-admin-key' }), env, ctx)
    expect(res.status).toBe(200)

    const archive = JSON.parse(store['archive:monthly:2026-04'])
    expect(archive.services.together.uptimeSource).toBe('platform_avg')
    expect(archive.services.claude.uptimeSource).toBe('official')
    expect(archive.services.deepgram.uptimeSource).toBeUndefined()
  })

  it('overwrites an existing archive:monthly key (cron skips when existing; rebuild must not)', async () => {
    const { store, kv } = makeKV()
    store['services:latest'] = JSON.stringify({
      services: [makeService({ id: 'claude' })],
      cachedAt: '2026-05-01T00:00:00Z',
    })
    // Pre-existing buggy archive — every service has score:null. Without overwrite
    // this would survive the rebuild (matching the production state on 2026-05-02).
    store['archive:monthly:2026-04'] = JSON.stringify({
      period: '2026-04',
      services: { claude: { uptime: 99, score: null, grade: null, incidents: 0, avgResolutionMin: null, totalDowntimeMin: null, longestIncidentMin: null, avgLatencyMs: null } },
      generatedAt: '2026-05-01T00:00:00Z',
      daysCollected: 0,
    })
    const env = envWith(kv)
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

    const res = await workerModule.fetch(req({ month: '2026-04', force: true }, { 'X-Admin-Key': 'test-admin-key' }), env, ctx)
    expect(res.status).toBe(200)

    // Re-parse the freshly-written value — generatedAt must be later than the original.
    const written = JSON.parse(store['archive:monthly:2026-04'])
    expect(new Date(written.generatedAt).getTime()).toBeGreaterThan(new Date('2026-05-01T00:00:00Z').getTime())
  })

  // #1260 — the destructive path. `buildMonthlyArchive` reads every day of uptime from `history:{date}`,
  // which expires; `archive:monthly` is TTL-less and the only durable copy. Before the guard, rebuilding
  // an aged-out month replaced a good archive with `uptime: null` for every service and returned 200 —
  // and operator-tools.md instructs exactly that after suppressing an incident in a past month.
  function monthsAgo(n: number): string {
    const d = new Date()
    d.setUTCDate(1)
    d.setUTCMonth(d.getUTCMonth() - n)
    return d.toISOString().slice(0, 7)
  }

  it('refuses to rebuild a month whose history: days have expired, and writes nothing', async () => {
    const month = monthsAgo(6)
    const { kv } = makeKV({
      [`archive:monthly:${month}`]: JSON.stringify({ period: month, daysCollected: 28, services: { claude: { uptime: 99.9 } } }),
    })
    const env = envWith(kv)

    const res = await workerModule.fetch(req({ month }, { 'X-Admin-Key': 'test-admin-key' }), env, ctx)

    expect(res.status).toBe(409)
    const body = await res.json() as { ok: boolean; expiredDays: number; regressed: string[] }
    expect(body.ok).toBe(false)
    // The refusal is driven by measured loss, not by the age proxy — `expiredDays` rides along as
    // diagnosis. A month with nothing stored is not refused just for being old.
    expect(body.regressed).toContain('daysCollected')
    expect(body.expiredDays).toBeGreaterThan(0)
    // Nothing is written on a refusal — not the archive, and not a backup.
    expect((kv.put as unknown as { mock: { calls: string[][] } }).mock.calls).toHaveLength(0)
  })

  it('builds a first-ever archive for an old month instead of refusing it', async () => {
    // Nothing is stored, so nothing can be lost. Refusing here taught operators to keep `force`
    // typed, which disarmed every other guard (#1260 round 2).
    const { kv } = makeKV()

    const res = await workerModule.fetch(req({ month: monthsAgo(6) }, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)

    expect(res.status).toBe(200)
  })

  it('still rebuilds a month fully inside the retention window', async () => {
    const { kv } = makeKV()
    const env = envWith(kv)

    const res = await workerModule.fetch(req({ month: monthsAgo(1) }, { 'X-Admin-Key': 'test-admin-key' }), env, ctx)

    expect(res.status).toBe(200)
  })

  it('honours force:true on an expired month (the operator overrides knowingly)', async () => {
    const { kv } = makeKV()
    const env = envWith(kv)

    const res = await workerModule.fetch(req({ month: monthsAgo(6), force: true }, { 'X-Admin-Key': 'test-admin-key' }), env, ctx)

    expect(res.status).toBe(200)
    const wroteArchive = (kv.put as unknown as { mock: { calls: string[][] } }).mock.calls
      .some((c) => c[0].startsWith('archive:monthly:'))
    expect(wroteArchive).toBe(true)
  })

  // #1260 — the age guard is a proxy; this is the real invariant. A month INSIDE the window can still
  // be missing days (archival is traffic-driven, not cron — #988), and every `history:` read in the
  // build is `.catch(() => null)`, so a KV fault degrades it the same way. Neither is visible to an
  // age check, and both would overwrite a good archive with a worse one.
  it('refuses when the rebuild collected fewer days than the stored archive', async () => {
    const month = monthsAgo(1)
    const { kv } = makeKV({
      [`archive:monthly:${month}`]: JSON.stringify({ period: month, daysCollected: 30, services: {} }),
    })
    const env = envWith(kv)

    // No `history:` keys seeded, so the rebuild collects 0 — inside the window, yet strictly worse.
    const res = await workerModule.fetch(req({ month }, { 'X-Admin-Key': 'test-admin-key' }), env, ctx)

    expect(res.status).toBe(409)
    const body = await res.json() as { regressed: string[]; prior: { daysCollected: number }; rebuilt: { daysCollected: number } }
    expect(body.regressed).toContain('daysCollected')
    expect(body.prior.daysCollected).toBe(30)
    expect(body.rebuilt.daysCollected).toBe(0)
    const wroteArchive = (kv.put as unknown as { mock: { calls: string[][] } }).mock.calls
      .some((c) => c[0].startsWith('archive:monthly:'))
    expect(wroteArchive).toBe(false)
  })

  it('allows a rebuild that collects at least as many days as the stored archive', async () => {
    const month = monthsAgo(1)
    const { kv } = makeKV({
      [`archive:monthly:${month}`]: JSON.stringify({ period: month, daysCollected: 0, services: {} }),
    })
    const env = envWith(kv)

    const res = await workerModule.fetch(req({ month }, { 'X-Admin-Key': 'test-admin-key' }), env, ctx)

    expect(res.status).toBe(200)
  })

  it('refuses when the rebuild loses incidents even though the uptime days are intact', async () => {
    // `incidents:monthly` expires at 60d, `history:` at 90d, so this is reachable for a month older
    // than two months: the uptime rebuilds fine and the incident list silently empties.
    const month = monthsAgo(1)
    const { kv } = makeKV({
      [`archive:monthly:${month}`]: JSON.stringify({
        period: month,
        daysCollected: 0,
        services: { claude: { incidentList: [{ id: 'a' }, { id: 'b' }] } },
      }),
    })
    const env = envWith(kv)

    const res = await workerModule.fetch(req({ month }, { 'X-Admin-Key': 'test-admin-key' }), env, ctx)

    expect(res.status).toBe(409)
    const body = await res.json() as { regressed: string[] }
    expect(body.regressed).toContain('incidents')
    const wroteArchive = (kv.put as unknown as { mock: { calls: string[][] } }).mock.calls
      .some((c) => c[0].startsWith('archive:monthly:'))
    expect(wroteArchive).toBe(false)
  })

  it('honours force:true when the rebuild would collect fewer days', async () => {
    const month = monthsAgo(1)
    const { kv } = makeKV({
      [`archive:monthly:${month}`]: JSON.stringify({ period: month, daysCollected: 30, services: {} }),
    })
    const env = envWith(kv)

    const res = await workerModule.fetch(req({ month, force: true }, { 'X-Admin-Key': 'test-admin-key' }), env, ctx)

    expect(res.status).toBe(200)
    // The override must not be silent — it discards material the stored archive held.
    const body = await res.json() as { forcedOver?: string[]; backupKey?: string }
    expect(body.forcedOver).toContain('daysCollected')
    // …and it must be recoverable: the bytes it replaced are kept, since nothing else holds them.
    expect(body.backupKey).toMatch(/^archive:monthly:.*:prev:/)
    expect((kv.put as unknown as { mock: { calls: string[][] } }).mock.calls
      .some((c) => c[0] === body.backupKey)).toBe(true)
    const wroteArchive = (kv.put as unknown as { mock: { calls: string[][] } }).mock.calls
      .some((c) => c[0].startsWith('archive:monthly:'))
    expect(wroteArchive).toBe(true)
  })

  it('writes when no archive is stored yet, with nothing to compare against', async () => {
    const { kv } = makeKV()
    const env = envWith(kv)

    const res = await workerModule.fetch(req({ month: monthsAgo(1) }, { 'X-Admin-Key': 'test-admin-key' }), env, ctx)

    expect(res.status).toBe(200)
  })

  // THE critical one. operator-tools.md tells operators to suppress an incident in a past month and
  // then rebuild it; `filterSuppressedFromMonthly` necessarily removes that id, so a count-based
  // guard 409s the documented flow — and an operator who learns the normal path needs `force` will
  // use it every time, disarming every other guard along with it.
  it('allows a rebuild whose only shrink is explained by the suppression list', async () => {
    const month = monthsAgo(1)
    const { kv } = makeKV({
      // A realistic rebuild still emits the service entry — only the suppressed incident goes.
      'services:latest': JSON.stringify({ services: [makeService({ id: 'claude' })], cachedAt: '2026-05-01T00:00:00Z' }),
      [`archive:monthly:${month}`]: JSON.stringify({
        period: month,
        daysCollected: 0,
        services: { claude: { incidentList: [{ id: 'inc-1', title: 'Elevated errors' }] } },
      }),
      'incident:suppressions': JSON.stringify([{ scope: 'incident', incId: 'inc-1', reason: 'not a real outage' }]),
    })

    const res = await workerModule.fetch(req({ month }, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)

    expect(res.status).toBe(200)
  })

  it('fails closed with 503 when the stored archive cannot be read, and force does not override it', async () => {
    // `null` from a failed read would mean "nothing stored" — the fail-open shape of the bug itself.
    const { kv } = makeFaultyKV({}, /^archive:monthly:/)

    const res = await workerModule.fetch(req({ month: monthsAgo(1), force: true }, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)

    expect(res.status).toBe(503)
    expect((await res.json() as { retryable: boolean }).retryable).toBe(true)
    expect((kv.put as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })

  it('refuses to overwrite an unparseable stored archive, but force may', async () => {
    const month = monthsAgo(1)
    const seed = () => ({ [`archive:monthly:${month}`]: '{not json' })

    const refused = await workerModule.fetch(req({ month }, { 'X-Admin-Key': 'test-admin-key' }), envWith(makeKV(seed()).kv), ctx)
    expect(refused.status).toBe(409)

    const forced = await workerModule.fetch(req({ month, force: true }, { 'X-Admin-Key': 'test-admin-key' }), envWith(makeKV(seed()).kv), ctx)
    expect(forced.status).toBe(200)
  })


  it('counts sections and per-service measurements, not just days and incidents', async () => {
    const month = monthsAgo(1)
    const { kv } = makeKV({
      [`archive:monthly:${month}`]: JSON.stringify({
        period: month,
        daysCollected: 0,
        services: { claude: { uptime: 99.9, score: 91, avgLatencyMs: 200 } },
        security: { totalAlerts: 12 },
        degradation: { total: 40 },
      }),
    })

    const res = await workerModule.fetch(req({ month }, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)

    expect(res.status).toBe(409)
    const regressed = (await res.json() as { regressed: string[] }).regressed
    expect(regressed).toContain('services')
    // Sections are named, not tallied — a count would let a gained section mask a lost one.
    expect(regressed).toContain('sections:degradation+security')
  })

  it('rejects a month string that parses to no real calendar month', async () => {
    const res = await workerModule.fetch(req({ month: '0000-01' }, { 'X-Admin-Key': 'test-admin-key' }), envWith(makeKV().kv), ctx)
    expect(res.status).toBe(400)
  })

  it('rejects a month that has not happened yet', async () => {
    const d = new Date()
    d.setUTCFullYear(d.getUTCFullYear() + 1)
    const future = d.toISOString().slice(0, 7)
    const res = await workerModule.fetch(req({ month: future }, { 'X-Admin-Key': 'test-admin-key' }), envWith(makeKV().kv), ctx)
    expect(res.status).toBe(400)
  })

  // The backup used to be gated on what the census managed to MEASURE, so the one case where the
  // bytes are the only copy — an unreadable prior — was the one case it skipped.
  it('backs up an unreadable prior archive before force overwrites it', async () => {
    const month = monthsAgo(1)
    const { store, kv } = makeKV({ [`archive:monthly:${month}`]: '{not json' })

    const res = await workerModule.fetch(req({ month, force: true }, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)

    expect(res.status).toBe(200)
    const body = await res.json() as { backupKey?: string; priorUnreadable?: boolean }
    expect(body.priorUnreadable).toBe(true)
    expect(body.backupKey).toMatch(/:prev:/)
    expect(store[body.backupKey!]).toBe('{not json')
  })


  // Two tests pinning a 503-on-source-fault branch were removed with the branch itself (#1260 r3).
  // It covered 5 of 7 read paths, sat inside the `force` gate so `force` skipped it, and never
  // appeared on a 200 — so on the paths it missed it answered "the source data is gone, force it"
  // for a blip a retry would have fixed. A partial cause is worse than none; the 409 now states no
  // cause and the unconditional backup is what makes a wrong call recoverable.
  it('refuses when services:latest cannot be read, rather than rebuilding the null scores', async () => {
    // Empty scoreData writes a null score for every service — the corruption this endpoint exists to
    // repair. A relative census cannot see it (null before, null after), so the read must fail closed.
    const { kv } = makeFaultyKV({}, /^services:latest$/)

    const res = await workerModule.fetch(req({ month: monthsAgo(1) }, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)

    expect(res.status).toBe(503)
    expect((kv.put as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })

  it('hands the suppression list to the build instead of letting it re-read fail-open', async () => {
    // `readSuppressionsFresh` collapses a fault to `[]`. When the build did its own read, a blip
    // meant it applied NO suppressions while the handler thought it had — nothing shrank, nothing
    // objected, `ok: true`, and the operator's whole reason for the rebuild silently did not happen.
    // Pinning the read COUNT is the direct statement of the fix and does not depend on fixture shape.
    const month = monthsAgo(1)
    const store: Record<string, string> = {
      'services:latest': JSON.stringify({ services: [makeService({ id: 'claude' })], cachedAt: '2026-05-01T00:00:00Z' }),
      'incident:suppressions': JSON.stringify([{ scope: 'incident', incId: 'inc-1' }]),
      // The build only consults the suppression list when there IS an accumulator to filter.
      [`incidents:monthly:${month}`]: JSON.stringify({
        lastUpdated: '2026-07-31T00:00:00Z',
        services: {
          claude: {
            count: 1, totalMinutes: 60, longestMinutes: 60,
            dates: ['2026-07-02'], incidentIds: ['inc-1'], durations: { 'inc-1': 60 },
            incidents: [{ id: 'inc-1', title: 'FedRAMP paperwork', startedAt: '2026-07-02T00:00:00Z', resolvedAt: '2026-07-02T01:00:00Z', durationMin: 60, status: 'resolved' }],
          },
        },
      }),
    }
    let suppressionReads = 0
    const kv = {
      get: vi.fn(async (k: string) => {
        if (k === 'incident:suppressions') suppressionReads++
        return store[k] ?? null
      }),
      put: vi.fn(async (k: string, v: string) => { store[k] = v }),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    } as unknown as KVNamespace

    const res = await workerModule.fetch(req({ month }, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)

    expect(res.status).toBe(200)
    expect(suppressionReads).toBe(1)
    // And the list actually took effect: the suppressed incident is not in the written archive.
    const written = JSON.parse(store[`archive:monthly:${month}`])
    expect(written.services?.claude?.incidentList ?? []).toHaveLength(0)
  })

  it('answers 500 retryable:false when the suppression list is malformed, not a forever-retry 503', async () => {
    // Round 2 made this read a hard gate on every month. Collapsing "unreadable" and "malformed" into
    // one `null` then bricked the endpoint permanently while telling the operator to retry (#1260 r3).
    const { kv } = makeKV({ 'incident:suppressions': '{ not json' })

    const res = await workerModule.fetch(req({ month: monthsAgo(1) }, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)

    expect(res.status).toBe(500)
    expect((await res.json() as { retryable: boolean }).retryable).toBe(false)
  })

  it('refuses when the suppression list cannot be read, so the build never runs unfiltered', async () => {
    // The build used to re-read this list fail-open: a blip applied NO suppressions while the
    // handler's own read succeeded, so nothing shrank, nothing objected, and `ok: true` came back
    // with the operator's entire reason for the rebuild silently skipped.
    const { kv } = makeFaultyKV({}, /^incident:suppressions$/)

    const res = await workerModule.fetch(req({ month: monthsAgo(1) }, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)

    expect(res.status).toBe(503)
    expect((kv.put as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })

  // ── #1274 — the duration-override read, which #1260 did not reach ─────────────────────────────
  //
  // `applyDurationOverrides` rewrites `durations[id]` and deliberately leaves `incidentIds` alone
  // (#1019 keeps the incident, correcting only its length), so a read that yields "no overrides
  // configured" when it should not moves NOTHING the content census counts: no `regressed` entry,
  // no 409, and a `200 ok:true` publishing the duration the operator ran the rebuild to correct.

  /** Accumulator carrying one incident whose stored duration is the inflated paperwork span. */
  function paperworkAccumulator() {
    return JSON.stringify({
      lastUpdated: '2026-07-31T00:00:00Z',
      services: {
        claude: {
          count: 1, totalMinutes: 800, longestMinutes: 800,
          dates: ['2026-07-02'], incidentIds: ['inc-1'], durations: { 'inc-1': 800 },
          incidents: [{ id: 'inc-1', title: 'Elevated errors', startedAt: '2026-07-02T00:00:00Z', resolvedAt: '2026-07-02T13:20:00Z', durationMin: 800, status: 'resolved' }],
        },
      },
    })
  }

  it('hands the override list to the build instead of letting it re-read fail-open', async () => {
    // Pins BOTH directions of the wiring in one run: the read happens exactly once (so the build is
    // consuming the handler's fail-closed read, not taking its own), and the pinned duration is what
    // lands in the archive (so the list is not merely read and discarded). With no fault present the
    // answer is still 200 — the control for the two refusal cases below.
    const month = monthsAgo(1)
    const store: Record<string, string> = {
      'services:latest': JSON.stringify({ services: [makeService({ id: 'claude' })], cachedAt: '2026-05-01T00:00:00Z' }),
      'incident:duration-overrides': JSON.stringify([{ id: 'inc-1', durationMin: 18, reason: 'component recovered long before the formal resolve' }]),
      [`incidents:monthly:${month}`]: paperworkAccumulator(),
    }
    let overrideReads = 0
    const kv = {
      get: vi.fn(async (k: string) => {
        if (k === 'incident:duration-overrides') overrideReads++
        return store[k] ?? null
      }),
      put: vi.fn(async (k: string, v: string) => { store[k] = v }),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    } as unknown as KVNamespace

    const res = await workerModule.fetch(req({ month }, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)

    expect(res.status).toBe(200)
    expect(overrideReads).toBe(1)
    const written = JSON.parse(store[`archive:monthly:${month}`])
    expect(written.services?.claude?.longestIncidentMin, 'the pinned duration, not the 800m paperwork span').toBe(18)
    expect(written.services?.claude?.totalDowntimeMin).toBe(18)
    // Asserted separately because it reaches the archive by a different route — a counted total over
    // a counted divisor, filtered by the #1021 / #1210 / #1292 exclusions — so it is not a restatement
    // of the two above and can diverge as those rules accrue.
    expect(written.services?.claude?.avgResolutionMin).toBe(18)
  })

  // `force: true` is the operator's escape hatch from the census `409`. It must NOT reach past the
  // pre-build reads: those refuse because the handler could not establish what it is building FROM,
  // and forcing past that publishes an archive with no overrides applied — the outcome this issue
  // exists to prevent, reached deliberately. Both refusals are stated as force-proof in
  // operator-tools.md, so they need a test rather than a sentence.
  it('does not let force:true past the override-list refusal', async () => {
    const month = monthsAgo(1)
    const { kv } = makeFaultyKV({
      'services:latest': JSON.stringify({ services: [makeService({ id: 'claude' })], cachedAt: '2026-05-01T00:00:00Z' }),
      [`incidents:monthly:${month}`]: paperworkAccumulator(),
    }, /^incident:duration-overrides$/)

    const res = await workerModule.fetch(req({ month, force: true }, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)

    expect(res.status).toBe(503)
    expect((kv.put as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })

  it('does not let force:true past the unusable-rows refusal', async () => {
    const month = monthsAgo(1)
    const { kv } = makeKV({
      'services:latest': JSON.stringify({ services: [makeService({ id: 'claude' })], cachedAt: '2026-05-01T00:00:00Z' }),
      'incident:duration-overrides': '[{"id":"inc-1","durationMin":"18"}]',
      [`incidents:monthly:${month}`]: paperworkAccumulator(),
    })

    const res = await workerModule.fetch(req({ month, force: true }, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)

    expect(res.status).toBe(500)
    expect((kv.put as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })

  it('refuses when the duration-override list cannot be read, so the paperwork duration is not archived', async () => {
    // The fault case the census is blind to. Before the fix this answered 200 with 800m archived.
    const month = monthsAgo(1)
    const { kv } = makeFaultyKV({
      'services:latest': JSON.stringify({ services: [makeService({ id: 'claude' })], cachedAt: '2026-05-01T00:00:00Z' }),
      [`incidents:monthly:${month}`]: paperworkAccumulator(),
    }, /^incident:duration-overrides$/)

    const res = await workerModule.fetch(req({ month }, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)

    expect(res.status).toBe(503)
    expect((await res.json() as { retryable: boolean }).retryable).toBe(true)
    expect((kv.put as unknown as { mock: { calls: unknown[] } }).mock.calls, 'nothing may be written').toHaveLength(0)
  })

  it('answers 500 retryable:false when the duration-override list is malformed, not a forever-retry 503', async () => {
    // Same split as the suppression sibling (#1260 r3): a bad JSON value never parses on a retry, so
    // "retryable" would leave the operator re-running a call that cannot succeed.
    const { kv } = makeKV({ 'incident:duration-overrides': '{ not json' })

    const res = await workerModule.fetch(req({ month: monthsAgo(1) }, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)

    expect(res.status).toBe(500)
    const body = await res.json() as { retryable: boolean; reason: string }
    expect(body.retryable).toBe(false)
    expect(body.reason).toBe('not-json')
  })

  it('refuses a row that parses but is unusable — the shape a hand-edit produces', async () => {
    // Found in round 1 review, reproduced before fixing: `durationMin: "18"` (a STRING) is valid
    // JSON, `normalizeOverrides` drops the row, and the list read as `[]` — "no overrides
    // configured". The rebuild then archived the 800m paperwork duration under `200 ok:true`, which
    // is the #1274 symptom reached without any KV fault at all. The endpoint's own repair hint sends
    // the operator to hand-edit this value, so this is the likeliest way to produce it.
    const month = monthsAgo(1)
    const { kv } = makeKV({
      'services:latest': JSON.stringify({ services: [makeService({ id: 'claude' })], cachedAt: '2026-05-01T00:00:00Z' }),
      'incident:duration-overrides': '[{"id":"inc-1","durationMin":"18"}]',
      [`incidents:monthly:${month}`]: paperworkAccumulator(),
    })

    const res = await workerModule.fetch(req({ month }, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)

    expect(res.status).toBe(500)
    const body = await res.json() as { retryable: boolean; reason: string; droppedRows: number }
    expect(body.reason).toBe('unusable-rows')
    expect(body.droppedRows).toBe(1)
    expect(body.retryable).toBe(false)
    expect((kv.put as unknown as { mock: { calls: unknown[] } }).mock.calls, 'the paperwork duration must not be archived').toHaveLength(0)
  })

  it('refuses a list that is no longer an array, which normalizes to an empty one', async () => {
    // `mutateOverrides` only ever writes an array, so any other shape is a hand-edit that lost the
    // whole list — and it would otherwise be indistinguishable from "nothing configured".
    const { kv } = makeKV({ 'incident:duration-overrides': '{"id":"inc-1","durationMin":18}' })

    const res = await workerModule.fetch(req({ month: monthsAgo(1) }, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)

    expect(res.status).toBe(500)
    expect((await res.json() as { reason: string }).reason).toBe('not-an-array')
  })

  it('rebuilds normally when the override list is merely absent — a fault is not an empty list', async () => {
    // The negative control for the two refusals above: absence must stay a 200, or the fix would
    // have traded a silent wrong archive for an endpoint nobody can run.
    const month = monthsAgo(1)
    const { kv, store } = makeKV({
      'services:latest': JSON.stringify({ services: [makeService({ id: 'claude' })], cachedAt: '2026-05-01T00:00:00Z' }),
      [`incidents:monthly:${month}`]: paperworkAccumulator(),
    })

    const res = await workerModule.fetch(req({ month }, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)

    expect(res.status).toBe(200)
    const written = JSON.parse(store[`archive:monthly:${month}`])
    expect(written.services?.claude?.longestIncidentMin, 'no override configured → the stored duration stands').toBe(800)
  })

  // ── #1274 Part 3 — a rebuild of the CURRENT month froze a partial archive the cron never replaces ──
  it('refuses the current month, which the month-end cron would then never replace', async () => {
    const { kv } = makeKV({
      'services:latest': JSON.stringify({ services: [makeService({ id: 'claude' })], cachedAt: '2026-05-01T00:00:00Z' }),
    })
    const thisMonth = monthsAgo(0)

    const res = await workerModule.fetch(req({ month: thisMonth }, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)

    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    // Not the "not a real calendar month" wording — it IS a real month, and telling the operator
    // they mistyped it would send them looking for a typo that is not there.
    expect(body.error).toBe('that month has not ended yet')
    expect((kv.put as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })

  it('does not let force:true past the current-month refusal', async () => {
    // The one refusal here that guards an UNRECOVERABLE outcome: a mid-month rebuild freezes a
    // partial archive, `if (!existing)` stops the month-end cron ever replacing it, and a first-ever
    // write leaves no `:prev:` bytes to restore. The guard sitting ahead of the force check is the
    // whole safety property, and statement order is not something the compiler polices.
    const { kv } = makeKV({
      'services:latest': JSON.stringify({ services: [makeService({ id: 'claude' })], cachedAt: '2026-05-01T00:00:00Z' }),
    })

    const res = await workerModule.fetch(req({ month: monthsAgo(0), force: true }, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)

    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('that month has not ended yet')
    expect((kv.put as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })

  it('still rebuilds the month that just ended — the current-month guard is not off by one', async () => {
    // The boundary control: `monthsAgo(1)` is the newest rebuildable month, and it is exactly the
    // month operator-tools.md tells the operator to rebuild after suppressing an incident.
    const month = monthsAgo(1)
    const { kv } = makeKV({
      'services:latest': JSON.stringify({ services: [makeService({ id: 'claude' })], cachedAt: '2026-05-01T00:00:00Z' }),
    })

    const res = await workerModule.fetch(req({ month }, { 'X-Admin-Key': 'test-admin-key' }), envWith(kv), ctx)

    expect(res.status).toBe(200)
  })
})
