import { describe, it, expect, vi } from 'vitest'
import workerModule, { readUptimeHistory, HISTORY_RETENTION_DAYS } from '../index'

// #988 — `history:{date}` carries a TTL, and `/api/uptime` clamps `?days=` to the same retention
// because a request past it returns nothing. Extracting one constant made the two sites easy to
// change together; it does NOT stop someone re-literalising one of them, which is the shape that
// cost a wrong fix in aiwatch-reports#77. The first test goes through the HANDLER for that reason —
// asserting on `readUptimeHistory` alone never reaches the clamp and so pins nothing about it.

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().split('T')[0]
}

function mockKV() {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(),
  } as unknown as KVNamespace
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as Parameters<typeof workerModule.fetch>[2]

function envWith(kv: KVNamespace) {
  return { ALLOWED_ORIGIN: '*', STATUS_CACHE: kv } as Parameters<typeof workerModule.fetch>[1]
}

describe('/api/uptime window is bound to the archive retention (#988)', () => {
  it('clamps ?days= to HISTORY_RETENTION_DAYS and asks for no day past it', async () => {
    const kv = mockKV()
    const res = await workerModule.fetch(new Request('https://example.com/api/uptime?days=9999'), envWith(kv), ctx)

    expect((await res.json() as { days: number }).days).toBe(HISTORY_RETENTION_DAYS)

    const asked = (kv.get as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0])
    expect(asked).toHaveLength(HISTORY_RETENTION_DAYS)
    // A clamp re-literalised above the retention would ask for a day the archive can no longer hold.
    expect(asked).not.toContain(`history:${daysAgo(HISTORY_RETENTION_DAYS)}`)
  })

  it('reads today from `daily:` and every past day from `history:`', async () => {
    // The branch is silent if it breaks: today's counters would vanish from /api/uptime with a 200.
    const kv = mockKV()
    await readUptimeHistory(kv, 3)

    const asked = (kv.get as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0])
    expect(asked).toEqual([
      `daily:${daysAgo(0)}`,
      `history:${daysAgo(1)}`,
      `history:${daysAgo(2)}`,
    ])
  })
})
