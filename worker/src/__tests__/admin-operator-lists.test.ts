// #1318 — GET/POST /api/admin/suppress and /api/admin/duration-override against a stored list that
// holds rows the endpoint cannot read. Both used to read through the normalizer (which drops those
// rows) and then rewrite the whole TTL-less value from that read, deleting every rejected row.

import { describe, it, expect, vi } from 'vitest'
import workerModule from '../index'

function makeKV(initial: Record<string, string> = {}) {
  const store = { ...initial }
  return {
    store,
    kv: {
      get: vi.fn(async (k: string) => store[k] ?? null),
      put: vi.fn(async (k: string, v: string) => { store[k] = v }),
      delete: vi.fn(async (k: string) => { delete store[k] }),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    } as unknown as KVNamespace,
  }
}

const env = (kv: KVNamespace) =>
  ({ ALLOWED_ORIGIN: '*', STATUS_CACHE: kv, ADMIN_API_KEY: 'k' }) as Parameters<typeof workerModule.fetch>[1]
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

function call(path: string, method: 'GET' | 'POST', body?: unknown): Request {
  return new Request(`https://example.com${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'k' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

const putCalls = (kv: KVNamespace) => (kv.put as unknown as { mock: { calls: unknown[] } }).mock.calls

const OVERRIDES = 'incident:duration-overrides'
const SUPPRESSIONS = 'incident:suppressions'

describe('POST /api/admin/duration-override on a list with unusable rows', () => {
  it('refuses the rewrite instead of deleting the rows it could not read (the issue reproduction)', async () => {
    const stored = '[{"id":"A","durationMin":"18","reason":"cursor paperwork"},{"id":"B","durationMin":"42","reason":"other"}]'
    const { kv, store } = makeKV({ [OVERRIDES]: stored })

    const res = await workerModule.fetch(
      call('/api/admin/duration-override', 'POST', { action: 'add', id: 'A', durationMin: 18, reason: 'cursor paperwork' }),
      env(kv), ctx)

    expect(res.status).toBe(409)
    const body = await res.json() as { ok: boolean; reason: string; droppedRows: number; retryable: boolean }
    expect(body).toMatchObject({ ok: false, reason: 'unusable-rows', droppedRows: 2, retryable: false })
    expect(putCalls(kv)).toHaveLength(0)
    expect(store[OVERRIDES]).toBe(stored)
  })

  it('refuses a stored value that is not an array, which would otherwise read as an empty list', async () => {
    const stored = '{"id":"A","durationMin":18}'
    const { kv, store } = makeKV({ [OVERRIDES]: stored })

    const res = await workerModule.fetch(
      call('/api/admin/duration-override', 'POST', { action: 'add', id: 'Z', durationMin: 5 }), env(kv), ctx)

    expect(res.status).toBe(409)
    expect((await res.json() as { reason: string }).reason).toBe('not-an-array')
    expect(store[OVERRIDES]).toBe(stored)
  })

  it('refuses a stored value that does not parse', async () => {
    const { kv, store } = makeKV({ [OVERRIDES]: '{ not json' })

    const res = await workerModule.fetch(
      call('/api/admin/duration-override', 'POST', { action: 'add', id: 'Z', durationMin: 5 }), env(kv), ctx)

    expect(res.status).toBe(409)
    expect((await res.json() as { reason: string }).reason).toBe('not-json')
    expect(store[OVERRIDES]).toBe('{ not json')
  })

  it('still writes a clean list, and a clean list round-trips unchanged', async () => {
    const clean = [{ id: 'A', durationMin: 18, reason: 'r', createdAt: '2026-07-01T00:00:00.000Z', by: 'admin' }]
    const { kv, store } = makeKV({ [OVERRIDES]: JSON.stringify(clean) })

    const res = await workerModule.fetch(
      call('/api/admin/duration-override', 'POST', { action: 'add', id: 'B', durationMin: 7 }), env(kv), ctx)

    expect(res.status).toBe(200)
    const written = JSON.parse(store[OVERRIDES]) as Array<Record<string, unknown>>
    expect(written).toHaveLength(2)
    expect(written[0]).toEqual(clean[0])
    expect(written[1]).toMatchObject({ id: 'B', durationMin: 7 })
  })
})

describe('POST /api/admin/suppress on a list with unusable rows', () => {
  it('refuses the rewrite instead of deleting a row that lost its scope', async () => {
    const stored = JSON.stringify([
      { scope: 'incident', incId: 'keep-me' },
      { incId: 'lost-scope', reason: 'hand edit' },
    ])
    const { kv, store } = makeKV({ [SUPPRESSIONS]: stored })

    const res = await workerModule.fetch(
      call('/api/admin/suppress', 'POST', { action: 'add', scope: 'incident', incId: 'new' }), env(kv), ctx)

    expect(res.status).toBe(409)
    const body = await res.json() as { ok: boolean; reason: string; droppedRows: number; retryable: boolean }
    expect(body).toMatchObject({ ok: false, reason: 'unusable-rows', droppedRows: 1, retryable: false })
    expect(putCalls(kv)).toHaveLength(0)
    expect(store[SUPPRESSIONS]).toBe(stored)
  })

  it('refuses a stored value that is not an array', async () => {
    const stored = '{"scope":"incident","incId":"x"}'
    const { kv, store } = makeKV({ [SUPPRESSIONS]: stored })

    const res = await workerModule.fetch(
      call('/api/admin/suppress', 'POST', { action: 'add', scope: 'incident', incId: 'new' }), env(kv), ctx)

    expect(res.status).toBe(409)
    expect((await res.json() as { reason: string }).reason).toBe('not-an-array')
    expect(store[SUPPRESSIONS]).toBe(stored)
  })

  it('still writes a clean list, and a clean list round-trips unchanged', async () => {
    const clean = [
      { scope: 'service-pattern', svcId: 'openai', match: 'fedramp', reason: 'r', createdAt: '2026-07-06T02:36:14.501Z', by: 'admin' },
      { scope: 'incident', incId: 'a', by: 'admin' },
    ]
    const { kv, store } = makeKV({ [SUPPRESSIONS]: JSON.stringify(clean) })

    const res = await workerModule.fetch(
      call('/api/admin/suppress', 'POST', { action: 'add', scope: 'incident', incId: 'b' }), env(kv), ctx)

    expect(res.status).toBe(200)
    const written = JSON.parse(store[SUPPRESSIONS]) as Array<Record<string, unknown>>
    expect(written.slice(0, 2)).toEqual(clean)
    expect(written[2]).toMatchObject({ scope: 'incident', incId: 'b' })
  })

  it('writes the first entry when the key is absent', async () => {
    const { kv, store } = makeKV()

    const res = await workerModule.fetch(
      call('/api/admin/suppress', 'POST', { action: 'add', scope: 'incident', incId: 'first' }), env(kv), ctx)

    expect(res.status).toBe(200)
    expect(JSON.parse(store[SUPPRESSIONS])).toMatchObject([{ scope: 'incident', incId: 'first' }])
  })
})

describe('GET surfaces rows the API is not showing', () => {
  it('duration-override: names the unusable rows alongside the surviving ones', async () => {
    const { kv } = makeKV({ [OVERRIDES]: '[{"id":"A","durationMin":18},{"id":"B","durationMin":"42"}]' })

    const res = await workerModule.fetch(call('/api/admin/duration-override', 'GET'), env(kv), ctx)

    expect(res.status).toBe(200)
    const body = await res.json() as { overrides: unknown[]; listState: string; reason: string; droppedRows: number }
    expect(body.overrides).toEqual([{ id: 'A', durationMin: 18 }])
    expect(body).toMatchObject({ listState: 'malformed', reason: 'unusable-rows', droppedRows: 1 })
  })

  it('suppress: names the unusable rows alongside the surviving ones', async () => {
    const { kv } = makeKV({ [SUPPRESSIONS]: '[{"scope":"incident","incId":"a"},{"incId":"b"}]' })

    const res = await workerModule.fetch(call('/api/admin/suppress', 'GET'), env(kv), ctx)

    expect(res.status).toBe(200)
    const body = await res.json() as { suppressions: unknown[]; listState: string; reason: string; droppedRows: number }
    expect(body.suppressions).toEqual([{ scope: 'incident', incId: 'a' }])
    expect(body).toMatchObject({ listState: 'malformed', reason: 'unusable-rows', droppedRows: 1 })
  })

  it('reports a clean list as ok', async () => {
    const { kv } = makeKV({ [SUPPRESSIONS]: '[{"scope":"incident","incId":"a"}]' })

    const res = await workerModule.fetch(call('/api/admin/suppress', 'GET'), env(kv), ctx)

    const body = await res.json() as { listState: string; droppedRows?: number }
    expect(body.listState).toBe('ok')
    expect(body.droppedRows).toBeUndefined()
  })
})
