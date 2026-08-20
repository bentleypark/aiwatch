import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ServiceStatus } from '../types'

// #1256 — every test here asserts on `kv.put`, because the guard's whole value is that an
// unreadable window never reaches it. A green `parseSnapshotWindow` unit test cannot show that.

async function loadWriters() {
  // Fresh module per test: `lastProbeSlot` / `lastLatencySlot` are module-level state, and a prior
  // successful write in the same slot would early-return the next call, hiding a regression.
  vi.resetModules()
  return await import('../index')
}

function kvWith(get: () => Promise<string | null>) {
  return {
    get: vi.fn(get),
    // Params are declared so `put.mock.calls[0][1]` is typed as the written body.
    put: vi.fn(async (_key: string, _value: string, _opts?: unknown) => undefined),
  }
}

// The four stored values the pre-#1256 code wrote over. Verified by replaying
// `existing ? (JSON.parse(existing).snapshots ?? []) : []` against each: all four reached kv.put
// with a single-snapshot window. Truncated JSON and `null` are absent from this list on purpose —
// those threw into the outer catch and were already fail-closed.
const DESTROYED_THE_WINDOW: [label: string, stored: () => Promise<string | null>][] = [
  ['the KV read throws', async () => { throw new Error('KV unavailable') }],
  ['the value is an object with no snapshots array', async () => '{}'],
  ['the value has a null snapshots field', async () => '{"snapshots":null}'],
  ['the value is an empty string', async () => ''],
]

const LATENCY_SERVICES = [{ id: 'claude', latency: 120 }] as unknown as ServiceStatus[]

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('writeProbeSnapshot — fail closed on an unreadable window (#1256)', () => {
  for (const [label, stored] of DESTROYED_THE_WINDOW) {
    it(`does NOT write when ${label}`, async () => {
      const { writeProbeSnapshot } = await loadWriters()
      const kv = kvWith(stored)

      await writeProbeSnapshot(kv as unknown as KVNamespace)

      // Reaching the read is what makes this a guard assertion rather than a vacuous one: without
      // it, a writer that bailed before touching KV would satisfy every negative case here.
      expect(kv.get).toHaveBeenCalledTimes(1)
      expect(kv.put).not.toHaveBeenCalled()
      // The read sits above the probe loop so a skipped cycle costs no outbound requests.
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })
  }

  it('does NOT write when the stored JSON is truncated', async () => {
    const { writeProbeSnapshot } = await loadWriters()
    const kv = kvWith(async () => '{"snapshots":[{"t":"2026-08-19T00:00')

    await writeProbeSnapshot(kv as unknown as KVNamespace)

    expect(kv.get).toHaveBeenCalledTimes(1)
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('DOES bootstrap when the key is genuinely absent', async () => {
    const { writeProbeSnapshot } = await loadWriters()
    const kv = kvWith(async () => null)

    await writeProbeSnapshot(kv as unknown as KVNamespace)

    expect(kv.put).toHaveBeenCalledTimes(1)
    expect(JSON.parse(kv.put.mock.calls[0][1]).snapshots).toHaveLength(1)
    // The fake store ignores the key, so nothing else here would notice the read and the write
    // drifting onto different keys — which between two mirrored writers is a live copy-paste risk.
    expect(kv.get).toHaveBeenCalledWith('probe:24h')
    expect(kv.put.mock.calls[0][0]).toBe('probe:24h')
  })

  it('DOES append to an existing window, keeping every prior snapshot', async () => {
    const { writeProbeSnapshot } = await loadWriters()
    const prior = [
      { t: '2026-08-19T00:00:00Z', data: {} },
      { t: '2026-08-19T00:05:00Z', data: {} },
      { t: '2026-08-19T00:10:00Z', data: {} },
    ]
    const kv = kvWith(async () => JSON.stringify({ snapshots: prior }))

    await writeProbeSnapshot(kv as unknown as KVNamespace)

    const written = JSON.parse(kv.put.mock.calls[0][1])
    expect(written.snapshots).toHaveLength(prior.length + 1)
    expect(written.snapshots.slice(0, prior.length).map((s: { t: string }) => s.t))
      .toEqual(prior.map((s) => s.t))
  })

  it('DOES write on a stored-but-empty window, which is usable', async () => {
    const { writeProbeSnapshot } = await loadWriters()
    const kv = kvWith(async () => '{"snapshots":[]}')

    await writeProbeSnapshot(kv as unknown as KVNamespace)

    expect(kv.put).toHaveBeenCalledTimes(1)
  })
})

describe('writeLatencySnapshot — the same guard on latency:24h (#1256)', () => {
  for (const [label, stored] of DESTROYED_THE_WINDOW) {
    it(`does NOT write when ${label}`, async () => {
      const { writeLatencySnapshot } = await loadWriters()
      const kv = kvWith(stored)

      await writeLatencySnapshot(kv as unknown as KVNamespace, LATENCY_SERVICES)

      expect(kv.get).toHaveBeenCalledTimes(1)
      expect(kv.put).not.toHaveBeenCalled()
    })
  }

  it('DOES append to an existing window, keeping every prior snapshot', async () => {
    const { writeLatencySnapshot } = await loadWriters()
    const prior = [
      { t: '2026-08-19T00:00:00Z', data: { claude: 100 } },
      { t: '2026-08-19T00:30:00Z', data: { claude: 110 } },
    ]
    const kv = kvWith(async () => JSON.stringify({ snapshots: prior }))

    await writeLatencySnapshot(kv as unknown as KVNamespace, LATENCY_SERVICES)

    const written = JSON.parse(kv.put.mock.calls[0][1])
    expect(written.snapshots).toHaveLength(prior.length + 1)
    expect(written.snapshots.slice(0, prior.length).map((s: { t: string }) => s.t))
      .toEqual(prior.map((s) => s.t))
  })

  it('DOES bootstrap when the key is genuinely absent', async () => {
    const { writeLatencySnapshot } = await loadWriters()
    const kv = kvWith(async () => null)

    await writeLatencySnapshot(kv as unknown as KVNamespace, LATENCY_SERVICES)

    expect(kv.put).toHaveBeenCalledTimes(1)
    expect(JSON.parse(kv.put.mock.calls[0][1]).snapshots).toHaveLength(1)
    expect(kv.get).toHaveBeenCalledWith('latency:24h')
    expect(kv.put.mock.calls[0][0]).toBe('latency:24h')
  })

  it('does NOT write when the poll measured no latencies at all', async () => {
    // An empty payload would claim the slot, and the dedup below would then reject the healthy
    // poll seconds later — leaving the 30 minutes permanently blank.
    const { writeLatencySnapshot } = await loadWriters()
    const kv = kvWith(async () => '{"snapshots":[]}')

    await writeLatencySnapshot(kv as unknown as KVNamespace, [] as unknown as ServiceStatus[])

    expect(kv.put).not.toHaveBeenCalled()
  })
})

describe('the fail-closed skip is per-call, not sticky (#1256)', () => {
  // Hoisting `readFailed` out of the function turns one transient read error into a permanent
  // write stall for that isolate — the outcome the guard exists to prevent.
  it('writeProbeSnapshot recovers on the next call after a read failure', async () => {
    const { writeProbeSnapshot } = await loadWriters()
    let call = 0
    const kv = kvWith(async () => {
      if (++call === 1) throw new Error('KV unavailable')
      return JSON.stringify({ snapshots: [{ t: '2026-08-19T00:00:00Z', data: {} }] })
    })

    await writeProbeSnapshot(kv as unknown as KVNamespace)
    await writeProbeSnapshot(kv as unknown as KVNamespace)

    expect(kv.put).toHaveBeenCalledTimes(1)
    expect(JSON.parse(kv.put.mock.calls[0][1]).snapshots).toHaveLength(2)
  })

  it('writeLatencySnapshot recovers on the next call after a read failure', async () => {
    const { writeLatencySnapshot } = await loadWriters()
    let call = 0
    const kv = kvWith(async () => {
      if (++call === 1) throw new Error('KV unavailable')
      return JSON.stringify({ snapshots: [{ t: '2026-08-19T00:00:00Z', data: { claude: 100 } }] })
    })

    await writeLatencySnapshot(kv as unknown as KVNamespace, LATENCY_SERVICES)
    await writeLatencySnapshot(kv as unknown as KVNamespace, LATENCY_SERVICES)

    expect(kv.put).toHaveBeenCalledTimes(1)
    expect(JSON.parse(kv.put.mock.calls[0][1]).snapshots).toHaveLength(2)
  })

  it('writeProbeSnapshot recovers on the next call after an unreadable stored value', async () => {
    // The parse-null branch is a second skip path; only the read-throw one was covered.
    const { writeProbeSnapshot } = await loadWriters()
    let call = 0
    const kv = kvWith(async () =>
      ++call === 1 ? '{"snapshots":null}' : JSON.stringify({ snapshots: [{ t: '2026-08-19T00:00:00Z', data: {} }] }))

    await writeProbeSnapshot(kv as unknown as KVNamespace)
    await writeProbeSnapshot(kv as unknown as KVNamespace)

    expect(kv.put).toHaveBeenCalledTimes(1)
    expect(JSON.parse(kv.put.mock.calls[0][1]).snapshots).toHaveLength(2)
  })

  it('writeLatencySnapshot recovers on the next call after an unreadable stored value', async () => {
    const { writeLatencySnapshot } = await loadWriters()
    let call = 0
    const kv = kvWith(async () =>
      ++call === 1 ? '{"snapshots":null}' : JSON.stringify({ snapshots: [{ t: '2026-08-19T00:00:00Z', data: { claude: 100 } }] }))

    await writeLatencySnapshot(kv as unknown as KVNamespace, LATENCY_SERVICES)
    await writeLatencySnapshot(kv as unknown as KVNamespace, LATENCY_SERVICES)

    expect(kv.put).toHaveBeenCalledTimes(1)
    expect(JSON.parse(kv.put.mock.calls[0][1]).snapshots).toHaveLength(2)
  })
})

describe('the latency skip log is throttled but not muted (#1256)', () => {
  // Making warnLatencyWindow a no-op would restore the silent stall this PR exists to remove, with
  // the guard still visibly in place — so both the suppression and its expiry are pinned.
  it('logs once per interval and again after it elapses', async () => {
    vi.useFakeTimers()
    try {
      const { writeLatencySnapshot } = await loadWriters()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const kv = kvWith(async () => '{"snapshots":null}')

      await writeLatencySnapshot(kv as unknown as KVNamespace, LATENCY_SERVICES)
      await writeLatencySnapshot(kv as unknown as KVNamespace, LATENCY_SERVICES)
      expect(warn).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(600_001)
      await writeLatencySnapshot(kv as unknown as KVNamespace, LATENCY_SERVICES)
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the retention the window is written with (#1256)', () => {
  // `trimSnapshots` is unit-tested with a caller-supplied max, so it pins the function and not the
  // argument. These caps and TTLs exist only at the call site, and shrinking either is exactly how
  // the window would be destroyed by a route the guard does not cover.
  it('writeProbeSnapshot keeps 2016 slots for 7 days', async () => {
    const { writeProbeSnapshot } = await loadWriters()
    const prior = Array.from({ length: 2100 }, (_, i) => ({ t: `prior-${i}`, data: {} }))
    const kv = kvWith(async () => JSON.stringify({ snapshots: prior }))

    await writeProbeSnapshot(kv as unknown as KVNamespace)

    const kept = JSON.parse(kv.put.mock.calls[0][1]).snapshots
    expect(kept).toHaveLength(2016)
    // Direction, not just length: slice(0, n) keeps the OLDEST and freezes the window.
    expect(kept[0].t).toBe('prior-85')
    expect(kv.put.mock.calls[0][2]).toEqual({ expirationTtl: 604800 })
  })

  it('writeLatencySnapshot keeps 48 slots for 25 hours', async () => {
    const { writeLatencySnapshot } = await loadWriters()
    const prior = Array.from({ length: 60 }, (_, i) => ({ t: `prior-${i}`, data: {} }))
    const kv = kvWith(async () => JSON.stringify({ snapshots: prior }))

    await writeLatencySnapshot(kv as unknown as KVNamespace, LATENCY_SERVICES)

    const kept = JSON.parse(kv.put.mock.calls[0][1]).snapshots
    expect(kept).toHaveLength(48)
    expect(kept[0].t).toBe('prior-13')
    expect(kv.put.mock.calls[0][2]).toEqual({ expirationTtl: 90000 })
  })
})

describe('the in-window dedup does not lose the stored window (#1256)', () => {
  // `lastProbeSlot`/`lastLatencySlot` are per-isolate, so the stored-window check is the only
  // cross-isolate guard. It matters most for latency, which runs per inbound request via
  // ctx.waitUntil, so on a cold isolate it is the only thing between a poll and a duplicate append.
  it('writeProbeSnapshot does not re-append a slot already stored', async () => {
    const { writeProbeSnapshot } = await loadWriters()
    const { computeProbeSlot, slotToTimestamp } = await import('../probe')
    const slotTs = slotToTimestamp(computeProbeSlot(new Date()))
    const kv = kvWith(async () => JSON.stringify({ snapshots: [{ t: slotTs, data: {} }] }))

    await writeProbeSnapshot(kv as unknown as KVNamespace)

    expect(kv.put).not.toHaveBeenCalled()
  })

  it('writeLatencySnapshot does not re-append a slot already stored', async () => {
    const { writeLatencySnapshot } = await loadWriters()
    const now = new Date()
    const slotTs = `${now.toISOString().slice(0, 14)}${now.getUTCMinutes() < 30 ? '00' : '30'}:00Z`
    const kv = kvWith(async () => JSON.stringify({ snapshots: [{ t: slotTs, data: { claude: 100 } }] }))

    await writeLatencySnapshot(kv as unknown as KVNamespace, LATENCY_SERVICES)

    expect(kv.put).not.toHaveBeenCalled()
  })
})
