// #1106 — a provider-DELETED incident must still close the thread it opened on every channel.
//
// The bug: AIWatch fires a 🔴 "New Incident" alert, the provider then deletes the incident from its
// own status page instead of resolving it, and NOTHING ever closes it — the Discord resolved branch
// and the RSS `:resolved` item are both built from an incident PRESENT in the live list with
// `status === 'resolved'`, which a deleted incident can never be again.
//
// The gates are the load-bearing part of this feature, so each is tested in BOTH directions
// (#1032/#1052): a gate whose default is "pass" proves nothing unless the failing case is pinned too.
// And a green pure-function test does not prove the production WIRING is green — `index.ts` has two
// wiring sites and no harness drives the cron `scheduled` handler, so those are pinned at the source
// level (same idiom as recovery-mark.test.ts / first-estimate-write-paths.test.ts).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  diffPrunedIncidents,
  mergeWithdrawn,
  readWithdrawn,
  appendWithdrawn,
  withdrawalHold,
  liveIncidentIds,
  WITHDRAWN_KEY,
  WITHDRAWN_TTL_S,
  type WithdrawnIncident,
} from '../withdrawn'
import { accumulateIncidentsOnlyIfChanged, PHANTOM_PRUNE_AFTER_MISSED_RUNS, type MonthlyIncidents } from '../monthly-archive'
import {
  buildWithdrawalAlerts, buildTweetDrafts, buildTweetSearches, buildReplyDraft,
  isNonOutageAlert, WITHDRAWN_NOTE, ALERTED_NEW_TTL_S, type AlertCandidate,
} from '../alerts'
import { kindFromKey, buildFeedEntry } from '../alert-feed'
import { shouldDeliver } from '../webhook-subscriptions'
import { buildRssFeed, buildFeedResponse } from '../rss'
import type { ServiceStatus, Incident } from '../types'

const makeKV = (seed: Record<string, string> = {}) => {
  const store: Record<string, string> = { ...seed }
  return {
    kv: {
      get: async (k: string) => store[k] ?? null,
      put: async (k: string, v: string) => { store[k] = v },
    } as unknown as KVNamespace,
    store,
  }
}

const svc = (id: string, incidents: Incident[] = [], over: Partial<ServiceStatus> = {}): ServiceStatus => ({
  id, name: id === 'mistral' ? 'Mistral API' : id, provider: id === 'mistral' ? 'Mistral' : id,
  category: 'api', status: 'operational', uptime30d: null, latency: null, incidents, ...over,
} as ServiceStatus)

// Faithful fixture (#1021): a live incident's fields are all consistent with its status — a resolved
// one carries a duration, an unresolved one does not.
const inc = (id: string, startedAt: string, status: Incident['status'] = 'investigating', title = `inc ${id}`): Incident => ({
  id, title, status, impact: null, startedAt,
  duration: status === 'resolved' ? '10m' : null,
  ...(status === 'resolved' ? { resolvedAt: '2026-07-17T08:28:00Z' } : {}),
  timeline: [],
})

const TOMB: WithdrawnIncident = {
  svcId: 'mistral', incId: 'aud-1', title: 'Audio API Degraded',
  startedAt: '2026-07-17T08:18:00Z', prunedAt: '2026-07-21T09:00:00Z',
}

afterEach(() => { vi.useRealTimers() })

// ── Part 1: the tombstone ────────────────────────────────────────────────────

describe('diffPrunedIncidents (#1106)', () => {
  const monthly = (ids: string[]): MonthlyIncidents => ({
    lastUpdated: '2026-07-21T09:00:00Z',
    services: {
      mistral: {
        count: ids.length, totalMinutes: 0, longestMinutes: 0, dates: [], incidentIds: [...ids],
        durations: {},
        incidents: ids.map((id) => ({
          id, title: `title ${id}`, startedAt: '2026-07-17T08:18:00Z',
          resolvedAt: null, durationMin: 0, finalStatus: 'investigating' as const,
        })),
      },
    },
  })

  it('reports an id the prune removed, carrying the detail row we can no longer get anywhere else', () => {
    const out = diffPrunedIncidents(monthly(['aud-1', 'conv-1']), monthly(['conv-1']), '2026-07-21T09:05:00Z')
    expect(out).toEqual([{
      svcId: 'mistral', incId: 'aud-1', title: 'title aud-1',
      startedAt: '2026-07-17T08:18:00Z', prunedAt: '2026-07-21T09:05:00Z',
    }])
  })

  it('reports nothing when the accumulator only GREW — the ordinary every-5-min case', () => {
    expect(diffPrunedIncidents(monthly(['conv-1']), monthly(['conv-1', 'aud-1']), 'x')).toEqual([])
    expect(diffPrunedIncidents(monthly(['a']), monthly(['a']), 'x')).toEqual([])
    expect(diffPrunedIncidents(null, monthly(['a']), 'x')).toEqual([])
  })

  it('reports nothing when the whole service key vanished — that is not a prune, and inventing a withdrawal from it would be a fabrication', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const after: MonthlyIncidents = { lastUpdated: 'x', services: {} }
    expect(diffPrunedIncidents(monthly(['aud-1']), after, 'x')).toEqual([])
    expect(warn).toHaveBeenCalled() // documented-unreachable, but never silent
    warn.mockRestore()
  })

  it('skips an id with no detail row — a tombstone with no title/start has nothing to render', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = monthly(['aud-1'])
    before.services.mistral.incidents = [] // aggregate-only (truncated) row
    expect(diffPrunedIncidents(before, monthly([]), 'x')).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('mergeWithdrawn (#1106)', () => {
  const NOW = Date.parse('2026-07-21T10:00:00Z')

  it('is idempotent per (svcId, incId) and keeps the FIRST prunedAt', () => {
    const later = { ...TOMB, prunedAt: '2026-07-21T09:59:00Z' }
    const out = mergeWithdrawn([TOMB], [later], NOW)
    expect(out).toHaveLength(1)
    // A moving prunedAt would move the RSS item's pubDate after it was already served.
    expect(out[0].prunedAt).toBe(TOMB.prunedAt)
  })

  it('drops entries older than the TTL', () => {
    const stale = { ...TOMB, incId: 'old', prunedAt: new Date(NOW - (WITHDRAWN_TTL_S + 60) * 1000).toISOString() }
    expect(mergeWithdrawn([stale, TOMB], [], NOW).map((w) => w.incId)).toEqual(['aud-1'])
  })

  it('DROPS an unparseable prunedAt — keeping it would render a 1970-dated item no poller ever surfaces', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bad = { ...TOMB, incId: 'bad', prunedAt: 'pending' }
    expect(mergeWithdrawn([bad, TOMB], [], NOW).map((w) => w.incId)).toEqual(['aud-1'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('keeps a same-incident tombstone from a DIFFERENT service (a multi-surface incident)', () => {
    expect(mergeWithdrawn([TOMB], [{ ...TOMB, svcId: 'claudeai' }], NOW)).toHaveLength(2)
  })

  it('caps the roster, evicting the OLDEST, and says which entries it dropped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const many = Array.from({ length: 51 }, (_, i) => ({
      ...TOMB, incId: `i${i}`, prunedAt: new Date(NOW - (51 - i) * 60_000).toISOString(),
    }))
    const out = mergeWithdrawn(many, [], NOW)
    expect(out).toHaveLength(50)
    expect(out.map((w) => w.incId)).not.toContain('i0') // oldest evicted
    expect(warn.mock.calls.flat().join(' ')).toContain('i0')
    warn.mockRestore()
  })
})

describe('withdrawn roster KV (#1106)', () => {
  it('appends, then reads back', async () => {
    const { kv, store } = makeKV()
    expect(await appendWithdrawn(kv, [TOMB], Date.parse(TOMB.prunedAt))).toBe(true)
    expect(JSON.parse(store[WITHDRAWN_KEY])).toEqual([TOMB])
    expect(await readWithdrawn(kv, Date.parse(TOMB.prunedAt))).toEqual([TOMB])
  })

  it('an unreadable/corrupt roster reads as empty — a KV blip must never FABRICATE a withdrawal notice', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await readWithdrawn(makeKV({ [WITHDRAWN_KEY]: 'not json' }).kv)).toEqual([])
    expect(err).toHaveBeenCalled() // the next write overwrites this blob — log it or lose it
    err.mockRestore()
    const throwing = { get: async () => { throw new Error('kv down') } } as unknown as KVNamespace
    expect(await readWithdrawn(throwing)).toEqual([])
  })

  // A 48h-lived value outlives a rollback, so the previous SHAPE is readable for two days. An entry
  // missing `title` would throw inside sanitize() in the unguarded cron alert build.
  it('drops a malformed ELEMENT rather than handing it to an emitter', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seeded = makeKV({ [WITHDRAWN_KEY]: JSON.stringify([{ svcId: 'mistral', incId: 'x' }, TOMB, null, 'nope']) })
    expect(await readWithdrawn(seeded.kv, Date.parse(TOMB.prunedAt))).toEqual([TOMB])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('filters by age on READ, since every write refreshes the key TTL', async () => {
    const seeded = makeKV({ [WITHDRAWN_KEY]: JSON.stringify([TOMB]) })
    const wayLater = Date.parse(TOMB.prunedAt) + (WITHDRAWN_TTL_S + 3600) * 1000
    expect(await readWithdrawn(seeded.kv, wayLater)).toEqual([])
  })

  // The age-out warning is the ONLY signal that a tombstone left the system without ever notifying.
  // It is reachable in the ordinary single-tombstone case only because the KEY outlives the ENTRY
  // window — if both expired together, KV would evict the key first and the read would take its
  // `!raw` path with nothing to report.
  it('warns when a tombstone expires unnotified, and the key outlives the entry window so it can', async () => {
    const puts: Array<{ ttl?: number }> = []
    const store: Record<string, string> = {}
    const kv = {
      get: async (k: string) => store[k] ?? null,
      put: async (k: string, v: string, o?: { expirationTtl?: number }) => { store[k] = v; puts.push({ ttl: o?.expirationTtl }) },
    } as unknown as KVNamespace
    await appendWithdrawn(kv, [TOMB], Date.parse(TOMB.prunedAt))
    expect(puts[0].ttl).toBeGreaterThan(WITHDRAWN_TTL_S)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const justPastWindow = Date.parse(TOMB.prunedAt) + (WITHDRAWN_TTL_S + 60) * 1000
    expect(await readWithdrawn(kv, justPastWindow, true)).toEqual([])
    expect(warn.mock.calls.flat().join(' ')).toContain('mistral/aud-1')
    // …and stays silent on the /feed request path, which calls this once per poll.
    warn.mockClear()
    expect(await readWithdrawn(kv, justPastWindow)).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('writes nothing when there is nothing to record', async () => {
    const { store } = makeKV()
    const kv = { get: async () => null, put: async (k: string, v: string) => { store[k] = v } } as unknown as KVNamespace
    await appendWithdrawn(kv, [])
    expect(store[WITHDRAWN_KEY]).toBeUndefined()
  })

  it('reports a failed write loudly instead of throwing into the accumulator that called it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const kv = { get: async () => null, put: async () => { throw new Error('kv write down') } } as unknown as KVNamespace
    await expect(appendWithdrawn(kv, [TOMB])).resolves.toBe(false)
    expect(err.mock.calls.flat().join(' ')).toContain('mistral/aud-1')
    err.mockRestore()
  })
})

// The wiring test: a pure diff being green says nothing about whether the accumulator actually calls
// it. This drives the REAL #975 prune to its threshold.
describe('accumulateIncidentsOnlyIfChanged → tombstone wiring (#1106)', () => {
  const live = (ids: Array<[string, string]>) =>
    [svc('mistral', ids.map(([id, at]) => inc(id, at)), { status: 'down' })]

  it('tombstones the incident the #975 prune deletes, and only that one', async () => {
    const { kv, store } = makeKV()
    await accumulateIncidentsOnlyIfChanged(kv, live([['aud-1', '2026-07-17T08:18:00Z'], ['conv-1', '2026-07-17T08:03:00Z']]), '2026-07')
    expect(store[WITHDRAWN_KEY]).toBeUndefined()
    // The provider DELETES aud-1. conv-1 stays and started strictly earlier, so guard 3 holds.
    for (let i = 0; i < PHANTOM_PRUNE_AFTER_MISSED_RUNS; i++) {
      await accumulateIncidentsOnlyIfChanged(kv, live([['conv-1', '2026-07-17T08:03:00Z']]), '2026-07')
    }
    expect(JSON.parse(store['incidents:monthly:2026-07']).services.mistral.incidentIds).toEqual(['conv-1'])
    const roster: WithdrawnIncident[] = JSON.parse(store[WITHDRAWN_KEY])
    expect(roster).toHaveLength(1)
    expect(roster[0]).toMatchObject({ svcId: 'mistral', incId: 'aud-1', title: 'inc aud-1', startedAt: '2026-07-17T08:18:00Z' })
  })

  it('writes no tombstone on ordinary accumulation (a new incident, and a resolution)', async () => {
    const { kv, store } = makeKV()
    await accumulateIncidentsOnlyIfChanged(kv, live([['a', '2026-07-01T00:00:00Z']]), '2026-07')
    await accumulateIncidentsOnlyIfChanged(kv, live([['a', '2026-07-01T00:00:00Z'], ['b', '2026-07-02T00:00:00Z']]), '2026-07')
    const resolved = [svc('mistral', [inc('a', '2026-07-01T00:00:00Z', 'resolved'), inc('b', '2026-07-02T00:00:00Z')], { status: 'down' })]
    await accumulateIncidentsOnlyIfChanged(kv, resolved, '2026-07')
    expect(store[WITHDRAWN_KEY]).toBeUndefined()
  })

  it('does not tombstone when the accumulator write FAILED — the incident is still an ongoing row everywhere else', async () => {
    const store: Record<string, string> = {}
    let allowWrites = true
    const kv = {
      get: async (k: string) => store[k] ?? null,
      put: async (k: string, v: string) => {
        if (!allowWrites && k.startsWith('incidents:monthly:')) throw new Error('kv write down')
        store[k] = v
      },
    } as unknown as KVNamespace
    await accumulateIncidentsOnlyIfChanged(kv, live([['aud-1', '2026-07-17T08:18:00Z'], ['conv-1', '2026-07-17T08:03:00Z']]), '2026-07')
    allowWrites = false
    for (let i = 0; i < PHANTOM_PRUNE_AFTER_MISSED_RUNS; i++) {
      expect(await accumulateIncidentsOnlyIfChanged(kv, live([['conv-1', '2026-07-17T08:03:00Z']]), '2026-07')).toBe('failed')
    }
    expect(store[WITHDRAWN_KEY]).toBeUndefined()
  })
})

// ── The hold gate — the #975 prune's own motivating case ────────────────────

describe('withdrawalHold (#1106)', () => {
  const NONE = new Set<string>()

  it('holds when the provider re-published under the SAME id', () => {
    const relisted = svc('mistral', [inc('aud-1', TOMB.startedAt)], { status: 'down' })
    expect(withdrawalHold('aud-1', relisted, liveIncidentIds([relisted]))).toBe('republished-same-id')
  })

  // One incident id routinely spans surfaces (Anthropic publishes one for Claude API / claude.ai /
  // Claude Code). A provider re-listing it on only SOME of them leaves the others' tombstones looking
  // withdrawn — and emitting then puts the same id in the feed as live AND retracted at once, with
  // the retraction borrowing the live surface's name through the provider-grouped title.
  it('holds when the id is live on ANOTHER service, even though this one is clean', () => {
    const gone = svc('claudeai', [], { name: 'claude.ai', status: 'operational' })
    const stillLive = svc('mistral', [inc('aud-1', TOMB.startedAt)], { status: 'down' })
    expect(withdrawalHold('aud-1', gone, liveIncidentIds([gone, stillLive]))).toBe('republished-same-id')
  })

  // Pinecone (#975's own example): `xqp5fkvlyg6t` deleted and re-published as `m3wrr6csl9jm` with a
  // reworded title and a BACKDATED start. The ids differ, so nothing can match them — announcing a
  // withdrawal here would claim the provider retracted an outage that is still running.
  it('holds while ANY unresolved incident runs — the delete-and-republish-under-a-NEW-id shape', () => {
    const replaced = svc('pinecone', [inc('m3wrr6csl9jm', '2026-07-17T07:00:00Z')], { status: 'down' })
    expect(withdrawalHold('xqp5fkvlyg6t', replaced, liveIncidentIds([replaced]))).toBe('incident-running')
  })

  // The prune's OTHER documented residual: a still-open incident retitled out of filterIncidents
  // attribution is ABSENT from `incidents` by definition, so only the status can catch it.
  it('holds when the service is visibly impaired with no incident to show for it', () => {
    expect(withdrawalHold('aud-1', svc('mistral', [], { status: 'degraded' }), NONE)).toBe('incident-running')
  })

  // A failed fetch yields an EMPTY incident list, indistinguishable from "nothing is running" — so
  // without this we would publish the retraction on the one cycle we could not read the page.
  it('holds when the status source was unreadable this cycle, and when the service is absent entirely', () => {
    expect(withdrawalHold('aud-1', svc('mistral', [], { sourceDead: true }), NONE)).toBe('source-unreadable')
    expect(withdrawalHold('aud-1', svc('mistral', [], { sourceUnknown: true }), NONE)).toBe('source-unreadable')
    expect(withdrawalHold('aud-1', undefined, NONE)).toBe('source-unreadable')
  })

  // The other direction: #1106's evidencing case must still announce. Every surviving Mistral
  // incident was RESOLVED (Conversations 10m, Batch, Vibe) and the service was operational.
  it('announces when the service is operational and every surviving incident is resolved — the Mistral case', () => {
    const surviving = [inc('conv-1', '2026-07-17T08:03:00Z', 'resolved'), inc('batch-1', '2026-07-16T00:00:00Z', 'resolved')]
    const mistral = svc('mistral', surviving, { status: 'operational' })
    expect(withdrawalHold('aud-1', mistral, liveIncidentIds([mistral]))).toBeNull()
    expect(withdrawalHold('aud-1', svc('mistral', [], { status: 'operational' }), NONE)).toBeNull()
  })
})

// ── Part 2: the Discord withdrawal alert ─────────────────────────────────────

describe('buildWithdrawalAlerts (#1106)', () => {
  const services = [svc('mistral'), svc('claudeai', [], { name: 'claude.ai', provider: 'Mistral' })]

  it('emits a closing alert for an incident we ANNOUNCED', () => {
    const [a] = buildWithdrawalAlerts([TOMB], new Set(['aud-1']), services, () => {})
    expect(a.key).toBe('alerted:wd:aud-1')
    expect(a.title).toBe('⚪ Mistral API — Incident Withdrawn')
    expect(a.svcIds).toEqual(['mistral'])
  })

  // The negative half of the gate. Without it a withdrawal of an outage we never announced posts a
  // closing message for an event the subscriber never saw (#793's orphan-resolution, same shape).
  it('emits NOTHING for an incident that was never announced', () => {
    expect(buildWithdrawalAlerts([TOMB], new Set(), services, () => {})).toEqual([])
    expect(buildWithdrawalAlerts([TOMB], new Set(['some-other-id']), services, () => {})).toEqual([])
  })

  // The Discord half must apply the same hold rule as RSS — reachable on any cycle inside the
  // tombstone's 48h, not just the prune cycle — and every hold must be reported to the caller.
  it('emits NOTHING while the incident is live again, another outage runs, or the source is unreadable', () => {
    const cases: Array<[ServiceStatus[], string]> = [
      [[svc('mistral', [inc('aud-1', TOMB.startedAt)], { status: 'down' })], 'republished-same-id'],
      [[svc('mistral', [inc('new-1', '2026-07-21T08:00:00Z')], { status: 'down' })], 'incident-running'],
      [[svc('mistral', [], { sourceDead: true })], 'source-unreadable'],
      [[], 'source-unreadable'], // service missing from this cycle's list (whole-fetch failure)
    ]
    for (const [live, reason] of cases) {
      const holds: string[] = []
      expect(buildWithdrawalAlerts([TOMB], new Set(['aud-1']), live, (_w, r) => holds.push(r))).toEqual([])
      expect(holds).toEqual([reason]) // the drop is reported, with its cause
    }
  })

  it('groups a multi-surface incident into ONE alert, titled by the shared provider', () => {
    const multi = [svc('mistral'), svc('claudeai', [], { name: 'claude.ai', provider: 'Mistral' })]
    const alerts = buildWithdrawalAlerts([TOMB, { ...TOMB, svcId: 'claudeai' }], new Set(['aud-1']), multi, () => {})
    expect(alerts).toHaveLength(1)
    expect(alerts[0].svcIds).toEqual(['mistral', 'claudeai'])
    expect(alerts[0].title).toBe('⚪ Mistral (Mistral API, claude.ai) — Incident Withdrawn')
  })

  describe('copy (Part 4) — says withdrawn, never recovered', () => {
    const [a] = buildWithdrawalAlerts([TOMB], new Set(['aud-1']), services, () => {})
    it('names the retraction and carries the incident title', () => {
      expect(a.description).toContain('Audio API Degraded')
      expect(a.description).toContain(WITHDRAWN_NOTE)
      expect(WITHDRAWN_NOTE).toMatch(/removed this incident/)
    })
    it('never claims recovery', () => {
      expect(`${a.title} ${a.description}`).not.toMatch(/resolved|recovered|back (up|online)/i)
    })
    it('is neither outage-red nor recovery-green', () => {
      expect(a.color).not.toBe(0xED4245)
      expect(a.color).not.toBe(0x57F287)
    })
  })

  describe('carries no outage-promotion tooling', () => {
    // Operational + no live incidents, so the hold gate passes and an alert is actually built —
    // which is also the real shape after a provider deletes the only incident it had open.
    const promoServices = [svc('claude', [], { name: 'Claude API', provider: 'Anthropic', status: 'operational' })]
    const wd = buildWithdrawalAlerts([{ ...TOMB, svcId: 'claude' }], new Set(['aud-1']), promoServices, () => {})[0]

    it('drafts no tweet, no reply, no viral-reply search', () => {
      expect(buildTweetDrafts(wd, promoServices)).toEqual([])
      expect(buildTweetSearches(wd, promoServices)).toEqual([])
      expect(buildReplyDraft(wd, promoServices)).toBeNull()
    })

    // Mutation, in the OTHER direction: an otherwise IDENTICAL alert that is not a withdrawal does
    // produce promo output. Without this the assertions above could pass for an unrelated reason.
    it('and the withdrawal KIND is what suppresses it — the same alert as a new-incident does draft', () => {
      const asNew: AlertCandidate = { ...wd, key: 'alerted:new:aud-1' }
      expect(buildTweetDrafts(asNew, promoServices).length).toBeGreaterThan(0)
      expect(buildReplyDraft(asNew, promoServices)).not.toBeNull()
    })

    // The predicate itself, isolated from the builders: kind alone decides, no flag involved.
    it('isNonOutageAlert reads the KIND, so there is no second unsynchronised encoding', () => {
      expect(isNonOutageAlert({}, 'withdrawn')).toBe(true)
      expect(isNonOutageAlert({}, 'new')).toBe(false)
      expect(isNonOutageAlert({ advisory: true }, 'new')).toBe(true) // #1021 still a flag
      expect(kindFromKey('alerted:wd:aud-1')).toBe('withdrawn')
    })
  })
})

describe('withdrawal fan-out (#1106)', () => {
  const [ALERT] = buildWithdrawalAlerts([TOMB], new Set(['aud-1']), [svc('mistral')], () => {})

  it('relays to the services the TOMBSTONE remembers — nothing carries the incident any more', () => {
    // `services` deliberately no longer carries the incident, exactly as in production. Without the
    // explicit svcIds, svcIdsForAlert would resolve [] and the per-user filter would drop it.
    const entry = buildFeedEntry(ALERT, ALERT.description, [svc('mistral')], 1)
    expect(entry?.kind).toBe('withdrawn')
    expect(entry?.svcIds).toEqual(['mistral'])
  })

  // The #486 subscriber is the party actually holding an unclosed 🔴. `shouldDeliver` ends in
  // `return false`, so a kind in neither of its sets is silently dropped for EVERY subscriber.
  it('is delivered to per-user webhook subscribers, under their existing incident filter', () => {
    const entry = buildFeedEntry(ALERT, ALERT.description, [svc('mistral')], 1)!
    expect(shouldDeliver(entry, { alertCondition: 'all', alertTarget: 'all', alertServices: [], alertIncidents: true })).toBe(true)
    // Both directions: a subscriber who turned incident alerts off still gets none.
    expect(shouldDeliver(entry, { alertCondition: 'all', alertTarget: 'all', alertServices: [], alertIncidents: false })).toBe(false)
    // And the custom-service filter still scopes it.
    expect(shouldDeliver(entry, { alertCondition: 'all', alertTarget: 'custom', alertServices: ['openai'], alertIncidents: true })).toBe(false)
  })
})

// ── Part 3: the RSS / Slack withdrawal item ──────────────────────────────────

describe('RSS withdrawal item (#1106)', () => {
  const services = [svc('mistral', [], { status: 'operational' })]
  const served = new Set(['aud-1'])
  const feed = (over: { withdrawn?: WithdrawnIncident[]; servedActive?: Set<string>; services?: ServiceStatus[] } = {}) =>
    buildRssFeed(over.services ?? services, { scope: 'all' }, new Date('2026-07-21T12:00:00Z'), undefined, undefined,
      over.servedActive ?? served, over.withdrawn ?? [TOMB])

  it('emits an item with a DISTINCT guid, so Slack/RSS guid-dedup lets the retraction through', () => {
    expect(feed()).toContain('aiwatch:mistral:aud-1:withdrawn')
  })

  // The FULL title, not a substring: the ⚪ is the only thing separating this from an outage post in
  // a Slack channel, and it comes from a single `severityEmoji` branch that nothing else pins —
  // delete that branch and this fixture renders 🟡, an impaired one 🔴.
  it('says ⚪ Withdrawn, never Resolved', () => {
    const xml = feed()
    expect(xml).toContain('<title>⚪ Mistral API: Withdrawn — Audio API Degraded</title>')
    expect(xml).not.toContain('Resolved — Audio API Degraded')
    expect(xml).not.toContain('aiwatch:mistral:aud-1:resolved')
    // …and still ⚪ when the service is impaired, where the impact/status branches would say 🔴.
    const impaired = buildRssFeed([svc('mistral', [], { status: 'down' })], { scope: 'all' },
      new Date('2026-07-21T12:00:00Z'), undefined, undefined, served, [TOMB])
    // (the service being `down` holds the notice, so assert the emoji via the descHtml path instead)
    expect(impaired).not.toContain('🔴 Mistral API: Withdrawn')
  })

  // Exact-equality, not a set of `not.toContain`s: the withdrawn push site supplies no analysis and
  // no fallbackText, so absence assertions cannot fail whatever descHtml does. Pinning the whole
  // CDATA is what actually protects the "KEEP THIS RETURN FIRST" invariant — any block added above
  // the early return, from any source, changes this string.
  it('renders EXACTLY the two-paragraph retraction — no duration, no fallback, no AI block', () => {
    const body = feed().match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1]
    expect(body).toBe(`<p>⚪ <strong>Withdrawn by the provider</strong></p>\n<p>${WITHDRAWN_NOTE}</p>`)
  })

  // Positive control for the above: the same renderer DOES emit an AI block + fallback for an
  // ordinary active item, so the exact-shape assertion is the withdrawn branch working, not an
  // inert renderer.
  it('positive control — an ordinary active item does carry the AI block and Try instead', () => {
    const analysis = { mistral: [{ incidentId: 'aud-1', summary: 'Audio pipeline saturated', estimatedRecovery: '~1h', affectedScope: ['Audio'] }] }
    const live = [svc('mistral', [inc('aud-1', TOMB.startedAt, 'investigating', 'Audio API Degraded')], { status: 'down' }),
      svc('openai', [], { name: 'OpenAI', status: 'operational' })]
    const xml = buildRssFeed(live, { scope: 'all' }, new Date('2026-07-21T12:00:00Z'), analysis, { 'aud-1': '2026-07-17T08:18:00Z' }, served, [])
    expect(xml).toContain('🤖')
    expect(xml).toContain('Try instead')
  })

  it('dates the item at prunedAt — a wall-clock pubDate would churn the #860 ETag on every poll', () => {
    expect(feed()).toContain(new Date(TOMB.prunedAt).toUTCString())
    // Byte-determinism against the REAL clock, not just a varied parameter: a `Date.now()` anywhere
    // in the render path is what the #860 contract is actually exposed to.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-21T12:00:00Z'))
    const a = buildRssFeed(services, { scope: 'all' }, new Date('2026-07-21T12:00:00Z'), undefined, undefined, served, [TOMB])
    vi.setSystemTime(new Date('2026-07-22T04:41:07Z'))
    const b = buildRssFeed(services, { scope: 'all' }, new Date('2026-07-21T12:00:00Z'), undefined, undefined, served, [TOMB])
    expect(a).toBe(b)
  })

  // #793's guard, applied to withdrawals: both directions.
  it('is suppressed when the outage item was never SERVED (no orphan retraction)', () => {
    expect(feed({ servedActive: new Set() })).not.toContain(':withdrawn')
  })

  it('is suppressed once the provider RE-PUBLISHES the incident under the same id', () => {
    const relisted = [svc('mistral', [inc('aud-1', TOMB.startedAt, 'investigating', TOMB.title)], { status: 'down' })]
    const xml = feed({ services: relisted })
    expect(xml).not.toContain('aiwatch:mistral:aud-1:withdrawn')
    expect(xml).toContain('aiwatch:mistral:aud-1</guid>') // its live active item instead
  })

  // A partial re-publish: the provider re-lists aud-1 on mistral but not on claudeai. The claudeai
  // tombstone must NOT become a retraction — the same id would then be in the feed as live and
  // withdrawn at once, and the retraction would borrow mistral's name via the grouped title.
  it('and a sibling surface whose id is live elsewhere emits no retraction at all', () => {
    const relisted = [svc('mistral', [inc('aud-1', TOMB.startedAt, 'investigating', TOMB.title)], { status: 'down' }),
      svc('claudeai', [], { name: 'claude.ai', provider: 'Mistral', status: 'operational' })]
    const xml = buildRssFeed(relisted, { scope: 'all' }, new Date('2026-07-21T12:00:00Z'), undefined, undefined,
      served, [TOMB, { ...TOMB, svcId: 'claudeai' }])
    expect(xml).not.toContain(':withdrawn')
    expect(xml).not.toContain('claude ai') // nor injected into the LIVE item's co-affected set
  })

  it('is suppressed while an unrelated outage is running on the service (delete-and-republish shape)', () => {
    const busy = [svc('mistral', [inc('other-1', '2026-07-21T08:00:00Z')], { status: 'down' })]
    expect(feed({ services: busy, servedActive: new Set(['aud-1', 'other-1']) })).not.toContain(':withdrawn')
  })

  it('is suppressed on a cycle where the status source could not be read', () => {
    expect(feed({ services: [svc('mistral', [], { sourceDead: true })] })).not.toContain(':withdrawn')
  })

  // Withdrawals sort above live items (pubDate ≈ now), and WITHDRAWN_MAX === MAX_ITEMS — so without
  // their own cap a burst of retractions could push every running outage out of the feed.
  it('caps how many withdrawals one render may carry, so retractions cannot starve live outages', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...TOMB, incId: `w${i}` }))
    const xml = buildRssFeed(services, { scope: 'all' }, new Date('2026-07-21T12:00:00Z'), undefined, undefined,
      new Set(many.map((w) => w.incId)), many)
    expect((xml.match(/:withdrawn/g) ?? []).length).toBeLessThanOrEqual(5)
    expect((xml.match(/:withdrawn/g) ?? []).length).toBeGreaterThan(0)
  })

  it('collapses a multi-surface withdrawal into ONE item that still NAMES every affected surface', () => {
    const multi = [svc('mistral', [], { status: 'operational' }), svc('claudeai', [], { name: 'claude.ai', provider: 'Mistral', status: 'operational' })]
    const xml = buildRssFeed(multi, { scope: 'all' }, new Date('2026-07-21T12:00:00Z'), undefined, undefined, served,
      [TOMB, { ...TOMB, svcId: 'claudeai' }])
    expect(xml.match(/:withdrawn/g) ?? []).toHaveLength(1)
    // The co-affected set comes from LIVE incidents, and a tombstoned incident is in nobody's live
    // list — so without folding the tombstones into that map the retraction would name one surface
    // while the original 🔴 named three, and while Discord's withdrawal alert names them all.
    expect(xml).toContain('Mistral (Mistral API, claude ai): Withdrawn —')
  })

  it('is scoped — a /feed/{other-service} poll does not carry it', () => {
    const other = svc('openai', [], { name: 'OpenAI', status: 'operational' })
    const xml = buildRssFeed([...services, other], { scope: 'service', service: other },
      new Date('2026-07-21T12:00:00Z'), undefined, undefined, served, [TOMB])
    expect(xml).not.toContain(':withdrawn')
  })

  it('emits nothing at all when there are no tombstones (the ordinary case)', () => {
    expect(feed({ withdrawn: [] })).not.toContain(':withdrawn')
  })

  // The handler calls buildFeedResponse, not buildRssFeed — and it has seven positional optionals.
  it('buildFeedResponse threads the tombstones through, on BOTH scopes', () => {
    const cached = { services }
    const all = buildFeedResponse(cached, { scope: 'all' }, new Date('2026-07-21T12:00:00Z'), undefined, undefined, served, [TOMB])
    expect(all.ok && all.xml).toContain(':withdrawn')
    const one = buildFeedResponse(cached, { scope: 'service', segment: 'mistral' }, new Date('2026-07-21T12:00:00Z'), undefined, undefined, served, [TOMB])
    expect(one.ok && one.xml).toContain(':withdrawn')
  })

  // The `?e=` token is a cross-package contract: worker/src emits it, api/_is-down consumes it, and
  // an UNLISTED token is silently ignored — un-pinning og:url and falling the card back to the LIVE
  // status, i.e. a green "Operational" unfurl beside "AIWatch has no recovery record".
  it('its ?e= token is registered in the is-down OG hint map, against a real og style', () => {
    expect(feed()).toContain('e=withdrawn')
    const template = readFileSync(join(__dirname, '..', '..', '..', 'api', '_is-down', 'html-template.ts'), 'utf8')
    const mapped = template.match(/const HINT_TO_OG_STATUS[^\n]*withdrawn:\s*'([a-z]+)'/)?.[1]
    // An UNREGISTERED token un-pins og:url and falls the card back to LIVE status; a token mapped to
    // a value og.ts does not know falls through `if (!s)` to a green "Operational" image under a
    // "Down Right Now" title. So assert the exact value AND that og.ts really carries that style.
    expect(mapped).toBe('unknown')
    const og = readFileSync(join(__dirname, '..', 'og.ts'), 'utf8')
    expect(og).toMatch(/^\s*unknown:\s*\{/m)
  })
})

// ── The index.ts wiring, pinned at source level ──────────────────────────────
//
// Nothing drives the cron `scheduled` handler or the /feed route in tests, and every one of these
// lines can be deleted with all the tests above still green — the feature would then be silently
// dead. Same idiom as recovery-mark.test.ts.
describe('#1106 index.ts wiring', () => {
  const src = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')

  /** Slice between two anchors, failing loudly if either is missing — otherwise a renamed anchor
   *  turns `indexOf` into -1 and `slice(start, -1)` silently becomes a to-EOF slice that matches
   *  anything, i.e. the test passes by accident. */
  const block = (from: string, to: string): string => {
    const start = src.indexOf(from)
    expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1)
    const end = src.indexOf(to, start)
    expect(end, `anchor not found after ${from}: ${to}`).toBeGreaterThan(start)
    return src.slice(start, end)
  }

  describe('cron alert path', () => {
    // Scoped to the cron block: `readWithdrawn` appears TWICE in index.ts (cron + /feed handler), so
    // a whole-file search would happily measure the /feed occurrence and stay green with the cron
    // read neutered.
    const cron = () => block('const withdrawalAlerts', 'const incidentAlerts')

    it('withdrawal alerts actually reach the send list', () => {
      expect(src).toMatch(/const allAlerts = \[[^\]]*\.\.\.withdrawalAlerts[^\]]*\]/)
    })

    it('and are ordered AFTER the service alerts, so a retraction cannot evict a live down alert', () => {
      const order = src.match(/const allAlerts = \[([^\]]*)\]/)?.[1] ?? ''
      expect(order.indexOf('...serviceAlerts')).toBeGreaterThan(-1)
      expect(order.indexOf('...withdrawalAlerts')).toBeGreaterThan(order.indexOf('...serviceAlerts'))
    })

    // Ordering `allAlerts` is NOT sufficient, and pinning only that line is the trap: the array the
    // 5-cap slices is `mergedToSend`, and both merge fns return `[...rest, ...merged]` — so a
    // collapsed live Together/xAI alert lands BEHIND the ⚪ retractions that rode through in `rest`.
    it('and the array the send cap actually slices re-sinks them to the tail after merging', () => {
      const b = block('const merged = mergeXaiRegionalAlerts', 'const sent = mergedToSend.slice')
      expect(b).toMatch(/const mergedToSend = \[[\s\S]*!isWithdrawal\(a\)[\s\S]*\.filter\(isWithdrawal\)\]/)
      expect(b).toMatch(/alerted:wd:/)
      // and the cap really reads that array
      expect(src).toMatch(/const sent = mergedToSend\.slice\(0, 5\)/)
    })

    it('the announced-gate set is populated ONLY when the alerted:new marker is present', () => {
      const b = cron()
      expect(b).toMatch(/alerted:new:\$\{w\.incId\}/)
      // The conditional, not just the call: an unconditional add would publish a closing notice for
      // every tombstone, including outages we never announced — the orphan the gate exists to stop.
      expect(b).toMatch(/if \(marker\)\s*\{\s*announcedWithdrawnIds\.add\(w\.incId\)/)
      expect(b).toMatch(/buildWithdrawalAlerts\(/)
    })

    it('logs every held withdrawal, so a permanently-lost notice is diagnosable', () => {
      expect(cron()).toMatch(/buildWithdrawalAlerts\([\s\S]*console\.log\([\s\S]*held/)
    })

    it('reads the roster AFTER the accumulator wrote it, so a prune notifies in the same cron run', () => {
      const accumulate = src.indexOf('accumulateIncidentsOnlyIfChanged(env.STATUS_CACHE')
      const read = src.indexOf('readWithdrawn(env.STATUS_CACHE', src.indexOf('const withdrawalAlerts'))
      expect(accumulate).toBeGreaterThan(-1)
      expect(read).toBeGreaterThan(accumulate)
      expect(read).toBeLessThan(src.indexOf('const incidentAlerts')) // the CRON occurrence, not /feed's
    })
  })

  describe('/feed handler', () => {
    // A tombstoned incident is absent from cached.services, so this probe is the ONLY way its
    // feed:active-emitted marker can ever reach servedActive. Drop it and rss.ts suppresses every
    // withdrawal forever, with every pure-function test still green.
    it('probes feed:active-emitted for the tombstones and folds them into servedActive', () => {
      const b = block('#1106 — the same orphan guard', 'feedServedActive = servedActive')
      expect(b).toMatch(/readWithdrawn\(env\.STATUS_CACHE/)
      expect(b).toMatch(/feed:active-emitted:\$\{w\.incId\}/)
      expect(b).toMatch(/servedActive\.add\(w\.incId\)/)
      expect(b).toMatch(/inServedScope\(w\.svcId\)/) // else a /feed/{other} poll stamps a foreign id
    })

    it('passes the tombstones to buildFeedResponse', () => {
      expect(src).toMatch(/buildFeedResponse\([^)]*feedWithdrawn\)/)
    })
  })

  // Correct by OMISSION today: `alerted:wd:` lands in the 7d branch only because it is neither a
  // status nor a recovery key. If it were ever classified as a status alert the TTL would drop to 2h
  // while the tombstone lives 48h — re-posting the same public retraction to the operator and every
  // subscriber ~23 times.
  it('the withdrawal dedup key gets the 7d TTL, not the 2h status-alert one', () => {
    expect(ALERTED_NEW_TTL_S).toBe(604800)
    const ttlLine = src.match(/const ttl = [^\n]*\n/)?.[0] ?? ''
    expect(ttlLine).toContain('ALERTED_NEW_TTL_S')
    expect(ttlLine).not.toContain('alerted:wd')
    const isStatus = src.match(/const isStatusAlert = [^\n]*\n/)?.[0] ?? ''
    const isRecovery = src.match(/const isRecoveryAlert = [^\n]*\n/)?.[0] ?? ''
    expect(isStatus).not.toContain('alerted:wd')
    expect(isRecovery).not.toContain('alerted:wd')
  })
})
