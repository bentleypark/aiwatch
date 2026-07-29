// #1179 — a PARTIAL `statusComponentIds` resolve was silent in both directions.
//
// `resolveSvcStatus` drops the ids it cannot find and badges off the survivors, so its return value
// cannot say that it judged only some of them — an outage on any of the rest reads as operational.
// The #135 miss alert never saw it: that path watches the PRIMARY `statusComponentId` only, and the
// secondary ids were a `console.warn` alone. #1175 fixed one instance of this by config (chatgpt →
// componentsUrl) without touching the mechanism, and the same gap made that fix silently revertible:
// when components.json is unreadable on both the page prefetch and the per-service retry,
// `pickBreakdownComponents` falls back to summary.json, the badge re-narrows, and the config field +
// the green suite both stay in place.
//
// The design rationale lives in docs/reference/discord-alert-paths.md. What is asserted here is the
// behaviour it requires — in particular the two properties an earlier revision of this mechanism
// got wrong and that no unit of it can be trusted without: an INTERMITTENT drift must still reach
// 6h (a design that cleared on the first clean cycle could never fire on a flapping components.json),
// and the write cost must track how long a drift lasts rather than how much traffic the site gets.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  elapsedAtLeast,
  shouldAlertPersistentFailure,
  parsePartialResolve,
  coversIdSet,
  unionIds,
  nextPartialResolveEntry,
  trackPartialResolve,
  detectPartialResolves,
  formatPartialResolveAlert,
  PARTIAL_RESOLVE_THRESHOLD_MS,
  PARTIAL_RESOLVE_REFRESH_MS,
  PARTIAL_RESOLVE_STALE_MS,
  PARTIAL_RESOLVE_TTL_S,
  type PartialResolveEntry,
  type KVLike,
} from '../utils'
import { PARTIAL_COMPONENT_SERVICES, SERVICES, fetchService } from '../services'

const INDEX_SRC = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')
const SERVICES_SRC = readFileSync(join(__dirname, '..', 'services.ts'), 'utf8')

// Return type is inferred, not annotated as KVLike: the assertions below read `.mock.calls`, which a
// KVLike annotation would erase. `satisfies` keeps it a valid KVLike without widening it.
function mockKV(store: Record<string, string> = {}) {
  return {
    store,
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async (key: string, value: string, _opts?: { expirationTtl?: number }) => { store[key] = value }),
    delete: vi.fn(async (key: string) => { delete store[key] }),
  } satisfies KVLike & { store: Record<string, string> }
}

/** A KV whose `get` REJECTS for keys matching `failOn` — the fault path `mockKV` cannot express. */
function faultyKV(failOn: RegExp, store: Record<string, string> = {}) {
  return {
    store,
    get: vi.fn(async (key: string) => {
      if (failOn.test(key)) throw new Error('kv unavailable')
      return store[key] ?? null
    }),
    put: vi.fn(async (key: string, value: string) => { store[key] = value }),
    delete: vi.fn(async (key: string) => { delete store[key] }),
  } satisfies KVLike & { store: Record<string, string> }
}

const HOUR = 3_600_000
const MIN = 60_000
const NOW = Date.parse('2026-07-29T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const rec = (e: { since: string; missing: string[]; updatedAt?: string; viaSummary?: boolean }) =>
  JSON.stringify({ updatedAt: e.since, viaSummary: false, ...e })
const entry = (e: Partial<PartialResolveEntry> = {}): PartialResolveEntry =>
  ({ since: ago(HOUR), updatedAt: ago(HOUR), missing: ['a'], viaSummary: false, ...e })

let warn: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })
const logText = () => [...warn.mock.calls, ...error.mock.calls].map((c: unknown[]) => c.join(' ')).join('\n')

describe('the constants have to relate to each other, not just exist', () => {
  it('a record outlives its own alert-staleness window, else nothing could ever be seen stale', () => {
    expect(PARTIAL_RESOLVE_TTL_S * 1000).toBeGreaterThan(PARTIAL_RESOLVE_STALE_MS)
  })

  it('a record outlives the ALERT THRESHOLD — otherwise a sparse drift could never reach it', () => {
    // Expiry is also the longest gap a recurring drift may have and still accumulate: two reports
    // further apart than the TTL never join, because the record expires between them and `since`
    // restarts. A TTL below the threshold would make a real-but-sparse drift unalertable at ANY
    // duration, silently — the same class of hole as the clear-on-clean-cycle design this replaced,
    // just at a longer horizon. Nothing else in the suite constrains this pair.
    expect(PARTIAL_RESOLVE_TTL_S * 1000).toBeGreaterThan(PARTIAL_RESOLVE_THRESHOLD_MS)
  })

  it('the staleness window is NARROWER than the alert threshold', () => {
    // Otherwise a record whose reports stopped hours ago still passes the "is it live" gate, and the
    // alert asserts a drift that ended. The gate only has meaning strictly inside the threshold.
    expect(PARTIAL_RESOLVE_STALE_MS).toBeLessThan(PARTIAL_RESOLVE_THRESHOLD_MS)
  })

  it('the staleness window is wider than the refresh cadence, else a live drift reads as retired', () => {
    // A refresh happens at most every PARTIAL_RESOLVE_REFRESH_MS, so a record in a HEALTHY live drift
    // is routinely that old. Staleness must sit above it with room for a missed cycle — the cron
    // re-fetches on a >10min-stale snapshot, so ~15min is the worst-case gap between observations.
    expect(PARTIAL_RESOLVE_STALE_MS).toBeGreaterThan(PARTIAL_RESOLVE_REFRESH_MS + 15 * MIN)
  })

  it('the alert threshold is long enough to outlast a rotation and short enough to be useful', () => {
    expect(PARTIAL_RESOLVE_THRESHOLD_MS).toBeGreaterThan(HOUR)
    expect(PARTIAL_RESOLVE_THRESHOLD_MS).toBeLessThanOrEqual(24 * HOUR)
    // …and a record must be refreshable many times before it can alert, or the clock could not run.
    expect(PARTIAL_RESOLVE_THRESHOLD_MS).toBeGreaterThan(PARTIAL_RESOLVE_REFRESH_MS * 4)
  })
})

describe('elapsedAtLeast — the shared duration primitive', () => {
  it('is frequency-independent: it answers from the timestamp, not a call count', () => {
    expect(elapsedAtLeast(ago(7 * HOUR), NOW, 6 * HOUR)).toBe(true)
    expect(elapsedAtLeast(ago(5 * HOUR), NOW, 6 * HOUR)).toBe(false)
    expect(elapsedAtLeast(ago(6 * HOUR), NOW, 6 * HOUR)).toBe(true) // boundary is inclusive
  })

  it('never alerts off an absent or unparseable timestamp', () => {
    expect(elapsedAtLeast(null, NOW, 1)).toBe(false)
    expect(elapsedAtLeast(undefined, NOW, 1)).toBe(false)
    expect(elapsedAtLeast('', NOW, 1)).toBe(false)
    expect(elapsedAtLeast('not-a-date', NOW, 1)).toBe(false)
  })

  it('#500 shouldAlertPersistentFailure still answers the same — the extraction kept its behaviour', () => {
    expect(shouldAlertPersistentFailure(ago(2 * HOUR), NOW, HOUR)).toBe(true)
    expect(shouldAlertPersistentFailure(ago(30 * MIN), NOW, HOUR)).toBe(false)
    expect(shouldAlertPersistentFailure(null, NOW, HOUR)).toBe(false)
  })
})

describe('parsePartialResolve', () => {
  it('reads a well-formed record', () => {
    expect(parsePartialResolve(rec({ since: ago(2 * HOUR), updatedAt: ago(MIN), missing: ['a', 'b'] })))
      .toEqual({ since: ago(2 * HOUR), updatedAt: ago(MIN), missing: ['a', 'b'], viaSummary: false })
    expect(parsePartialResolve(rec({ since: ago(HOUR), missing: ['a'], viaSummary: true }))?.viaSummary).toBe(true)
    // Absent fields (a record written before they existed) must degrade, not reject: viaSummary
    // false, updatedAt falling back to since.
    const legacy = parsePartialResolve(JSON.stringify({ since: ago(HOUR), missing: ['a'] }))
    expect(legacy).toEqual({ since: ago(HOUR), updatedAt: ago(HOUR), missing: ['a'], viaSummary: false })
  })

  it('returns null for absent, malformed, wrong-shape and EMPTY records', () => {
    expect(parsePartialResolve(null)).toBeNull()
    expect(parsePartialResolve('{oops')).toBeNull()
    expect(parsePartialResolve(JSON.stringify({ missing: ['a'] }))).toBeNull()   // no since
    expect(parsePartialResolve(JSON.stringify({ since: ago(HOUR) }))).toBeNull() // no missing
    expect(parsePartialResolve(JSON.stringify({ since: ago(HOUR), missing: 'a' }))).toBeNull()
    expect(parsePartialResolve(JSON.stringify({ since: ago(HOUR), missing: [] }))).toBeNull()
  })

  it('rejects an unparseable timestamp — otherwise the service is unalertable FOREVER', () => {
    // `since: "yesterday"` is a string, so a typeof check accepts it; elapsedAtLeast then answers
    // false every cycle while the refresh throttle declines to rewrite it. Rejecting makes the next
    // partial cycle write a fresh record, so it self-heals.
    expect(parsePartialResolve(JSON.stringify({ since: 'yesterday', missing: ['a'] }))).toBeNull()
    expect(parsePartialResolve(rec({ since: ago(HOUR), updatedAt: 'soon', missing: ['a'] }))).toBeNull()
  })

  it('drops non-string ids rather than rendering them into an operator alert', () => {
    const parsed = parsePartialResolve(JSON.stringify({ since: ago(HOUR), missing: ['a', null, 7] }))
    expect(parsed!.missing).toEqual(['a'])
    expect(logText()).toContain('non-string id')
  })

  it('warns on every rejection, and stays silent on a healthy absent record', () => {
    parsePartialResolve('{oops', 'chatgpt')
    expect(logText()).toContain('chatgpt')
    expect(logText()).toContain('unparseable JSON')
    warn.mockClear()
    parsePartialResolve(JSON.stringify({ since: 'yesterday', missing: ['a'] }), 'chatgpt')
    expect(logText()).toContain('unparseable `since`')
    warn.mockClear(); error.mockClear()
    expect(parsePartialResolve(null, 'chatgpt')).toBeNull()
    expect(logText()).toBe('')
  })
})

describe('coversIdSet / unionIds', () => {
  it('coversIdSet answers whether the stored union already has everything new', () => {
    expect(coversIdSet(['a', 'b'], ['a'])).toBe(true)
    expect(coversIdSet(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(coversIdSet(['a'], ['a', 'b'])).toBe(false)
    expect(coversIdSet([], ['a'])).toBe(false)
    expect(coversIdSet(['a'], [])).toBe(true)
  })

  it('unionIds accumulates without duplicating, in a stable order', () => {
    expect(unionIds(['b'], ['a', 'b'])).toEqual(['a', 'b'])
    expect(unionIds(['a'], ['a'])).toEqual(['a'])
    expect(unionIds([], ['b', 'a'])).toEqual(['a', 'b'])
  })
})

describe('nextPartialResolveEntry — the write-bound rule', () => {
  it('a first sighting starts both clocks', () => {
    expect(nextPartialResolveEntry(null, ['b', 'a'], false, NOW))
      .toEqual({ since: ago(0), updatedAt: ago(0), missing: ['a', 'b'], viaSummary: false })
  })

  it('says NOTHING TO WRITE when the union covers it and the refresh is not due', () => {
    expect(nextPartialResolveEntry(entry({ updatedAt: ago(MIN), missing: ['a'] }), ['a'], false, NOW)).toBeNull()
  })

  it('grows the union — and keeps `since`, so a rotating window cannot restart the clock', () => {
    const next = nextPartialResolveEntry(entry({ since: ago(5 * HOUR), updatedAt: ago(MIN), missing: ['a'] }), ['b'], false, NOW)
    expect(next).toEqual({ since: ago(5 * HOUR), updatedAt: ago(0), missing: ['a', 'b'], viaSummary: false })
  })

  it('refreshes on the throttle so the record cannot expire under a live drift', () => {
    expect(nextPartialResolveEntry(entry({ updatedAt: ago(PARTIAL_RESOLVE_REFRESH_MS - MIN) }), ['a'], false, NOW)).toBeNull()
    expect(nextPartialResolveEntry(entry({ updatedAt: ago(PARTIAL_RESOLVE_REFRESH_MS) }), ['a'], false, NOW)?.updatedAt).toBe(ago(0))
  })

  it('viaSummary is MONOTONE — it latches on, and a later clean read cannot flap it back', () => {
    // Both directions. If it could flip back, the observation would rewrite the record on every
    // components.json blip (traffic-proportional writes), and the alert could lose the very cause it
    // was recorded to report.
    expect(nextPartialResolveEntry(entry({ updatedAt: ago(MIN), viaSummary: false }), ['a'], true, NOW)?.viaSummary).toBe(true)
    expect(nextPartialResolveEntry(entry({ updatedAt: ago(MIN), viaSummary: true }), ['a'], false, NOW)).toBeNull()
    expect(nextPartialResolveEntry(entry({ updatedAt: ago(2 * PARTIAL_RESOLVE_REFRESH_MS), viaSummary: true }), ['a'], false, NOW)?.viaSummary).toBe(true)
  })

  it('an alternating drift writes on the throttle, NOT once per cycle', () => {
    // The property the whole design rests on. Simulated 60s polls over an hour where components.json
    // alternates readable/unreadable — the clean cycles report nothing at all, and the partial ones
    // are throttled. A per-cycle-write implementation would score 30.
    let stored: PartialResolveEntry | null = null
    let writes = 0
    for (let i = 0; i < 60; i++) {
      const at = NOW - (60 - i) * MIN
      if (i % 2 === 0) continue // clean cycle: nothing is reported, so nothing can be written
      const next = nextPartialResolveEntry(stored, ['a'], false, at)
      if (next) { stored = next; writes++ }
    }
    expect(writes).toBeLessThanOrEqual(Math.ceil(HOUR / PARTIAL_RESOLVE_REFRESH_MS) + 1)
    // …and the clock survived every clean cycle in between, which is what makes a flap alertable.
    expect(Date.parse(stored!.since)).toBeLessThanOrEqual(NOW - 59 * MIN)
  })
})

describe('trackPartialResolve', () => {
  it('records the first sighting with a TTL', async () => {
    const kv = mockKV()
    await trackPartialResolve(kv, 'chatgpt', ['voice', 'tasks'], NOW)
    expect(JSON.parse(kv.store['component-partial:chatgpt']))
      .toEqual({ since: ago(0), updatedAt: ago(0), missing: ['tasks', 'voice'], viaSummary: false })
    expect(kv.put).toHaveBeenCalledWith(expect.any(String), expect.any(String), { expirationTtl: PARTIAL_RESOLVE_TTL_S })
  })

  it('does nothing at all when there is nothing to report — the steady state is free', async () => {
    // No read, no write. A "clear" call here is what made an earlier revision unable to fire on a
    // flapping components.json, so its absence is the behaviour under test.
    const kv = mockKV()
    await trackPartialResolve(kv, 'chatgpt', [], NOW)
    expect(kv.get).not.toHaveBeenCalled()
    expect(kv.put).not.toHaveBeenCalled()
    expect(kv.delete).not.toHaveBeenCalled()
  })

  it('NEVER deletes — a record retires by TTL, so one clean cycle cannot reset the clock', async () => {
    const kv = mockKV({ 'component-partial:chatgpt': rec({ since: ago(5 * HOUR), missing: ['voice'] }) })
    await trackPartialResolve(kv, 'chatgpt', [], NOW)
    await trackPartialResolve(kv, 'chatgpt', ['voice'], NOW)
    expect(kv.delete).not.toHaveBeenCalled()
    expect(JSON.parse(kv.store['component-partial:chatgpt']).since).toBe(ago(5 * HOUR))
  })

  it('fails CLOSED on a KV read fault: no write, clock not restarted, and it says so', async () => {
    const kv = faultyKV(/component-partial:/)
    await trackPartialResolve(kv, 'chatgpt', ['voice'], NOW)
    expect(kv.put).not.toHaveBeenCalled()
    expect(logText()).toContain('KV read failed for chatgpt')
  })

  it('reports a failed write rather than leaving the clock silently unstarted', async () => {
    const kv = { ...mockKV(), put: vi.fn(async () => { throw new Error('kv full') }) }
    await trackPartialResolve(kv, 'chatgpt', ['voice'], NOW)
    expect(logText()).toContain('alert clock did not start')
  })

  it('is a no-op without KV rather than throwing', async () => {
    await expect(trackPartialResolve(undefined, 'chatgpt', ['voice'], NOW)).resolves.toBeUndefined()
  })

  it('never touches the #135 primary counter key', async () => {
    // Reusing `component-missing:{id}` would interleave with resetComponentMiss inside one cycle
    // (primary found → delete, secondary missing → increment) and corrupt both signals.
    const kv = mockKV()
    await trackPartialResolve(kv, 'chatgpt', ['voice'], NOW)
    const touched = [...kv.put.mock.calls, ...kv.delete.mock.calls, ...kv.get.mock.calls]
    expect(touched.length).toBeGreaterThan(0) // without this guard a no-op passes the loop vacuously
    for (const call of touched) expect(String(call[0])).not.toContain('component-missing:')
  })
})

describe('detectPartialResolves', () => {
  const services = [{ id: 'chatgpt', name: 'ChatGPT' }]
  const live = (sinceMsAgo: number, viaSummary = false) =>
    rec({ since: ago(sinceMsAgo), updatedAt: ago(MIN), missing: ['voice'], viaSummary })

  it('reports a service drifting for >= the threshold, carrying the recorded observation', async () => {
    const kv = mockKV({ 'component-partial:chatgpt': live(7 * HOUR, true) })
    const out = await detectPartialResolves(services, kv, NOW)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'chatgpt', name: 'ChatGPT', missing: ['voice'], viaSummary: true, alertKey: 'alerted:component-partial:chatgpt' })
  })

  it('stays silent below the threshold — a rotation that lasts minutes cannot page', async () => {
    expect(await detectPartialResolves(services, mockKV({ 'component-partial:chatgpt': live(5 * MIN) }), NOW)).toHaveLength(0)
  })

  it('stays silent once the drift STOPS being observed, even while the record lingers', async () => {
    // The record outlives the drift by up to its TTL. Without the staleness gate a service that
    // recovered at hour 7 would keep paging until the key expired.
    const stale = rec({ since: ago(9 * HOUR), updatedAt: ago(PARTIAL_RESOLVE_STALE_MS), missing: ['voice'] })
    expect(await detectPartialResolves(services, mockKV({ 'component-partial:chatgpt': stale }), NOW)).toHaveLength(0)
  })

  it('stays silent with no record at all', async () => {
    expect(await detectPartialResolves(services, mockKV(), NOW)).toHaveLength(0)
  })

  it('stays silent on a corrupt record, but says so', async () => {
    const kv = mockKV({ 'component-partial:chatgpt': '{oops' })
    expect(await detectPartialResolves(services, kv, NOW)).toHaveLength(0)
    expect(logText()).toContain('chatgpt')
  })

  it('a KV fault on the RECORD read skips the service LOUDLY — it does not read as "no drift"', async () => {
    // Fail-closed here would silently disarm the very alert this mechanism is; the whole point is
    // that it is reported rather than indistinguishable from health. It must also not reject: the
    // call is awaited at the top level of cronAlertCheck, so a throw takes the rest of the cron with it.
    const kv = faultyKV(/component-partial:/)
    await expect(detectPartialResolves(services, kv, NOW)).resolves.toEqual([])
    expect(logText()).toContain('UNCHECKED')
  })

  it('a KV fault on the DEDUP read still pages — fail-OPEN, the opposite posture on purpose', async () => {
    // A fault here re-pages rather than dropping the page. Documented as deliberate, so it needs an
    // assertion or the next refactor "fixes" it into a dropped alert. It is logged too: a fault that
    // keeps repeating re-pages every cron tick, which is indistinguishable from a real recurring
    // alert unless something says so.
    const kv = faultyKV(/^alerted:/, { 'component-partial:chatgpt': live(7 * HOUR) })
    expect(await detectPartialResolves(services, kv, NOW)).toHaveLength(1)
    expect(logText()).toContain('dedup read failed for chatgpt')
  })

  it('keeps sweeping the rest of the roster past EVERY skip — one bad service cannot silence the others', async () => {
    // Every skip in the loop is a `continue`; a `break` would let the first skipped service (openai is
    // first in the real roster) silence all the rest for 24h. All FIVE skip reasons, with the survivor
    // LAST — the two duration gates matter most, since "record exists but is younger than 6h" is the
    // ordinary state of a service that just started drifting.
    const roster = [
      { id: 'alerted-already', name: 'A' },
      { id: 'read-faults', name: 'B' },
      { id: 'no-record', name: 'C' },
      { id: 'too-young', name: 'D' },
      { id: 'gone-stale', name: 'E' },
      { id: 'chatgpt', name: 'ChatGPT' },
    ]
    const kv = faultyKV(/component-partial:read-faults/, {
      'component-partial:alerted-already': live(7 * HOUR),
      'alerted:component-partial:alerted-already': '1',
      'component-partial:too-young': live(5 * MIN),
      'component-partial:gone-stale': rec({ since: ago(9 * HOUR), updatedAt: ago(PARTIAL_RESOLVE_STALE_MS), missing: ['voice'] }),
      'component-partial:chatgpt': live(7 * HOUR),
    })
    expect((await detectPartialResolves(roster, kv, NOW)).map((s) => s.id)).toEqual(['chatgpt'])
  })

  it('dedups against the alert key', async () => {
    const kv = mockKV({
      'component-partial:chatgpt': live(7 * HOUR),
      'alerted:component-partial:chatgpt': '1',
    })
    expect(await detectPartialResolves(services, kv, NOW)).toHaveLength(0)
  })

  it('the default threshold is the 6h one, not a count', async () => {
    const kv = mockKV({ 'component-partial:chatgpt': live(PARTIAL_RESOLVE_THRESHOLD_MS - MIN) })
    expect(await detectPartialResolves(services, kv, NOW)).toHaveLength(0)
    kv.store['component-partial:chatgpt'] = live(PARTIAL_RESOLVE_THRESHOLD_MS)
    expect(await detectPartialResolves(services, kv, NOW)).toHaveLength(1)
  })
})

describe('an INTERMITTENT drift still pages — the property the mechanism turns on', () => {
  it('7h of reports arriving every other minute reaches the operator', async () => {
    // The ACCUMULATION half, over a 7h span no wall-clock test could drive: the clean minutes in
    // between are modelled as cycles that simply report nothing, which is what a clean cycle does.
    // That the production call site really reports nothing — and really does not delete — is a
    // separate claim, pinned end-to-end in the wiring block below; this test cannot see the call site.
    const kv = mockKV()
    const start = NOW - 7 * HOUR
    for (let i = 0; i * MIN <= 7 * HOUR; i++) {
      const at = start + i * MIN
      if (i % 2 === 0) continue           // clean poll: components.json readable, nothing reported
      await trackPartialResolve(kv, 'chatgpt', ['voice'], at, true)
    }
    const out = await detectPartialResolves([{ id: 'chatgpt', name: 'ChatGPT' }], kv, NOW)
    expect(out.map((s) => s.id)).toEqual(['chatgpt'])
    // …and it did not cost a write per poll to get there.
    expect(kv.put.mock.calls.length).toBeLessThanOrEqual(Math.ceil(7 * HOUR / PARTIAL_RESOLVE_REFRESH_MS) + 1)
  })
})

describe('formatPartialResolveAlert', () => {
  it('names the ids that did not resolve — the badge value cannot express it', () => {
    const body = formatPartialResolveAlert('ChatGPT', ['voice', 'tasks'], ago(7 * HOUR), NOW, false)
    expect(body).toContain('ChatGPT')
    expect(body).toContain('voice')
    expect(body).toContain('tasks')
    expect(body).toContain('7h+')
  })

  it('scopes its claims to the window, since the id list is a union over it', () => {
    // The list can contain an id that resolves again intermittently. Asserting a present-tense blind
    // spot for all of them would invite the operator to delete a healthy id from the config.
    const body = formatPartialResolveAlert('ChatGPT', ['voice'], ago(7 * HOUR), NOW, false)
    expect(body).toContain('in that window')
    expect(body).toContain('intermittently')
  })

  it('claims the #1175 revert ONLY from the observed fallback, never from config', () => {
    // The round-1 defect this pins: the flag used to be `Boolean(config.componentsUrl)`, so a provider
    // DELETING an id from a perfectly readable components.json produced the same alert telling the
    // operator to go debug a working fetch.
    expect(formatPartialResolveAlert('ChatGPT', ['voice'], ago(7 * HOUR), NOW, true)).toContain('#1175')
    expect(formatPartialResolveAlert('ChatGPT', ['voice'], ago(7 * HOUR), NOW, false)).not.toContain('#1175')
  })
})

describe('PARTIAL_COMPONENT_SERVICES roster', () => {
  it('is exactly the services whose badge is a worst-of over statusComponentIds', () => {
    const expected = SERVICES.filter((s) => s.statusComponentIds && s.statusComponentIds.length > 0).map((s) => s.id)
    expect(PARTIAL_COMPONENT_SERVICES.map((s) => s.id).sort()).toEqual([...expected].sort())
    expect(PARTIAL_COMPONENT_SERVICES.length).toBeGreaterThan(0)
  })

  it('carries each service\'s real display name — the alert title renders it', () => {
    for (const svc of PARTIAL_COMPONENT_SERVICES) {
      expect(svc.name).toBe(SERVICES.find((s) => s.id === svc.id)!.name)
      expect(svc.name.length).toBeGreaterThan(0)
    }
  })

  it('covers BOTH exposure groups — the componentsUrl services and the summary.json ones', () => {
    const ids = PARTIAL_COMPONENT_SERVICES.map((s) => s.id)
    expect(ids).toContain('chatgpt')  // componentsUrl group
    expect(ids).toContain('cursor')   // summary.json group — the half a componentsUrl-scoped fix would miss
    expect(ids).toContain('copilot')
  })
})

// The pure functions above being green proves nothing about whether production calls them — this
// repo's recurring shipped bug (#966/#1032). These two blocks pin the two ends of the wiring.
describe('wiring — fetchService reports the partial resolve (#1179)', () => {
  const CHATGPT = SERVICES.find((s) => s.id === 'chatgpt')!
  const PRIMARY = CHATGPT.statusComponentId!
  const VOICE = '01JMXBNJXGGT5SR5DB9J7GYY48' // "Voice mode" — omitted by summary.json's window 2026-07-28
  const OUT_OF_WINDOW = new Set([VOICE, '01JSYVYQSWMJ9QG35XHP08BHA7', '01JQ7EKW990MSPSWVXC7VPV2ZJ', '01JMXBNJXG1YMQPPCPCQX3MPA2', '01JSG1XMJ9RVJJQ0E85NVSJ2AZ'])
  const comp = (id: string) => ({ id, name: id, status: 'operational' })
  const SUPERSET = CHATGPT.statusComponentIds!.map((id) => comp(id))
  const WINDOW = SUPERSET.filter((c) => !OUT_OF_WINDOW.has(c.id))
  // `null` means the page served NO components array at all — spelled explicitly because a default
  // parameter treats an explicit `undefined` as "not passed".
  type Comps = Array<{ id: string; name: string; status: string }>
  const prefetched = (
    componentsFetch: { ok: true; components: unknown } | { ok: false },
    components: Comps | null = WINDOW,
    indicator = 'none',
  ) => ({
    summary: { status: { indicator, description: 'x' }, components: components ?? undefined, incidents: [] } as never,
    incidents: null,
    latency: 100,
    componentsFetch,
  })
  const stored = (kv: ReturnType<typeof mockKV>, id = 'chatgpt') => parsePartialResolve(kv.store[`component-partial:${id}`] ?? null)

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('components.json')) return new Response('', { status: 500 })
      if (String(url).endsWith('.json')) return new Response(JSON.stringify({ incidents: [] }), { status: 200 })
      return new Response('', { status: 200 })
    }))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('an unreadable components.json leaves a durable record naming every dropped id', async () => {
    const kv = mockKV()
    const svc = await fetchService(CHATGPT, prefetched({ ok: false }), kv as never)
    expect(svc.status).toBe('operational') // still the honest degraded outcome — the badge DID narrow
    const e = stored(kv)
    expect(e).not.toBeNull()
    expect(e!.missing).toEqual([...OUT_OF_WINDOW].filter((id) => id !== PRIMARY).sort())
    expect(e!.viaSummary).toBe(true) // observed, not inferred: this run really did fall back
  })

  it('a READABLE components.json with a deleted id records the drift WITHOUT blaming the fetch', async () => {
    // The case the config-inferred flag got wrong: the provider dropped one id from a components.json
    // that reads perfectly. Same missing set, completely different root cause — so viaSummary must be
    // false here, and this is the only fixture that can prove the flag is an observation.
    const kv = mockKV()
    const deleted = SUPERSET.filter((c) => c.id !== VOICE)
    await fetchService(CHATGPT, prefetched({ ok: true, components: deleted }), kv as never)
    const e = stored(kv)
    expect(e!.missing).toEqual([VOICE])
    expect(e!.viaSummary).toBe(false)
    expect(formatPartialResolveAlert('ChatGPT', e!.missing, e!.since, NOW, e!.viaSummary)).not.toContain('#1175')
  })

  it('reports for a NON-componentsUrl service too — most of the roster has no components.json', async () => {
    // Every other wiring case rides chatgpt, the one service with a componentsUrl; without this,
    // gating the call site on `config.componentsUrl` would silently drop most of the roster while the
    // roster test kept certifying coverage.
    const CURSOR = SERVICES.find((s) => s.id === 'cursor')!
    expect(CURSOR.componentsUrl).toBeUndefined()
    const kept = CURSOR.statusComponentIds!.slice(0, 2).map((id) => comp(id))
    const kv = mockKV()
    await fetchService(CURSOR, {
      summary: { status: { indicator: 'none', description: 'x' }, components: kept, incidents: [] } as never,
      incidents: null, latency: 100,
    }, kv as never)
    const e = stored(kv, 'cursor')
    expect(e!.missing).toEqual(CURSOR.statusComponentIds!.slice(2).sort())
    expect(e!.viaSummary).toBe(false)
  })

  it('excludes the PRIMARY from the record — #135 owns that id, and double-paging it is the bug', async () => {
    const kv = mockKV()
    const windowWithoutPrimary = WINDOW.filter((c) => c.id !== PRIMARY)
    expect(windowWithoutPrimary.length).toBeLessThan(WINDOW.length) // the fixture really drops it
    await fetchService(CHATGPT, prefetched({ ok: false }, windowWithoutPrimary), kv as never)
    expect(stored(kv)!.missing).not.toContain(PRIMARY)
  })

  it('reports when ONLY the primary resolved — the worst partial resolve there is', async () => {
    // The `anyResolved` gate has to be over the FULL id list. Computing it over the secondaries alone
    // reads as "nothing resolved" here and skips the report — silencing the single worst case: a
    // badge standing on one component while 11 are invisible.
    const kv = mockKV()
    await fetchService(CHATGPT, prefetched({ ok: false }, [comp(PRIMARY)]), kv as never)
    expect(stored(kv)!.missing).toHaveLength(CHATGPT.statusComponentIds!.length - 1)
  })

  it('reports NOTHING when not one configured id resolves — that is #135\'s case, not this one', async () => {
    // A mass id migration: resolveSvcStatus matches nothing and returns the page indicator, so there
    // is no narrowed badge to describe. Alerting would page a second time with a false description.
    const kv = mockKV()
    const svc = await fetchService(CHATGPT, prefetched({ ok: false }, [comp('zz-foreign-id')], 'major'), kv as never)
    expect(svc.status).toBe('down')  // the safe overall-indicator fallback really was taken
    expect(kv.store['component-partial:chatgpt']).toBeUndefined()
    // …but the WARN still enumerates them. The alert gate must not swallow the log: for most of the
    // roster (no displayComponentIds) this is the only enumeration of the dropped ids there is, and a
    // mass id migration is exactly when the operator needs it.
    expect(logText()).toContain('chatgpt additional component ids missing')
    expect(logText()).toContain(VOICE)
  })

  /** `fetchService` writes other KV keys too (the #135 counter, fetch-fail); scope to ours. */
  const partialWrites = (kv: ReturnType<typeof mockKV>) =>
    kv.put.mock.calls.filter((c) => String(c[0]).startsWith('component-partial:'))

  it('…and nothing when the page serves no components at all, or an empty array', async () => {
    const kv = mockKV()
    await fetchService(CHATGPT, prefetched({ ok: false }, null), kv as never)
    await fetchService(CHATGPT, prefetched({ ok: false }, []), kv as never)
    expect(kv.store['component-partial:chatgpt']).toBeUndefined()
    expect(partialWrites(kv)).toHaveLength(0)
  })

  it('a fully-resolved cycle writes nothing and leaves no record', async () => {
    const kv = mockKV()
    await fetchService(CHATGPT, prefetched({ ok: true, components: SUPERSET }), kv as never)
    expect(kv.store['component-partial:chatgpt']).toBeUndefined()
    expect(partialWrites(kv)).toHaveLength(0)
  })

  it('a CLEAN cycle between two drifting ones leaves the record and its clock intact', async () => {
    // The invariant the whole rebuild exists to establish, driven through the production call site
    // rather than through trackPartialResolve alone. Re-adding an `else { kvDel(...) }` here — which
    // is exactly what the previous design did — is caught by this and by nothing else: it makes an
    // intermittent drift unalertable, because each clean poll destroys the clock the drifting polls
    // are accumulating.
    const kv = mockKV()
    await fetchService(CHATGPT, prefetched({ ok: false }), kv as never)
    const first = stored(kv)!
    await fetchService(CHATGPT, prefetched({ ok: true, components: SUPERSET }), kv as never) // recovered
    expect(kv.store['component-partial:chatgpt']).toBeDefined()
    expect(kv.delete.mock.calls.map((c) => String(c[0]))).not.toContain('component-partial:chatgpt')
    await fetchService(CHATGPT, prefetched({ ok: false }), kv as never)                      // drifting again
    expect(stored(kv)!.since).toBe(first.since) // the clock survived the clean cycle in between
  })

  it('the record is what a 6h-persistent drift alerts from — the two halves meet', async () => {
    // Joins producer to consumer so neither can be refactored away in isolation. Alerting needs BOTH
    // halves of the record: `since` old enough AND `updatedAt` recent. fetchService stamps both at
    // now, so the fresh record must not alert; ageing only `since` is exactly the shape 6h of
    // repeated reports produces.
    const kv = mockKV()
    await fetchService(CHATGPT, prefetched({ ok: false }), kv as never)
    const live = stored(kv)!
    const at = Date.parse(live.updatedAt)
    expect(await detectPartialResolves(PARTIAL_COMPONENT_SERVICES, kv, at)).toHaveLength(0)

    kv.store['component-partial:chatgpt'] = JSON.stringify({ ...live, since: new Date(at - PARTIAL_RESOLVE_THRESHOLD_MS).toISOString() })
    const aged = await detectPartialResolves(PARTIAL_COMPONENT_SERVICES, kv, at)
    expect(aged.map((s) => s.id)).toEqual(['chatgpt'])
    // …and the observed cause survives the whole chain into the body the operator reads.
    expect(formatPartialResolveAlert(aged[0].name, aged[0].missing, aged[0].since, at, aged[0].viaSummary))
      .toContain('#1175')

    // The other half of the gate: the same aged record stops paging once reports stop coming in.
    kv.store['component-partial:chatgpt'] = JSON.stringify({
      ...live,
      since: new Date(at - PARTIAL_RESOLVE_THRESHOLD_MS).toISOString(),
      updatedAt: new Date(at - PARTIAL_RESOLVE_STALE_MS).toISOString(),
    })
    expect(await detectPartialResolves(PARTIAL_COMPONENT_SERVICES, kv, at)).toHaveLength(0)
  })
})

describe('wiring — the cron sends the alert (#1179)', () => {
  // `cronAlertCheck` is not exported (the same reason cache-refresh.test.ts and withdrawn.test.ts pin
  // their cron wiring at the source level), so the branch is pinned here the same way.
  const CRON_START = INDEX_SRC.indexOf('async function cronAlertCheck(')
  /** The alert block, bounded to the enclosing cron function — an unbounded slice would be satisfied
   *  by the block having been moved into a function nobody calls. */
  const cronBody = () => {
    expect(CRON_START, 'cronAlertCheck not found').toBeGreaterThan(-1)
    const next = INDEX_SRC.indexOf('\nasync function ', CRON_START + 1)
    return INDEX_SRC.slice(CRON_START, next > -1 ? next : undefined)
  }

  it('detects over the derived roster INSIDE cronAlertCheck — not in a function nobody calls', () => {
    // Full argument list, like the formatter pin below: leaving the third argument unanchored lets a
    // `0` in place of `partialNow` disarm the alert permanently while tsc and the suite stay green.
    expect(cronBody()).toMatch(/detectPartialResolves\(PARTIAL_COMPONENT_SERVICES, env\.STATUS_CACHE, partialNow\)/)
  })

  it('runs UNCONDITIONALLY in the cron, not nested inside another branch', () => {
    // Nesting it under the #135 `mismatches.length > 0` branch would leave the detector reachable
    // only when a PRIMARY id also went missing — precisely the case #1179 exists to exclude. Brace
    // depth, not indentation: wrapping the block in an `if` while leaving its body indented as-is is
    // exactly what a minimal edit looks like, and an indentation check reads that as unchanged.
    const body = cronBody()
    const upToCall = body.slice(0, body.indexOf('const partials = await detectPartialResolves'))
    let depth = 0
    for (const ch of upToCall) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    expect(depth, 'the partial-resolve sweep is nested inside another block').toBe(1) // 1 = the function body itself
  })

  it('passes the service name and the RECORDED observation to the formatter', () => {
    // Pins the argument list, not just the callee: hardcoding the last argument would silently kill
    // the #1175-revert callout, and passing svc.id would title the alert with a slug.
    expect(cronBody()).toMatch(/formatPartialResolveAlert\(svc\.name, svc\.missing, svc\.since, partialNow, svc\.viaSummary\)/)
  })

  it('writes the 24h dedup key ONLY on a successful send', () => {
    // sendDiscordAlert returns false rather than throwing, so an unconditional write swallows the
    // page for 24h on a 429.
    const body = cronBody()
    const block = body.slice(body.indexOf('const partials = await detectPartialResolves'))
    expect(block).toMatch(/const sent = await sendDiscordAlert\(/)
    expect(block).toMatch(/title: `⚠️ Partial Component Resolve: \$\{svc\.name\}`/) // not svc.id
    expect(block).toMatch(/if \(sent\) \{\s*await kvPut\(env\.STATUS_CACHE, svc\.alertKey, '1', \{ expirationTtl: 86400 \}\)/)
    expect(block).toMatch(/was NOT delivered/)
  })

  it('services.ts reports from the secondary-id miss check, with the observed fallback flag', () => {
    expect(SERVICES_SRC).toMatch(/await trackPartialResolve\(kv, config\.id, missing, Date\.now\(\), viaSummary\)/)
    expect(SERVICES_SRC).toMatch(/const viaSummary = Boolean\(config\.componentsUrl\) && breakdownComponents === summaryData\.components/)
  })
})
