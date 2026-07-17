import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  computeMonthlyUptime,
  computeMonthlyComponentUptime,
  curateComponentUptime,
  computeMonthlyOfficialUptime,
  computeMonthlyLatency,
  computeMonthlyScore,
  computeMonthlyLatencyStats,
  getMonthDates,
  isInMonthlyArchiveWindow,
  buildMonthlyArchive,
  accumulateMonthlyIncidents,
  prunePhantomIncidents,
  PHANTOM_PRUNE_AFTER_MISSED_RUNS,
  accumulateIncidentsOnlyIfChanged,
  buildPartialIncidentArchive,
  parseDurationMin,
  summarizeSecurityAlerts,
  extractOsvVulnId,
  enrichTopFindingsWithTimelines,
  buildArchiveReadyEmbed,
  archiveNotifiedKey,
  REPORTS_WORKFLOW_URL,
  MAX_INCIDENTS_PER_SERVICE_IN_ARCHIVE,
  degradationMonthlyKey,
  addDegradationToMonthly,
  normalizeDegradationMonthly,
  summarizeDegradation,
  buildMonthlyAccuracy,
  filterSuppressedFromMonthly,
  stripInternalFields,
  aggregateIncidentDurations,
  resolveArchiveOfficialUptime,
  resolveArchiveProbeSummary,
} from '../monthly-archive'
import type { SuppressionEntry } from '../suppression'
import type { ServiceStatus, Incident } from '../types'
import type { IncidentHistoryRecord } from '../incident-history'
import type { MonthlySecurityEntry, MonthlySecuritySummary, MonthlyIncidents, MonthlyIncidentEntry } from '../monthly-archive'
import type { OsvTimeline } from '../security-monitor'
import { SERVICE_ADDED_AT, resolveSvcComponents } from '../services'

// ── parseDurationMin ─────────────────────────────────────────────────

describe('buildMonthlyAccuracy (#827 F3 — monthly prediction accuracy)', () => {
  const histKV = (byService: Record<string, IncidentHistoryRecord[]>) => ({
    get: async (k: string) => {
      const m = /^incident:history:(.+)$/.exec(k)
      return m && byService[m[1]] ? JSON.stringify(byService[m[1]]) : null
    },
  } as unknown as KVNamespace)
  const rec = (over: Partial<IncidentHistoryRecord> = {}): IncidentHistoryRecord => ({ svcId: 'claude', incId: 'x', title: 't', provider: 'A', category: 'api', impact: 'major', startedAt: '2026-06-01T00:00:00Z', resolvedAt: '2026-06-15T01:00:00Z', durationMin: 60, ...over })

  it('aggregates only records whose resolvedAt falls in the period (across services)', async () => {
    const kv = histKV({
      claude: [
        rec({ incId: 'a', resolvedAt: '2026-06-10T00:00:00Z', predictedRecoveryHours: 1, durationMin: 50 }),  // June, accurate
        rec({ incId: 'b', resolvedAt: '2026-05-30T00:00:00Z', predictedRecoveryHours: 1, durationMin: 50 }),  // MAY → excluded
      ],
      openai: [
        rec({ svcId: 'openai', incId: 'c', resolvedAt: '2026-06-20T00:00:00Z', predictedRecoveryHours: 1, durationMin: 200 }), // June, under
        rec({ svcId: 'openai', incId: 'd', resolvedAt: '2026-06-21T00:00:00Z' }),                                              // June, NO prediction → not counted
      ],
    })
    const stats = await buildMonthlyAccuracy(kv, '2026-06', ['claude', 'openai'])
    expect(stats).not.toBeNull()
    expect(stats!.total).toBe(2)        // 2 June records WITH a prediction (the May one + the prediction-less one excluded)
    expect(stats!.accurate).toBe(1)
    expect(stats!.underPredicted).toBe(1)
  })

  it('returns null when the month has no predicted+resolved incident', async () => {
    const kv = histKV({ claude: [rec({ resolvedAt: '2026-05-01T00:00:00Z', predictedRecoveryHours: 1 })] }) // May only
    expect(await buildMonthlyAccuracy(kv, '2026-06', ['claude'])).toBeNull()
    // also null when records exist but none carry a prediction
    const kv2 = histKV({ claude: [rec({ resolvedAt: '2026-06-10T00:00:00Z' })] })
    expect(await buildMonthlyAccuracy(kv2, '2026-06', ['claude'])).toBeNull()
  })

  it('handles services with no history (missing key) without throwing', async () => {
    const kv = histKV({})
    expect(await buildMonthlyAccuracy(kv, '2026-06', ['claude', 'openai'])).toBeNull()
  })

  it('includes/excludes records exactly at the month boundary (UTC)', async () => {
    const kv = histKV({ claude: [
      rec({ incId: 'in', resolvedAt: '2026-06-30T23:59:59Z', predictedRecoveryHours: 1, durationMin: 50 }), // last instant of June → IN
      rec({ incId: 'out', resolvedAt: '2026-07-01T00:00:00Z', predictedRecoveryHours: 1, durationMin: 50 }),// first of July → OUT
    ] })
    const stats = await buildMonthlyAccuracy(kv, '2026-06', ['claude'])
    expect(stats!.total).toBe(1)
  })

  it('wiring: buildMonthlyArchive carries predictionAccuracy through to the archive (→ /api/report)', async () => {
    const history: Record<string, IncidentHistoryRecord[]> = {
      claude: [rec({ incId: 'a', resolvedAt: '2026-06-15T00:00:00Z', predictedRecoveryHours: 1, durationMin: 52 })],
    }
    const kv = {
      get: async (k: string) => {
        const m = /^incident:history:(.+)$/.exec(k)
        return m && history[m[1]] ? JSON.stringify(history[m[1]]) : null // every other archive key → null (handled)
      },
    } as unknown as KVNamespace
    const archive = await buildMonthlyArchive(kv, 2026, 6)
    expect(archive.predictionAccuracy).not.toBeNull()
    expect(archive.predictionAccuracy!.total).toBe(1)
    expect(archive.predictionAccuracy!.accurate).toBe(1)
  })
})

describe('parseDurationMin', () => {
  it('parses "2h 30m" to 150', () => {
    expect(parseDurationMin('2h 30m')).toBe(150)
  })

  it('parses hours only "3h" to 180', () => {
    expect(parseDurationMin('3h')).toBe(180)
  })

  it('parses minutes only "45m" to 45', () => {
    expect(parseDurationMin('45m')).toBe(45)
  })

  it('parses "1h" to 60', () => {
    expect(parseDurationMin('1h')).toBe(60)
  })

  it('returns 0 for empty string', () => {
    expect(parseDurationMin('')).toBe(0)
  })

  it('returns 0 for falsy input', () => {
    expect(parseDurationMin(null as unknown as string)).toBe(0)
    expect(parseDurationMin(undefined as unknown as string)).toBe(0)
  })

  it('handles NaN gracefully (non-numeric prefix)', () => {
    // "abch 30m" → parseInt("abc") = NaN → 0, parseInt("30") = 30
    expect(parseDurationMin('abch 30m')).toBe(30)
  })

  it('handles "~2h 30m" (tilde prefix)', () => {
    // "~2h" → parseInt("~2") = NaN → 0 hours, but "30m" → 30
    // Note: this is a known limitation — approximate durations with "~" lose hours
    const result = parseDurationMin('~2h 30m')
    expect(result).toBe(30) // ~prefix makes parseInt fail on hours
  })
})

// ── getMonthDates ────────────────────────────────────────────────────

describe('getMonthDates', () => {
  it('returns all dates for March 2026', () => {
    const dates = getMonthDates(2026, 3)
    expect(dates).toHaveLength(31)
    expect(dates[0]).toBe('2026-03-01')
    expect(dates[30]).toBe('2026-03-31')
  })

  it('returns 28 dates for February (non-leap)', () => {
    expect(getMonthDates(2025, 2)).toHaveLength(28)
  })

  it('returns 29 dates for February (leap year)', () => {
    expect(getMonthDates(2024, 2)).toHaveLength(29)
  })
})

// ── computeMonthlyUptime ─────────────────────────────────────────────

describe('computeMonthlyUptime', () => {
  it('computes uptime% from daily counters', () => {
    const dailyData = {
      '2026-03-01': { claude: { ok: 280, total: 288 }, openai: { ok: 288, total: 288 } },
      '2026-03-02': { claude: { ok: 288, total: 288 }, openai: { ok: 288, total: 288 } },
    }
    const result = computeMonthlyUptime(dailyData)
    expect(result.claude).toBeCloseTo(98.61, 1)
    expect(result.openai).toBe(100)
  })

  it('handles empty data', () => {
    expect(Object.keys(computeMonthlyUptime({}))).toHaveLength(0)
  })

  it('returns 0 for total=0', () => {
    const dailyData = { '2026-03-01': { claude: { ok: 0, total: 0 } } }
    expect(computeMonthlyUptime(dailyData).claude).toBe(0)
  })
})

// ── computeMonthlyComponentUptime (#605 Phase 2) ─────────────────────
describe('computeMonthlyComponentUptime (#605)', () => {
  it('aggregates per-component uptime across days, sorted least-reliable first', () => {
    const daily = {
      '2026-06-01': { openai: { ok: 288, total: 288, components: {
        api: { ok: 288, total: 288, name: 'API' },
        batch: { ok: 280, total: 288, name: 'Batch' },
      } } },
      '2026-06-02': { openai: { ok: 288, total: 288, components: {
        api: { ok: 288, total: 288, name: 'API' },
        batch: { ok: 288, total: 288, name: 'Batch' }, // batch recovered
      } } },
    }
    const r = computeMonthlyComponentUptime(daily)
    expect(r.openai).toEqual([
      { id: 'batch', name: 'Batch', uptime: 98.61 }, // (280+288)/(288+288) → least reliable first
      { id: 'api', name: 'API', uptime: 100 },
    ])
  })

  it('omits services with no per-component data, and keeps the latest component name', () => {
    const daily = {
      '2026-06-01': {
        claude: { ok: 288, total: 288 }, // no components → omitted
        cohere: { ok: 288, total: 288, components: { m1: { ok: 288, total: 288, name: 'old-model' }, m2: { ok: 288, total: 288, name: 'Coral' } } },
      },
      '2026-06-02': { cohere: { ok: 288, total: 288, components: { m1: { ok: 288, total: 288, name: 'new-model' }, m2: { ok: 288, total: 288, name: 'Coral' } } } },
    }
    const r = computeMonthlyComponentUptime(daily)
    expect(r.claude).toBeUndefined()
    expect(r.cohere.find(c => c.id === 'm1')!.name).toBe('new-model') // latest name
    expect(r.cohere).toHaveLength(2)
  })

  it('breaks equal-uptime ties by name (ascending), and drops zero-sample components', () => {
    const daily = {
      '2026-06-01': { svc: { ok: 288, total: 288, components: {
        z: { ok: 288, total: 288, name: 'Zebra' },   // 100%
        a: { ok: 288, total: 288, name: 'Apple' },    // 100% — ties with Zebra → name asc
        n: { ok: 0, total: 0, name: 'NoSamples' },    // zero-sample → dropped
      } } },
    }
    expect(computeMonthlyComponentUptime(daily).svc).toEqual([
      { id: 'a', name: 'Apple', uptime: 100 },
      { id: 'z', name: 'Zebra', uptime: 100 },
    ])
  })

  it('returns {} for empty data', () => {
    expect(computeMonthlyComponentUptime({})).toEqual({})
  })
})

// ── curateComponentUptime (#605 Phase 3 — display-set curation) ──────
describe('curateComponentUptime (#605 Phase 3)', () => {
  const comps = [
    { id: 'fedramp', name: 'FedRAMP', uptime: 42.27 },      // noise
    { id: 'chat', name: 'Chat Completions', uptime: 99.98 },
    { id: 'emb', name: 'Embeddings', uptime: 99.99 },
    { id: 'login', name: 'Login', uptime: 99.66 },          // noise
  ]

  it('displayComponentIds allowlist keeps only the listed ids (drops FedRAMP/Login noise), preserving order', () => {
    const out = curateComponentUptime(comps, { displayComponentIds: ['chat', 'emb'] })
    expect(out).toEqual([
      { id: 'chat', name: 'Chat Completions', uptime: 99.98 },
      { id: 'emb', name: 'Embeddings', uptime: 99.99 },
    ])
  })

  it('displayAllComponents keeps all EXCEPT componentDenylist (by name, case-insensitive)', () => {
    const out = curateComponentUptime(comps, { displayAllComponents: true, componentDenylist: ['FedRAMP', 'login'] })
    expect(out!.map(c => c.id)).toEqual(['chat', 'emb'])
  })

  it('falls back to statusComponentIds when displayComponentIds absent', () => {
    const out = curateComponentUptime(comps, { statusComponentIds: ['chat', 'login'] })
    expect(out!.map(c => c.id)).toEqual(['chat', 'login'])
  })

  it('returns undefined when no display config (component table omitted)', () => {
    expect(curateComponentUptime(comps, {})).toBeUndefined()
  })

  it('returns undefined when <2 survive (a one-row breakdown adds nothing)', () => {
    expect(curateComponentUptime(comps, { displayComponentIds: ['chat'] })).toBeUndefined()
  })

  it('returns undefined for empty/absent components or config', () => {
    expect(curateComponentUptime([], { displayComponentIds: ['chat'] })).toBeUndefined()
    expect(curateComponentUptime(undefined, { displayComponentIds: ['chat'] })).toBeUndefined()
    expect(curateComponentUptime(comps, undefined)).toBeUndefined()
  })

  // Parity guard: the report's curation and the dashboard's live curation are maintained in
  // parallel (curateComponentUptime here vs resolveSvcComponents in services.ts). Feeding the
  // SAME config + component set to both must yield the SAME membership (id set) — otherwise the
  // report highlights different components than the dashboard, the exact bug this whole feature
  // exists to prevent. (Order can differ — report is least-reliable-first — so compare Sets.)
  it('membership matches resolveSvcComponents (report == dashboard)', () => {
    const raw = [
      { id: 'fedramp', name: 'FedRAMP' },
      { id: 'chat', name: 'Chat Completions' },
      { id: 'emb', name: 'Embeddings' },
      { id: 'login', name: 'Login' },
    ]
    const cases = [
      { displayComponentIds: ['chat', 'emb', 'login'] },
      { displayAllComponents: true, componentDenylist: ['FedRAMP', 'Login'] },
      { statusComponentIds: ['chat', 'emb'] },
      {}, // no config → both empty
    ]
    for (const config of cases) {
      const live = resolveSvcComponents(config, { components: raw.map(c => ({ ...c, status: 'operational' })) })
      const report = curateComponentUptime(raw.map(c => ({ ...c, uptime: 99 })), config) ?? []
      expect(new Set(report.map(c => c.id))).toEqual(new Set(live.map(c => c.id)))
    }
  })
})

// ── computeMonthlyOfficialUptime (#586 daily snapshot) ───────────────
describe('computeMonthlyOfficialUptime (#586)', () => {
  it('returns the most-recent day\'s officialUptime per service', () => {
    // #951 — the fixture is dense enough that the 1st falls OUTSIDE the tail window, so this now
    // guards the cutoff too: the later day wins for chatgpt, and openai's early-only value is residue
    // (it published nothing for the rest of the month) rather than a month-end figure to be "carried".
    const daily = {
      '2026-06-01': { chatgpt: { ok: 200, total: 288, officialUptime: 98.5 }, openai: { ok: 288, total: 288, officialUptime: 99.9 } },
      '2026-06-28': { chatgpt: { ok: 210, total: 288, officialUptime: 99.7 } },
      '2026-06-29': { chatgpt: { ok: 210, total: 288, officialUptime: 99.8 } },
      '2026-06-30': { chatgpt: { ok: 210, total: 288, officialUptime: 99.83 } },
    }
    const r = computeMonthlyOfficialUptime(daily)
    expect(r.chatgpt).toBe(99.83)   // month-end value, not the earlier 98.5
    expect(r.openai).toBeUndefined() // last seen on the 1st → not month-end data (pre-#951 carried it)
  })
  it('omits services with no officialUptime on any day (→ caller falls back to null)', () => {
    const daily = { '2026-06-01': { cohere: { ok: 288, total: 288 } } } // no officialUptime field
    expect(computeMonthlyOfficialUptime(daily).cohere).toBeUndefined()
  })
  it('skips null/undefined daily values, keeping the last real one', () => {
    const daily = {
      '2026-06-01': { gemini: { ok: 280, total: 288, officialUptime: 97.0 } },
      '2026-06-15': { gemini: { ok: 288, total: 288, officialUptime: null } }, // null does not clobber
    }
    expect(computeMonthlyOfficialUptime(daily).gemini).toBe(97.0)
  })

  // #951 — "as of the LATEST day" now means it. A sticky last-non-null let a value observed mid-month
  // stand in for month end, which is how the pre-#713 estimate and Character.AI's dead source survived.
  it('#951 ignores a value that stopped being published before the month\'s final days', () => {
    const daily: Record<string, Record<string, { ok: number; total: number; officialUptime?: number | null }>> = {}
    for (let d = 13; d <= 30; d++) {
      const day = `2026-06-${String(d).padStart(2, '0')}`
      daily[day] = {
        stability: { ok: 288, total: 288, officialUptime: d <= 17 ? 100 : null }, // estimate until #713 (06-19)
        groq: { ok: 288, total: 288, officialUptime: 100 },                       // a real source, all month
      }
    }
    const r = computeMonthlyOfficialUptime(daily)
    expect(r.stability).toBeUndefined() // last seen 06-17, thirteen days before month end → residue
    expect(r.groq).toBe(100)
  })

  it('#951 tolerates a transient null on the final day (the snapshot is that day\'s last cron cycle)', () => {
    const daily = {
      '2026-06-28': { groq: { ok: 288, total: 288, officialUptime: 100 } },
      '2026-06-29': { groq: { ok: 288, total: 288, officialUptime: 99.98 } },
      '2026-06-30': { groq: { ok: 288, total: 288, officialUptime: null } }, // one bad fetch
    }
    expect(computeMonthlyOfficialUptime(daily).groq).toBe(99.98)
  })

  it('#951 drops a source that has been silent for the whole tail window', () => {
    const daily = {
      '2026-06-28': { characterai: { ok: 288, total: 288, officialUptime: null } },
      '2026-06-29': { characterai: { ok: 288, total: 288, officialUptime: null } },
      '2026-06-30': { characterai: { ok: 288, total: 288, officialUptime: null } },
    }
    expect(computeMonthlyOfficialUptime(daily).characterai).toBeUndefined()
  })
})

// ── resolveArchiveProbeSummary (#1002 / aiwatch-reports#76 — the SAME display ≡ score rule) ──
// Responsiveness is 20% of the Score and neither of its two inputs was published anywhere: both are
// computed at build time to derive monthlyScore, then discarded. Publishing them is only safe if the
// figure shown is the figure that scored — hence delegating to classifyProbe rather than re-deriving
// "is this probe scorable?". These tests pin that delegation from both sides.
const summary = (p50: number, cvCombined: number, validDays = 30) => ({ p50, p95: p50 * 2, cvCombined, validDays })

describe('resolveArchiveProbeSummary (#1002 / aiwatch-reports#76)', () => {
  it('returns the p50 + cvCombined the month Responsiveness actually scored', () => {
    const summaries = new Map([['groq', summary(174, 0.21)]])
    expect(resolveArchiveProbeSummary('groq', summaries)).toEqual({ p50LatencyMs: 174, cvCombined: 0.21 })
  })

  it('an inheriting service reports its PARENT probe (#883) — the p50 that moved its Score', () => {
    // claudecode/codex have no probe of their own; resolveProbeId points them at claude/openai, and
    // computeMonthlyScore scores them on that summary. Keying by the service's own id would return null
    // here and publish "—" for a service whose Score DID include a Responsiveness component.
    const summaries = new Map([['claude', summary(173, 0.4)], ['openai', summary(223, 0.3)]])
    expect(resolveArchiveProbeSummary('claudecode', summaries)).toEqual({ p50LatencyMs: 173, cvCombined: 0.4 })
    expect(resolveArchiveProbeSummary('codex', summaries)).toEqual({ p50LatencyMs: 223, cvCombined: 0.3 })
  })

  it('withholds for a service with no probe at all (Score has no Responsiveness component)', () => {
    // bedrock is not a PROBE_TARGET → classifyProbe 'unsupported'. A stray summary under its id must
    // not be published as if it scored.
    expect(resolveArchiveProbeSummary('bedrock', new Map([['bedrock', summary(500, 0.2)]]))).toBeNull()
  })

  it("withholds when the probe is 'insufficient' — probed, but the Score scored NO Responsiveness", () => {
    // The subtle one, and the reason this delegates rather than checking PROBED_IDS alone: <7 valid days
    // costs a confidence penalty and yields no component. Publishing that p50 would show a figure the
    // Score explicitly declined to use — the #951 defect, rebuilt on a new field.
    expect(resolveArchiveProbeSummary('groq', new Map([['groq', summary(174, 0.21, 6)]]))).toBeNull()
    expect(resolveArchiveProbeSummary('groq', new Map([['groq', summary(0, 0.21, 30)]]))).toBeNull()
  })

  it('withholds when the month produced no summary for the probe', () => {
    // summariesFromDailyData drops partial / spike-dominated / extreme-spread days and needs >=2
    // survivors, so a probed service can legitimately have no month summary at all.
    expect(resolveArchiveProbeSummary('groq', new Map())).toBeNull()
  })
})

// ── resolveArchiveOfficialUptime (#951 — display must agree with the Score) ──
// The archive showed "Official · 100.00% uptime" beside a Score that was rescaled over /60 as if no
// uptime existed. Two independent ways the two drifted apart, both reproduced below.
describe('resolveArchiveOfficialUptime (#951 + #1016)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('emits the month-end daily snapshot for a service the Score scored on uptime', () => {
    expect(resolveArchiveOfficialUptime(100, { id: 'groq', scoreConfidence: 'high' })).toBe(100)
    expect(resolveArchiveOfficialUptime(99.83, { id: 'chatgpt', scoreConfidence: 'high' })).toBe(99.83)
  })

  it('#1016 — returns null when there is NO daily snapshot, never a live services:latest fallback', () => {
    // The rebuild path used to fall back to today's live `uptime30d` here, surfacing "Official · 100%"
    // on a frozen month whose monthlyScore had dropped uptime (openrouter, June). A high LIVE confidence
    // must not conjure a value the month never recorded.
    expect(resolveArchiveOfficialUptime(undefined, { id: 'openrouter', scoreConfidence: 'high' })).toBeNull()
  })

  it('withholds a month-end value the Score did not consume (would print "Official" beside a /60 score)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveArchiveOfficialUptime(100, { id: 'groq', scoreConfidence: 'medium' })).toBeNull()
    // Discarding a month-observed figure is exactly the silent drop this issue is about — it must warn.
    // (Reachable when a status-page fetch fails on the single build-day read of services:latest.)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain('withholding month-end official uptime 100')
  })

  it('does NOT warn when there was no month-end value to discard (openrouter never publishes one)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveArchiveOfficialUptime(undefined, { id: 'openrouter', scoreConfidence: 'medium' })).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps the month-end value when services:latest was unreadable (no score to contradict)', () => {
    // index.ts console.errors the parse failure and passes scoreData=[]. Nulling everything would let
    // ONE parse failure erase every service's official uptime from an archive the cron never rebuilds.
    expect(resolveArchiveOfficialUptime(99.83, undefined)).toBe(99.83)
    expect(resolveArchiveOfficialUptime(undefined, undefined)).toBeNull()
  })

  it('emits the month-end snapshot only (never a live value) for a caller that omits scoreConfidence', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveArchiveOfficialUptime(99.5, { id: 'legacy' })).toBe(99.5)
    expect(resolveArchiveOfficialUptime(undefined, { id: 'legacy' })).toBeNull()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0][0]).toContain('omits scoreConfidence')
  })
})

// ── computeMonthlyLatency ────────────────────────────────────────────

describe('computeMonthlyLatency', () => {
  it('averages probe RTT p75 across days', () => {
    const probeData = {
      '2026-03-01': { claude: { p50: 100, p75: 200, p95: 300, min: 50, max: 400, count: 100, spikes: 0 } },
      '2026-03-02': { claude: { p50: 110, p75: 220, p95: 310, min: 55, max: 410, count: 100, spikes: 1 } },
      '2026-03-03': { claude: { p50: 105, p75: 210, p95: 305, min: 52, max: 405, count: 100, spikes: 0 } },
    }
    expect(computeMonthlyLatency(probeData).claude).toBe(210)
  })

  it('skips days with p75=0', () => {
    const probeData = {
      '2026-03-01': { openai: { p50: 0, p75: 0, p95: 0, min: 0, max: 0, count: 5, spikes: 5 } },
      '2026-03-02': { openai: { p50: 150, p75: 300, p95: 450, min: 100, max: 500, count: 100, spikes: 0 } },
    }
    expect(computeMonthlyLatency(probeData).openai).toBe(300)
  })

  it('skips negative p75', () => {
    const probeData = {
      '2026-03-01': { groq: { p50: 0, p75: -1, p95: 0, min: 0, max: 0, count: 1, spikes: 1 } },
      '2026-03-02': { groq: { p50: 50, p75: 100, p95: 150, min: 30, max: 200, count: 50, spikes: 0 } },
    }
    expect(computeMonthlyLatency(probeData).groq).toBe(100)
  })

  it('handles empty data', () => {
    expect(Object.keys(computeMonthlyLatency({}))).toHaveLength(0)
  })
})

describe('computeMonthlyLatencyStats (#17 — p95 + spikes)', () => {
  it('averages valid daily p95 and sums spikes', () => {
    const probeData = {
      '2026-03-01': { claude: { p50: 100, p75: 200, p95: 300, min: 50, max: 400, count: 100, spikes: 2 } },
      '2026-03-02': { claude: { p50: 110, p75: 220, p95: 320, min: 55, max: 410, count: 100, spikes: 3 } },
    }
    expect(computeMonthlyLatencyStats(probeData).claude).toEqual({ p95: 310, spikes: 5 })
  })

  it('p95 is null when no day has a valid (>0) p95, but spikes still accumulate', () => {
    // A probe-failure-only day stores p95=0 — must not render a misleading "0 ms".
    const probeData = {
      '2026-03-01': { openai: { p50: 0, p75: 0, p95: 0, min: 0, max: 0, count: 5, spikes: 5 } },
      '2026-03-02': { openai: { p50: 0, p75: 0, p95: 0, min: 0, max: 0, count: 3, spikes: 3 } },
    }
    expect(computeMonthlyLatencyStats(probeData).openai).toEqual({ p95: null, spikes: 8 })
  })

  it('excludes p95=0 days from the average but keeps valid ones', () => {
    const probeData = {
      '2026-03-01': { groq: { p50: 0, p75: 0, p95: 0, min: 0, max: 0, count: 5, spikes: 1 } },
      '2026-03-02': { groq: { p50: 50, p75: 100, p95: 150, min: 30, max: 200, count: 50, spikes: 0 } },
    }
    expect(computeMonthlyLatencyStats(probeData).groq).toEqual({ p95: 150, spikes: 1 })
  })

  it('spikes total is 0 (not null) when service has valid p95 but no spikes', () => {
    const probeData = {
      '2026-03-01': { cohere: { p50: 80, p75: 160, p95: 240, min: 40, max: 300, count: 100, spikes: 0 } },
    }
    expect(computeMonthlyLatencyStats(probeData).cohere).toEqual({ p95: 240, spikes: 0 })
  })

  it('handles empty data', () => {
    expect(Object.keys(computeMonthlyLatencyStats({}))).toHaveLength(0)
  })
})

// ── isInMonthlyArchiveWindow ─────────────────────────────────────────

describe('isInMonthlyArchiveWindow', () => {
  it('returns true on 1st at UTC 00:00', () => {
    expect(isInMonthlyArchiveWindow(1, 0, 0)).toEqual({ inWindow: true, isCatchUp: false })
  })

  it('returns true on 1st at UTC 00:14', () => {
    expect(isInMonthlyArchiveWindow(1, 0, 14)).toEqual({ inWindow: true, isCatchUp: false })
  })

  it('returns false on 1st at UTC 00:15', () => {
    expect(isInMonthlyArchiveWindow(1, 0, 15)).toEqual({ inWindow: false, isCatchUp: false })
  })

  it('returns catch-up on 1st at UTC 01:00', () => {
    expect(isInMonthlyArchiveWindow(1, 1, 0)).toEqual({ inWindow: true, isCatchUp: true })
  })

  it('returns false on 2nd', () => {
    expect(isInMonthlyArchiveWindow(2, 0, 0)).toEqual({ inWindow: false, isCatchUp: false })
  })

  it('returns false on 1st at UTC 02:00', () => {
    expect(isInMonthlyArchiveWindow(1, 2, 0)).toEqual({ inWindow: false, isCatchUp: false })
  })
})

// ── filterSuppressedFromMonthly (#904) ───────────────────────────────

describe('filterSuppressedFromMonthly', () => {
  // Build a realistic stored accumulator via the real accumulator, mirroring the OpenAI June case:
  // one 264h56m FedRAMP incident + one 40m real incident.
  const svcWith = (incs: Array<{ id: string; title: string; duration: string }>): ServiceStatus => ({
    id: 'openai', name: 'openai', provider: '', category: 'api', status: 'operational',
    latency: null, uptime30d: 99.99, lastChecked: '', incidents: incs.map(i => ({
      id: i.id, title: i.title, status: 'resolved' as const, impact: 'minor' as const,
      startedAt: '2026-06-15T22:00:00Z', duration: i.duration, timeline: [],
    })),
  })
  const built = () => accumulateMonthlyIncidents(null, [svcWith([
    { id: 'fr-1', title: 'FedRAMP workspaces and API orgs have degraded performance', duration: '264h 56m' },
    { id: 'real-1', title: 'Image API requests failing with 401s', duration: '40m' },
  ])], '2026-06', [])

  it('drops a service-pattern-suppressed incident + recomputes aggregates', () => {
    const before = built()
    expect(before.services.openai.count).toBe(2)
    expect(before.services.openai.totalMinutes).toBe(15936) // 264h56m + 40m
    expect(before.services.openai.longestMinutes).toBe(15896)

    const list: SuppressionEntry[] = [{ scope: 'service-pattern', svcId: 'openai', match: 'fedramp' }]
    const after = filterSuppressedFromMonthly(before, list)
    expect(after.services.openai.count).toBe(1)
    expect(after.services.openai.totalMinutes).toBe(40)
    expect(after.services.openai.longestMinutes).toBe(40)
    expect(after.services.openai.incidentIds).toEqual(['real-1'])
    expect(after.services.openai.incidents?.map(i => i.id)).toEqual(['real-1'])
    expect(after.services.openai.durations).toEqual({ 'real-1': 40 })
  })

  it('drops an incident-scope-suppressed incident by id', () => {
    const after = filterSuppressedFromMonthly(built(), [{ scope: 'incident', incId: 'fr-1' }])
    expect(after.services.openai.count).toBe(1)
    expect(after.services.openai.incidentIds).toEqual(['real-1'])
  })

  it('returns input by identity when nothing matches (or empty list)', () => {
    const before = built()
    expect(filterSuppressedFromMonthly(before, [])).toBe(before)
    const noMatch = filterSuppressedFromMonthly(before, [{ scope: 'service-pattern', svcId: 'claude', match: 'fedramp' }])
    expect(noMatch.services.openai).toBe(before.services.openai) // untouched service kept by reference
  })

  it('returns identity on a structurally-corrupt accumulator (no .services) even with a suppression', () => {
    const list: SuppressionEntry[] = [{ scope: 'service-pattern', svcId: 'openai', match: 'fedramp' }]
    const corrupt = { lastUpdated: 'x' } as unknown as Parameters<typeof filterSuppressedFromMonthly>[0]
    expect(() => filterSuppressedFromMonthly(corrupt, list)).not.toThrow()
    expect(filterSuppressedFromMonthly(corrupt, list)).toBe(corrupt)
  })

  it('does not cross-attribute a pattern to another service', () => {
    // same title under a different svcId key must NOT be dropped by an openai pattern
    const data = accumulateMonthlyIncidents(null, [{
      ...svcWith([{ id: 'fr-x', title: 'FedRAMP degraded', duration: '1h' }]), id: 'chatgpt', name: 'chatgpt',
    }], '2026-06', [])
    const after = filterSuppressedFromMonthly(data, [{ scope: 'service-pattern', svcId: 'openai', match: 'fedramp' }])
    expect(after.services.chatgpt.count).toBe(1)
  })
})

// ── accumulateMonthlyIncidents ───────────────────────────────────────

describe('accumulateMonthlyIncidents', () => {
  const makeService = (id: string, incidents: Array<{ id: string; startedAt: string; status: string; duration: string | null }>): ServiceStatus => ({
    id, name: id, provider: '', category: 'api', status: 'operational',
    latency: null, uptime30d: null, lastChecked: '', incidents: incidents.map(i => ({
      id: i.id, title: `Incident ${i.id}`, status: i.status as any, impact: null,
      startedAt: i.startedAt, duration: i.duration, timeline: [],
    })),
  })

  it('accumulates incidents from services', () => {
    const services = [
      makeService('claude', [
        { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'resolved', duration: '2h 30m' },
        { id: 'inc-2', startedAt: '2026-04-05T14:00:00Z', status: 'resolved', duration: '1h' },
      ]),
      makeService('openai', [
        { id: 'inc-3', startedAt: '2026-04-02T08:00:00Z', status: 'resolved', duration: '45m' },
      ]),
    ]

    const result = accumulateMonthlyIncidents(null, services, '2026-04', [])
    expect(result.services.claude.count).toBe(2)
    expect(result.services.claude.totalMinutes).toBe(210) // 150+60
    expect(result.services.claude.longestMinutes).toBe(150)
    expect(result.services.claude.dates).toEqual(['2026-04-01', '2026-04-05'])
    expect(result.services.claude.incidentIds).toEqual(['inc-1', 'inc-2'])
    expect(result.services.openai.count).toBe(1)
    expect(result.services.openai.totalMinutes).toBe(45)
  })

  it('deduplicates incidents by ID', () => {
    const services = [
      makeService('claude', [
        { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'resolved', duration: '2h' },
      ]),
    ]

    const first = accumulateMonthlyIncidents(null, services, '2026-04', [])
    expect(first.services.claude.count).toBe(1)

    // Run again with same incident — should not double-count
    const second = accumulateMonthlyIncidents(first, services, '2026-04', [])
    expect(second.services.claude.count).toBe(1)
    expect(second.services.claude.incidentIds).toEqual(['inc-1'])
  })

  it('adds new incidents to existing accumulation', () => {
    const first = accumulateMonthlyIncidents(null, [
      makeService('claude', [
        { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'resolved', duration: '1h' },
      ]),
    ], '2026-04', [])

    const second = accumulateMonthlyIncidents(first, [
      makeService('claude', [
        { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'resolved', duration: '1h' },
        { id: 'inc-2', startedAt: '2026-04-03T10:00:00Z', status: 'resolved', duration: '30m' },
      ]),
    ], '2026-04', [])

    expect(second.services.claude.count).toBe(2)
    expect(second.services.claude.totalMinutes).toBe(90) // 60+30
  })

  it('filters incidents to target month only', () => {
    const services = [
      makeService('claude', [
        { id: 'inc-1', startedAt: '2026-03-31T23:00:00Z', status: 'resolved', duration: '1h' },
        { id: 'inc-2', startedAt: '2026-04-01T00:00:00Z', status: 'resolved', duration: '2h' },
      ]),
    ]

    const result = accumulateMonthlyIncidents(null, services, '2026-04', [])
    expect(result.services.claude.count).toBe(1)
    expect(result.services.claude.incidentIds).toEqual(['inc-2'])
  })

  it('handles services with no incidents', () => {
    const services = [makeService('claude', [])]
    const result = accumulateMonthlyIncidents(null, services, '2026-04', [])
    expect(result.services.claude).toBeUndefined()
  })

  it('updates totalMinutes + longestMinutes when unresolved incident later resolves', () => {
    // First accumulation: unresolved incident (duration 0)
    const first = accumulateMonthlyIncidents(null, [
      makeService('claude', [
        { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'investigating', duration: null },
      ]),
    ], '2026-04', [])
    expect(first.services.claude.longestMinutes).toBe(0)
    expect(first.services.claude.totalMinutes).toBe(0)

    // Second accumulation: now resolved with duration — delta should be added
    const second = accumulateMonthlyIncidents(first, [
      makeService('claude', [
        { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'resolved', duration: '3h' },
      ]),
    ], '2026-04', [])
    expect(second.services.claude.longestMinutes).toBe(180)
    expect(second.services.claude.totalMinutes).toBe(180) // delta: 180-0 = 180
    expect(second.services.claude.count).toBe(1) // count unchanged
  })

  it('does not double-count duration on repeated resolved accumulation', () => {
    const services = [
      makeService('claude', [
        { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'resolved', duration: '2h' },
      ]),
    ]
    const first = accumulateMonthlyIncidents(null, services, '2026-04', [])
    expect(first.services.claude.totalMinutes).toBe(120)

    // Same resolved incident accumulated again — should not add duration
    const second = accumulateMonthlyIncidents(first, services, '2026-04', [])
    expect(second.services.claude.totalMinutes).toBe(120) // unchanged
  })

  // ── incident detail accumulation (#375) ─────────────────────────────

  it('captures per-incident detail (title, timestamps, status) on new entries', () => {
    const services = [
      makeService('claude', [
        { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'resolved', duration: '2h' },
        { id: 'inc-2', startedAt: '2026-04-05T14:00:00Z', status: 'investigating', duration: null },
      ]),
    ]
    // Ensure makeService sets resolvedAt on resolved incidents (verify shape).
    services[0].incidents[0].resolvedAt = '2026-04-01T12:00:00Z'

    const result = accumulateMonthlyIncidents(null, services, '2026-04', [])
    const detail = result.services.claude.incidents
    expect(detail).toBeDefined()
    expect(detail!.length).toBe(2)
    expect(detail![0]).toEqual({
      id: 'inc-1', title: 'Incident inc-1',
      startedAt: '2026-04-01T10:00:00Z', resolvedAt: '2026-04-01T12:00:00Z',
      durationMin: 120, finalStatus: 'resolved', impact: null, // #653 — impact persisted (null here)
    })
    expect(detail![1].finalStatus).toBe('investigating')
    expect(detail![1].durationMin).toBe(0)
    expect(detail![1].resolvedAt).toBeNull()
  })

  it('persists incident impact on the archived entry (#653 — estimate-uptime weighting)', () => {
    const svc = makeService('bedrock', [
      { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'resolved', duration: '1h' },
    ])
    svc.incidents[0].impact = 'major' // override the makeService null default
    const result = accumulateMonthlyIncidents(null, [svc], '2026-04', [])
    expect(result.services.bedrock.incidents![0].impact).toBe('major')

    // A later run refreshes impact if it changed (e.g. upgraded from null to major after escalation).
    const svc2 = makeService('bedrock', [
      { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'resolved', duration: '2h' },
    ])
    svc2.incidents[0].impact = 'critical'
    const second = accumulateMonthlyIncidents(result, [svc2], '2026-04', [])
    expect(second.services.bedrock.incidents![0].impact).toBe('critical')
  })

  it('updates detail entry when incident status progresses on a later run', () => {
    // First pass: incident is investigating, no duration.
    const first = accumulateMonthlyIncidents(null, [
      makeService('claude', [
        { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'investigating', duration: null },
      ]),
    ], '2026-04', [])
    expect(first.services.claude.incidents![0].finalStatus).toBe('investigating')

    // Second pass: now resolved with a duration + resolvedAt.
    const resolvedSvc = makeService('claude', [
      { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'resolved', duration: '90m' },
    ])
    resolvedSvc.incidents[0].resolvedAt = '2026-04-01T11:30:00Z'
    const second = accumulateMonthlyIncidents(first, [resolvedSvc], '2026-04', [])
    const updated = second.services.claude.incidents![0]
    expect(updated.finalStatus).toBe('resolved')
    expect(updated.durationMin).toBe(90)
    expect(updated.resolvedAt).toBe('2026-04-01T11:30:00Z')
  })

  it('caps detail at MAX_INCIDENTS_PER_SERVICE_IN_ARCHIVE — drops oldest, keeps aggregates', () => {
    const overflow = MAX_INCIDENTS_PER_SERVICE_IN_ARCHIVE + 50
    const baseMs = Date.parse('2026-04-01T00:00:00Z')
    const incs = Array.from({ length: overflow }, (_, i) => ({
      id: `inc-${String(i).padStart(4, '0')}`,
      // Monotonic +1min per index so "oldest" is unambiguously the lowest index.
      startedAt: new Date(baseMs + i * 60_000).toISOString(),
      status: 'resolved',
      duration: '5m',
    }))
    // Shuffle so the cap implementation actually exercises the sort step (otherwise the
    // input is already chronologically ordered and sort is a no-op for stable algorithms).
    // Deterministic Fisher-Yates with a fixed seed via simple LCG so the test stays reproducible.
    let rng = 0x12345
    const next = () => (rng = (rng * 1664525 + 1013904223) >>> 0)
    for (let i = incs.length - 1; i > 0; i--) {
      const j = next() % (i + 1)
      ;[incs[i], incs[j]] = [incs[j], incs[i]]
    }
    const result = accumulateMonthlyIncidents(null, [makeService('mistral', incs)], '2026-04', [])
    const data = result.services.mistral
    // Aggregate counts include every incident (the cap binds detail only).
    expect(data.count).toBe(overflow)
    expect(data.totalMinutes).toBe(overflow * 5)
    expect(data.incidentIds.length).toBe(overflow) // dedup state untruncated
    // Detail array hits the cap.
    expect(data.incidents!.length).toBe(MAX_INCIDENTS_PER_SERVICE_IN_ARCHIVE)
    // Oldest 50 dropped — first surviving entry is index 50.
    expect(data.incidents![0].id).toBe('inc-0050')
    expect(data.incidents![data.incidents!.length - 1].id).toBe(`inc-${String(overflow - 1).padStart(4, '0')}`)
  })

  it('backward-compat: existing data without `incidents` field still accumulates correctly', () => {
    // Simulate an older accumulator value that lacks the new `incidents` field.
    const legacy = {
      lastUpdated: '2026-04-01T00:00:00Z',
      services: {
        claude: { count: 1, totalMinutes: 60, longestMinutes: 60, dates: ['2026-04-01'], incidentIds: ['old-1'], durations: { 'old-1': 60 } },
      },
    }
    const services = [
      makeService('claude', [
        { id: 'new-1', startedAt: '2026-04-02T10:00:00Z', status: 'resolved', duration: '30m' },
      ]),
    ]
    const result = accumulateMonthlyIncidents(legacy, services, '2026-04', [])
    expect(result.services.claude.count).toBe(2)
    expect(result.services.claude.incidents).toBeDefined()
    // Legacy entry has no detail; only the new incident is in the detail array.
    expect(result.services.claude.incidents!.length).toBe(1)
    expect(result.services.claude.incidents![0].id).toBe('new-1')
  })
})

// ── summarizeSecurityAlerts (#290) ───────────────────────────────────

describe('summarizeSecurityAlerts', () => {
  it('counts by source, severity, service; preserves all fields on top findings', () => {
    const entries: MonthlySecurityEntry[] = [
      { title: 'A', url: 'u1', source: 'osv',        severity: 'critical', service: 'OpenAI',             detectedAt: '2026-03-01T00:00:00Z' },
      { title: 'B', url: 'u2', source: 'osv',        severity: 'high',     service: 'OpenAI',             detectedAt: '2026-03-02T00:00:00Z' },
      { title: 'C', url: 'u3', source: 'osv',        severity: 'medium',   service: 'Anthropic (Claude)', detectedAt: '2026-03-03T00:00:00Z' },
      { title: 'D', url: 'u4', source: 'hackernews',                                                      detectedAt: '2026-03-04T00:00:00Z' },
      { title: 'E', url: 'u5', source: 'nvd',        severity: 'low',      service: 'Claude Code',        detectedAt: '2026-03-05T00:00:00Z' },
    ]
    const s = summarizeSecurityAlerts(entries)
    expect(s.totalAlerts).toBe(5)
    expect(s.bySource).toEqual({ osv: 3, hackernews: 1, nvd: 1 })
    // Invariant: the source buckets partition totalAlerts (no source silently uncounted).
    expect(s.bySource.osv + s.bySource.hackernews + s.bySource.nvd).toBe(s.totalAlerts)
    expect(s.bySeverity).toEqual({ critical: 1, high: 1, medium: 1, low: 1 })
    expect(s.byService).toEqual({ OpenAI: 2, 'Anthropic (Claude)': 1, 'Claude Code': 1 })
    // Regression guard: a refactor that narrows the projection to {title, url, severity}
    // would quietly break the report template that renders service + detectedAt.
    expect(s.topFindings[0]).toEqual(entries[0])
  })

  it('sorts topFindings by severity desc with recent-first tie-break', () => {
    const entries: MonthlySecurityEntry[] = [
      { title: 'old-critical', url: 'u1', source: 'osv', severity: 'critical', detectedAt: '2026-03-01T00:00:00Z' },
      { title: 'new-critical', url: 'u2', source: 'osv', severity: 'critical', detectedAt: '2026-03-30T00:00:00Z' },
      { title: 'high',         url: 'u3', source: 'osv', severity: 'high',     detectedAt: '2026-03-15T00:00:00Z' },
      { title: 'medium',       url: 'u4', source: 'osv', severity: 'medium',   detectedAt: '2026-03-20T00:00:00Z' },
    ]
    const s = summarizeSecurityAlerts(entries)
    expect(s.topFindings.map(f => f.title)).toEqual(['new-critical', 'old-critical', 'high', 'medium'])
  })

  it('ranks missing/unknown severity below low', () => {
    const entries: MonthlySecurityEntry[] = [
      { title: 'no-sev',  url: 'u1', source: 'hackernews', detectedAt: '2026-03-10T00:00:00Z' },
      { title: 'low',     url: 'u2', source: 'osv', severity: 'low',            detectedAt: '2026-03-11T00:00:00Z' },
      { title: 'weird',   url: 'u3', source: 'osv', severity: 'SUPERCRITICAL',  detectedAt: '2026-03-12T00:00:00Z' },
    ]
    const s = summarizeSecurityAlerts(entries)
    // low outranks both no-severity and the unrecognized label
    expect(s.topFindings[0].title).toBe('low')
    // bySeverity should only count recognized buckets
    expect(s.bySeverity).toEqual({ critical: 0, high: 0, medium: 0, low: 1 })
  })

  it('caps topFindings at 10', () => {
    const entries: MonthlySecurityEntry[] = Array.from({ length: 15 }, (_, i) => ({
      title: `entry-${i}`,
      url: `u${i}`,
      source: 'osv' as const,
      severity: 'medium',
      detectedAt: `2026-03-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }))
    const s = summarizeSecurityAlerts(entries)
    expect(s.totalAlerts).toBe(15)
    expect(s.topFindings).toHaveLength(10)
  })

  it('is case-insensitive on severity normalization', () => {
    const entries: MonthlySecurityEntry[] = [
      { title: 'A', url: 'u1', source: 'osv', severity: 'CRITICAL', detectedAt: '2026-03-01T00:00:00Z' },
      { title: 'B', url: 'u2', source: 'osv', severity: 'High',     detectedAt: '2026-03-02T00:00:00Z' },
    ]
    const s = summarizeSecurityAlerts(entries)
    expect(s.bySeverity).toEqual({ critical: 1, high: 1, medium: 0, low: 0 })
  })

  it('returns zero-filled summary with empty topFindings for empty input', () => {
    const s = summarizeSecurityAlerts([])
    expect(s.totalAlerts).toBe(0)
    expect(s.bySource).toEqual({ osv: 0, hackernews: 0, nvd: 0 })
    expect(s.bySeverity).toEqual({ critical: 0, high: 0, medium: 0, low: 0 })
    expect(s.byService).toEqual({})
    expect(s.topFindings).toEqual([])
  })
})

// ── OSV vuln id extraction + archive timeline enrichment (#291) ──────

describe('extractOsvVulnId', () => {
  it('picks GHSA ids out of osv.dev URLs', () => {
    expect(extractOsvVulnId('https://osv.dev/vulnerability/GHSA-abc-def-ghi')).toBe('GHSA-abc-def-ghi')
  })

  it('picks GHSA ids out of github.com advisory URLs', () => {
    expect(extractOsvVulnId('https://github.com/advisories/GHSA-69w3-r845-3855')).toBe('GHSA-69w3-r845-3855')
  })

  it('picks CVE ids out of URLs', () => {
    expect(extractOsvVulnId('https://nvd.nist.gov/vuln/detail/CVE-2026-12345')).toBe('CVE-2026-12345')
  })

  it('is case-insensitive on the GHSA/CVE prefix', () => {
    // Some downstream tooling lowercases path segments; the regex uses /i to tolerate that.
    expect(extractOsvVulnId('https://osv.dev/vulnerability/ghsa-aaa-bbb-ccc')).toBe('ghsa-aaa-bbb-ccc')
    expect(extractOsvVulnId('https://example.com/cve-2026-12345')).toBe('cve-2026-12345')
  })

  it('returns null for URLs without a recognizable id', () => {
    expect(extractOsvVulnId('https://example.com/advisory/random')).toBeNull()
    expect(extractOsvVulnId(undefined)).toBeNull()
    expect(extractOsvVulnId('')).toBeNull()
  })
})

describe('enrichTopFindingsWithTimelines', () => {
  const baseSummary: MonthlySecuritySummary = {
    totalAlerts: 3,
    bySource: { osv: 2, hackernews: 1, nvd: 0 },
    bySeverity: { critical: 0, high: 1, medium: 1, low: 0 },
    byService: {},
    topFindings: [
      { title: 'OSV A', url: 'https://osv.dev/vulnerability/GHSA-aaa-bbb-ccc', source: 'osv',        severity: 'high',   detectedAt: '2026-03-01T00:00:00Z' },
      { title: 'OSV B', url: 'https://osv.dev/vulnerability/GHSA-xxx-yyy-zzz', source: 'osv',        severity: 'medium', detectedAt: '2026-03-02T00:00:00Z' },
      { title: 'HN C',  url: 'https://news.ycombinator.com/item?id=1',         source: 'hackernews',                     detectedAt: '2026-03-03T00:00:00Z' },
    ],
  }
  const timelineA: OsvTimeline = {
    vulnId: 'GHSA-aaa-bbb-ccc',
    createdAt: '2026-03-01T00:00:00Z',
    lastSeen: '2026-03-15T00:00:00Z',
    entries: [
      { stage: 'detected',     at: '2026-03-01T00:00:00Z', severity: 'medium' },
      { stage: 'severity_changed', at: '2026-03-10T00:00:00Z', severity: 'high' },
      { stage: 'fix_released', at: '2026-03-15T00:00:00Z', fixedVersion: '1.2.3' },
    ],
  }

  it('attaches timeline entries to OSV findings when the KV key exists', async () => {
    const kv = {
      get: async (key: string) => key === 'security:timeline:osv:GHSA-aaa-bbb-ccc' ? JSON.stringify(timelineA) : null,
    } as unknown as KVNamespace
    const enriched = await enrichTopFindingsWithTimelines(kv, baseSummary)
    expect(enriched.topFindings[0].timeline).toHaveLength(3)
    expect(enriched.topFindings[0].timeline![2].stage).toBe('fix_released')
    // Findings without a KV entry pass through unchanged
    expect(enriched.topFindings[1].timeline).toBeUndefined()
    // HN findings never get enriched
    expect(enriched.topFindings[2].timeline).toBeUndefined()
  })

  it('skips enrichment on missing / malformed / empty timeline', async () => {
    const kv = {
      get: async (key: string) => {
        if (key === 'security:timeline:osv:GHSA-aaa-bbb-ccc') return '{not valid json'
        if (key === 'security:timeline:osv:GHSA-xxx-yyy-zzz') return JSON.stringify({ ...timelineA, entries: [] })
        return null
      },
    } as unknown as KVNamespace
    const enriched = await enrichTopFindingsWithTimelines(kv, baseSummary)
    expect(enriched.topFindings[0].timeline).toBeUndefined()  // malformed
    expect(enriched.topFindings[1].timeline).toBeUndefined()  // empty entries array
  })

  it('tolerates KV get rejection per finding (one failure does not poison the batch)', async () => {
    const kv = {
      get: async (key: string) => {
        if (key === 'security:timeline:osv:GHSA-aaa-bbb-ccc') throw new Error('KV read failed')
        if (key === 'security:timeline:osv:GHSA-xxx-yyy-zzz') return JSON.stringify({ ...timelineA, vulnId: 'GHSA-xxx-yyy-zzz' })
        return null
      },
    } as unknown as KVNamespace
    const enriched = await enrichTopFindingsWithTimelines(kv, baseSummary)
    expect(enriched.topFindings[0].timeline).toBeUndefined()
    expect(enriched.topFindings[1].timeline).toHaveLength(3)
  })
})

// ── accumulateIncidentsOnlyIfChanged (#587) ──────────────────────────
describe('accumulateIncidentsOnlyIfChanged (#587)', () => {
  const svc = (id: string, incidents: Array<{ id: string; startedAt: string; status: string; duration: string | null }>): ServiceStatus => ({
    id, name: id, status: 'down', category: 'api', uptime30d: null, latency: null,
    incidents: incidents.map(i => ({
      id: i.id, title: `inc ${i.id}`, status: i.status as Incident['status'],
      startedAt: i.startedAt, duration: i.duration, timeline: [],
    })),
  } as unknown as ServiceStatus)

  // In-memory KV with get/put + a write counter so we can assert the budget guard.
  const makeKV = (seed: Record<string, string> = {}) => {
    const store: Record<string, string> = { ...seed }
    let writes = 0
    return {
      kv: {
        get: async (k: string) => store[k] ?? null,
        put: async (k: string, v: string) => { store[k] = v; writes++ },
      } as unknown as KVNamespace,
      store,
      writes: () => writes,
    }
  }

  it('writes a freshly-seen incident into incidents:monthly (captures short-lived/RSS incidents)', async () => {
    const { kv, store, writes } = makeKV()
    const services = [svc('azureopenai', [{ id: 'az-1', startedAt: '2026-06-03T10:00:00Z', status: 'investigating', duration: null }])]
    const res = await accumulateIncidentsOnlyIfChanged(kv, services, '2026-06')
    expect(res).toBe('written')
    expect(writes()).toBe(1)
    const stored = JSON.parse(store['incidents:monthly:2026-06'])
    expect(stored.services.azureopenai.count).toBe(1)
    expect(stored.services.azureopenai.incidentIds).toContain('az-1')
  })

  it('skips the write when no incident data changed (budget guard — bumped lastUpdated alone)', async () => {
    const services = [svc('azureopenai', [{ id: 'az-1', startedAt: '2026-06-03T10:00:00Z', status: 'resolved', duration: '20m' }])]
    const { kv, writes } = makeKV()
    expect(await accumulateIncidentsOnlyIfChanged(kv, services, '2026-06')).toBe('written') // first write
    expect(await accumulateIncidentsOnlyIfChanged(kv, services, '2026-06')).toBe('unchanged') // no change → no write
    expect(await accumulateIncidentsOnlyIfChanged(kv, services, '2026-06')).toBe('unchanged')
    expect(writes()).toBe(1) // only the first run wrote, despite three calls
  })

  it('dedups by id — re-accumulating the same incident never double-counts', async () => {
    const services = [svc('bedrock', [{ id: 'bd-1', startedAt: '2026-06-04T08:00:00Z', status: 'resolved', duration: '1h' }])]
    const { kv, store } = makeKV()
    await accumulateIncidentsOnlyIfChanged(kv, services, '2026-06')
    await accumulateIncidentsOnlyIfChanged(kv, services, '2026-06')
    expect(JSON.parse(store['incidents:monthly:2026-06']).services.bedrock.count).toBe(1)
  })

  it('writes again when an active incident progresses (duration grows)', async () => {
    const { kv, store, writes } = makeKV()
    await accumulateIncidentsOnlyIfChanged(kv, [svc('chatgpt', [{ id: 'cg-1', startedAt: '2026-06-05T01:00:00Z', status: 'investigating', duration: '30m' }])], '2026-06')
    const r2 = await accumulateIncidentsOnlyIfChanged(kv, [svc('chatgpt', [{ id: 'cg-1', startedAt: '2026-06-05T01:00:00Z', status: 'resolved', duration: '1h 15m' }])], '2026-06')
    expect(r2).toBe('written') // progressed → persisted
    expect(writes()).toBe(2)
    expect(JSON.parse(store['incidents:monthly:2026-06']).services.chatgpt.count).toBe(1) // still one incident
  })
  // #975 — a THROWN kv.get was collapsed to `null`, which made the accumulator rebuild the month from
  // this cycle alone and WRITE it: one transient read blip erased the whole month's history.
  it('a KV read ERROR aborts the cycle and never overwrites the accumulator', async () => {
    const seeded = JSON.stringify({
      lastUpdated: '2026-07-01T00:00:00Z',
      services: { pinecone: { count: 5, totalMinutes: 500, longestMinutes: 200, dates: ['2026-07-01'], incidentIds: ['a','b','c','d','e'], durations: { a:100,b:100,c:100,d:100,e:100 }, incidents: [] } },
    })
    let writes = 0
    const kv = {
      get: async (k: string) => { if (k.startsWith('incidents:monthly:')) throw new Error('KV unavailable'); return null },
      put: async () => { writes++ },
    } as unknown as KVNamespace

    const res = await accumulateIncidentsOnlyIfChanged(kv, [svc('pinecone', [
      { id: 'new-one', startedAt: '2026-07-09T00:00:00Z', status: 'investigating', duration: null },
    ])], '2026-07')

    expect(res).toBe('failed')
    expect(writes).toBe(0) // the seeded month survives untouched
    expect(JSON.parse(seeded).services.pinecone.count).toBe(5)
  })

  it('a genuinely ABSENT key still starts the month from scratch', async () => {
    const { kv, store } = makeKV()
    const res = await accumulateIncidentsOnlyIfChanged(kv, [svc('pinecone', [
      { id: 'first', startedAt: '2026-07-09T00:00:00Z', status: 'resolved', duration: '1h' },
    ])], '2026-07')
    expect(res).toBe('written')
    expect(JSON.parse(store['incidents:monthly:2026-07']).services.pinecone.count).toBe(1)
  })

})

// ── buildMonthlyArchive ──────────────────────────────────────────────

describe('aggregateIncidentDurations (#915 — long-open inflation)', () => {
  const entry = (durationMin: number) => ({ id: String(durationMin), title: 't', startedAt: '2026-06-01', resolvedAt: null, durationMin, finalStatus: 'resolved' as const, impact: null })

  it('sums/maxes the per-incident FINAL durations (the Deepgram case — ignores the inflated accumulator)', () => {
    // 6 incidents summing to 2733m / max 1620m; accumulator monotonically inflated to 10602/8470.
    const incidents = [1620, 601, 1, 137, 373, 1].map(entry)
    const r = aggregateIncidentDurations(incidents, 6, 10602, 8470)
    expect(r.totalMin).toBe(2733)
    expect(r.longestMin).toBe(1620)
  })

  it('falls back to the accumulator when the list is TRUNCATED (< count)', () => {
    // Only 2 of 250 incidents survived the per-service cap → the list is not the full population.
    const incidents = [30, 20].map(entry)
    const r = aggregateIncidentDurations(incidents, 250, 9999, 500)
    expect(r.totalMin).toBe(9999)
    expect(r.longestMin).toBe(500)
  })

  it('returns null/null when there are no incidents', () => {
    expect(aggregateIncidentDurations([], 0, 0, 0)).toEqual({ totalMin: null, longestMin: null, countedCount: null })
    expect(aggregateIncidentDurations(undefined, 0, 0, 0)).toEqual({ totalMin: null, longestMin: null, countedCount: null })
  })

  it('treats a full list of zero-duration incidents as null (no downtime)', () => {
    const r = aggregateIncidentDurations([entry(0), entry(0)], 2, 0, 0)
    expect(r).toEqual({ totalMin: null, longestMin: null, countedCount: 2 })
  })
})

describe('aggregateIncidentDurations (#1021 — usage-limits/quota advisory exclusion)', () => {
  const mk = (durationMin: number, title: string, impact: 'minor' | 'major' | null = 'minor') =>
    ({ id: title, title, startedAt: '2026-06-01', resolvedAt: null, durationMin, finalStatus: 'resolved' as const, impact })

  it('excludes a usage-limits/quota advisory from total/longest/count (the Codex June case)', () => {
    // The 4323m (72h 3m) "Usage Limits Depleting" advisory (79% of Codex's archived downtime) must NOT
    // count; only the genuine 372m (6h 12m) elevated-error outage does.
    const incidents = [
      mk(4323, 'Codex Usage Limits Depleting Faster Than Expected'), // advisory → excluded
      mk(372, 'Elevated error rates on Codex', 'major'),             // real outage → counted
    ]
    const r = aggregateIncidentDurations(incidents, 2, 0, 0)
    expect(r.totalMin).toBe(372)
    expect(r.longestMin).toBe(372)
    expect(r.countedCount).toBe(1)
  })

  it('an outage-signal term in the title wins — a "quota errors" outage still counts', () => {
    const incidents = [mk(300, 'Elevated 5xx errors — customers hitting quota limits')]
    const r = aggregateIncidentDurations(incidents, 1, 0, 0)
    expect(r.totalMin).toBe(300)
    expect(r.countedCount).toBe(1)
  })

  it('a month whose ONLY incident is an advisory reports null downtime + 0 counted', () => {
    const r = aggregateIncidentDurations([mk(4323, 'Usage limits increased for all tiers')], 1, 0, 0)
    expect(r.totalMin).toBeNull()
    expect(r.longestMin).toBeNull()
    expect(r.countedCount).toBe(0)
  })
})

describe('buildMonthlyArchive', () => {
  const mockKV = {
    get: async (key: string) => {
      const store: Record<string, string> = {
        'history:2026-03-01': JSON.stringify({ claude: { ok: 280, total: 288 }, openai: { ok: 288, total: 288 } }),
        'history:2026-03-02': JSON.stringify({ claude: { ok: 288, total: 288 }, openai: { ok: 285, total: 288 } }),
        'probe:daily:2026-03-01': JSON.stringify({ claude: { p50: 100, p75: 200, p95: 300, min: 50, max: 400, count: 100, spikes: 0 } }),
        'probe:daily:2026-03-02': JSON.stringify({ claude: { p50: 110, p75: 220, p95: 310, min: 55, max: 410, count: 100, spikes: 1 } }),
        'incidents:monthly:2026-03': JSON.stringify({
          lastUpdated: '2026-03-31T09:00:00Z',
          services: {
            claude: { count: 5, totalMinutes: 300, longestMinutes: 120, dates: ['2026-03-01', '2026-03-10', '2026-03-15'], incidentIds: ['a', 'b', 'c', 'd', 'e'], durations: { a: 120, b: 60, c: 45, d: 30, e: 45 } },
            openai: { count: 1, totalMinutes: 45, longestMinutes: 45, dates: ['2026-03-20'], incidentIds: ['f'], durations: { f: 45 } },
          },
        }),
      }
      return store[key] ?? null
    },
    put: async () => {},
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace

  it('builds archive with uptime + latency + accumulated incidents', async () => {
    const scoreData = [
      { id: 'claude', aiwatchScore: 85, scoreGrade: 'excellent' as const },
      { id: 'openai', aiwatchScore: 92, scoreGrade: 'excellent' as const },
    ]

    const archive = await buildMonthlyArchive(mockKV, 2026, 3, scoreData)
    expect(archive.period).toBe('2026-03')
    expect(archive.daysCollected).toBe(2)
    expect(archive.services.claude.uptime).toBeCloseTo(98.61, 0)
    expect(archive.services.claude.score).toBe(85)
    expect(archive.services.claude.grade).toBe('excellent')
    expect(archive.services.claude.incidents).toBe(5) // from accumulated data
    expect(archive.services.claude.avgResolutionMin).toBe(60) // 300/5
    expect(archive.services.claude.totalDowntimeMin).toBe(300)
    expect(archive.services.claude.longestIncidentMin).toBe(120)
    expect(archive.services.claude.avgLatencyMs).toBe(210)
    expect(archive.services.openai.incidents).toBe(1)
    expect(archive.services.openai.avgResolutionMin).toBe(45)
    expect(archive.services.openai.totalDowntimeMin).toBe(45)
    expect(archive.services.openai.longestIncidentMin).toBe(45)
    expect(archive.services.openai.avgLatencyMs).toBeNull()
  })

  it('#1016 — a live high-confidence Score with NO daily snapshot yields null officialUptime (no live leak into a frozen month)', async () => {
    // The bug: the rebuild path re-snapshotted today's live `uptime30d` into a frozen month, so a service
    // that gained an uptime source AFTER the month (openrouter post-#1006) showed "Official · 100%" beside
    // a monthlyScore that dropped the uptime component. mockKV carries claude's daily COUNTERS but no
    // daily officialUptime snapshot — the archived display must be null, and `scoreConfidence: 'high'`
    // (standing in for today's live read) must not conjure one.
    const archive = await buildMonthlyArchive(mockKV, 2026, 3, [
      { id: 'claude', aiwatchScore: 85, scoreGrade: 'excellent' as const, scoreConfidence: 'high' as const },
    ])
    expect(archive.services.claude.officialUptime).toBeNull()      // no snapshot → null, not a live leak
    expect(archive.services.claude.uptime).toBeCloseTo(98.61, 0)   // daily-counter value, unchanged
  })

  it('officialUptime defaults to null when scoreData omits it (forward/back compat)', async () => {
    const archive = await buildMonthlyArchive(mockKV, 2026, 3, [
      { id: 'claude', aiwatchScore: 85, scoreGrade: 'excellent' as const },
    ])
    expect(archive.services.claude.officialUptime).toBeNull()
  })

  // #951 — the June 2026 contamination, reproduced through the full builder. The daily counter stores
  // `uptime30d` WITHOUT its `uptimeSource`, so the incident-derived estimate that #713 removed on
  // 2026-06-19 is indistinguishable from an official % in the snapshot. `computeMonthlyOfficialUptime`
  // is a sticky last-non-null, so one pre-#713 day stamped "Official · 100.00%" on Stability's whole
  // month — beside a Score the build (2026-07-01) had already rescaled over /60 as if no uptime existed.
  it('#951 does not surface a month-end uptime the Score never consumed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}) // the withheld-value warning
    const juneKV = {
      get: async (key: string) => ({
        // 06-17: pre-#713 — stability's estimate and groq's real official uptime look identical here.
        'history:2026-06-17': JSON.stringify({
          stability: { ok: 288, total: 288, officialUptime: 100 },
          groq: { ok: 288, total: 288, officialUptime: 100 },
        }),
        // 06-29: post-#713 — stability's value is gone; groq's real one persists.
        'history:2026-06-29': JSON.stringify({
          stability: { ok: 288, total: 288, officialUptime: null },
          groq: { ok: 288, total: 288, officialUptime: 100 },
        }),
      } as Record<string, string>)[key] ?? null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(juneKV, 2026, 6, [
      // Scored at build time (post-#713): no uptime component → medium confidence, /60 rescale.
      { id: 'stability', aiwatchScore: 76, scoreGrade: 'good' as const, scoreConfidence: 'medium' as const },
      { id: 'groq', aiwatchScore: 85, scoreGrade: 'good' as const, scoreConfidence: 'high' as const },
    ])

    // The sticky 100 from 06-17 must NOT resurface as Stability's "Official Uptime".
    expect(archive.services.stability.officialUptime).toBeNull()
    expect(archive.services.stability.uptime).toBe(100)   // AIWatch-measured — untouched, still honest
    expect(archive.services.stability.score).toBe(76)     // the /60 score the display now agrees with
    expect(archive.services.stability.scoreConfidence).toBe('medium')

    // A service that really does publish uptime keeps it, month-end value and all.
    expect(archive.services.groq.officialUptime).toBe(100)
    expect(archive.services.groq.scoreConfidence).toBe('high')
  })

  it('#591 threads incidentSourceStale into the archive (only when set)', async () => {
    const archive = await buildMonthlyArchive(mockKV, 2026, 3, [
      { id: 'deepseek', aiwatchScore: 88, scoreGrade: 'good' as const, incidentSourceStale: true },
      { id: 'claude', aiwatchScore: 85, scoreGrade: 'excellent' as const },
    ])
    expect(archive.services.deepseek.incidentSourceStale).toBe(true)
    // absent (not false) for non-stale services — the report generator treats absence as not-stale
    expect(archive.services.claude.incidentSourceStale).toBeUndefined()
  })

  it('#809 threads static addedAt into the archive for a month the service existed in', async () => {
    const recentId = Object.keys(SERVICE_ADDED_AT)[0] // a service that carries an addedAt date
    expect(recentId).toBeDefined()
    const addedAt = SERVICE_ADDED_AT[recentId]
    const y = Number(addedAt.slice(0, 4)); const m = Number(addedAt.slice(5, 7)) // the month it was added
    const archive = await buildMonthlyArchive(mockKV, y, m, [
      { id: recentId, aiwatchScore: 80, scoreGrade: 'good' as const },
      { id: 'claude', aiwatchScore: 85, scoreGrade: 'excellent' as const },
    ])
    expect(archive.services[recentId].addedAt).toBe(addedAt) // static config date, for the report-side gate
    expect(archive.services.claude.addedAt).toBeUndefined() // established service → absent = full coverage
  })

  it('#909 excludes a service from a month that ended before it was added (post-month roster leak)', async () => {
    const recentId = Object.keys(SERVICE_ADDED_AT)[0]
    const addedAt = SERVICE_ADDED_AT[recentId]
    const y = Number(addedAt.slice(0, 4)); const m = Number(addedAt.slice(5, 7))
    const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 } // the month BEFORE it was added
    // scoreData carries recentId (a REBUILD reads the current roster) — it must still be dropped.
    const archive = await buildMonthlyArchive(mockKV, prev.y, prev.m, [
      { id: recentId, aiwatchScore: 80, scoreGrade: 'good' as const },
      { id: 'claude', aiwatchScore: 85, scoreGrade: 'excellent' as const },
    ])
    expect(archive.services[recentId]).toBeUndefined() // added after this month → not monitored → excluded
    expect(archive.services.claude).toBeDefined()      // established service is unaffected
  })

  it('#586/#1006 officialUptime comes from the month-end daily snapshot (no scoreData/live source)', async () => {
    // History days carry officialUptime; the archived display value is the month-end (2026-03-02) daily
    // snapshot — the same value the monthly Score consumed. There is no scoreData/live fallback.
    const dailyKV = {
      get: async (key: string) => ({
        'history:2026-03-01': JSON.stringify({ claude: { ok: 280, total: 288, officialUptime: 98.0 } }),
        'history:2026-03-02': JSON.stringify({ claude: { ok: 288, total: 288, officialUptime: 99.83 } }),
      } as Record<string, string>)[key] ?? null,
    } as unknown as KVNamespace
    const archive = await buildMonthlyArchive(dailyKV, 2026, 3, [
      { id: 'claude', aiwatchScore: 85, scoreGrade: 'excellent' as const, scoreConfidence: 'high' as const },
    ])
    expect(archive.services.claude.officialUptime).toBe(99.83) // month-end daily snapshot
    expect(archive.services.claude.uptime).toBeCloseTo(98.61, 0) // daily-counter uptime unchanged
  })

  it('emits null totalDowntimeMin + longestIncidentMin for services with no incidents', async () => {
    const noIncKV = {
      get: async (key: string) => {
        const store: Record<string, string> = {
          'history:2026-03-01': JSON.stringify({ cohere: { ok: 288, total: 288 } }),
        }
        return store[key] ?? null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(noIncKV, 2026, 3)
    expect(archive.services.cohere.incidents).toBe(0)
    expect(archive.services.cohere.totalDowntimeMin).toBeNull()
    expect(archive.services.cohere.longestIncidentMin).toBeNull()
  })

  it('handles no score data (uptime + incidents only)', async () => {
    const archive = await buildMonthlyArchive(mockKV, 2026, 3)
    expect(archive.services.claude.score).toBeNull()
    expect(archive.services.claude.grade).toBeNull()
    expect(archive.services.claude.incidents).toBe(5)
  })

  it('#892: the PUBLIC monthly security summary excludes unverified HN chatter', async () => {
    // The archive feeds /api/report → the public reports site, so it must gate to verified
    // findings (OSV, or HN with a CVE id) — never surface raw HN chatter as a top finding or count.
    const secKV = {
      get: async (key: string) => key === 'security:monthly:2026-03' ? JSON.stringify([
        { title: 'anthropic SDK advisory', url: 'O1', source: 'osv', severity: 'high', service: 'Anthropic (Claude)', detectedAt: '2026-03-05T00:00:00.000Z' },
        { title: 'Copilot RCE (CVE-2025-53773)', url: 'H1', source: 'hackernews', severity: 'high', service: 'GitHub Copilot', detectedAt: '2026-03-10T00:00:00.000Z' },
        { title: 'Possible evidence of prompt injection by Anthropic', url: 'H2', source: 'hackernews', service: 'Anthropic (Claude)', detectedAt: '2026-03-12T00:00:00.000Z' },
      ]) : null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(secKV, 2026, 3)
    expect(archive.security).not.toBeNull()
    expect(archive.security!.totalAlerts).toBe(2)                       // chatter excluded from the count
    expect(archive.security!.bySource).toEqual({ osv: 1, hackernews: 1, nvd: 0 })
    const titles = archive.security!.topFindings.map(f => f.title)
    expect(titles).toContain('anthropic SDK advisory')
    expect(titles).toContain('Copilot RCE (CVE-2025-53773)')
    expect(titles).not.toContain('Possible evidence of prompt injection by Anthropic')
  })

  // ── #426: AI retrospective narrative bake-in ──
  it('omits narrative entirely when no narrativeOpts are passed', async () => {
    const archive = await buildMonthlyArchive(mockKV, 2026, 3)
    expect(archive.narrative).toBeUndefined()
  })

  it('omits narrative when narrativeOpts has neither an AI binding nor an API key', async () => {
    const archive = await buildMonthlyArchive(mockKV, 2026, 3, undefined, { serviceNames: {} })
    expect(archive.narrative).toBeUndefined()
  })

  it('attaches an AI-generated narrative draft when an AI binding produces a usable response', async () => {
    const draftJson = JSON.stringify({
      notableIncidents: [{ service: 'Claude API', title: 'Elevated errors', narrative: 'Errors spiked for ~1h.' }],
      observations: ['Treat Claude as primary; recovery was fast.'],
    })
    const ai = { run: async () => ({ response: draftJson }) }
    const archive = await buildMonthlyArchive(mockKV, 2026, 3, undefined, {
      ai,
      serviceNames: { claude: 'Claude API' },
    })
    expect(archive.narrative).not.toBeNull()
    expect(archive.narrative?.model).toBe('gemma')
    expect(archive.narrative?.notableIncidents).toHaveLength(1)
    expect(archive.narrative?.observations).toHaveLength(1)
  })

  it('sets narrative to null (archive still builds) when AI generation fails', async () => {
    // AI binding throws, no API key → generateMonthlyNarrative returns null.
    const ai = { run: async () => { throw new Error('Workers AI down') } }
    const archive = await buildMonthlyArchive(mockKV, 2026, 3, undefined, { ai, serviceNames: {} })
    // The deterministic archive must be intact regardless of the AI failure.
    expect(archive.services.claude.incidents).toBe(5)
    expect(archive.narrative).toBeNull()
  })

  // ── #375: snapshot per-incident detail into the permanent archive ──
  it('snapshots per-service incidentList from accumulated data (#375)', async () => {
    const detailKV = {
      get: async (key: string) => {
        const store: Record<string, string> = {
          'incidents:monthly:2026-03': JSON.stringify({
            lastUpdated: '2026-03-31T09:00:00Z',
            services: {
              claude: {
                count: 2, totalMinutes: 90, longestMinutes: 60,
                dates: ['2026-03-01', '2026-03-15'], incidentIds: ['a', 'b'],
                durations: { a: 60, b: 30 },
                incidents: [
                  { id: 'a', title: 'Claude API down', startedAt: '2026-03-01T10:00:00Z', resolvedAt: '2026-03-01T11:00:00Z', durationMin: 60, finalStatus: 'resolved' },
                  { id: 'b', title: 'Claude latency spike', startedAt: '2026-03-15T14:00:00Z', resolvedAt: '2026-03-15T14:30:00Z', durationMin: 30, finalStatus: 'resolved' },
                ],
              },
            },
          }),
        }
        return store[key] ?? null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(detailKV, 2026, 3)
    expect(archive.services.claude.incidentList).toBeDefined()
    expect(archive.services.claude.incidentList!.length).toBe(2)
    expect(archive.services.claude.incidentList![0].id).toBe('a')
    expect(archive.services.claude.incidentList![0].title).toBe('Claude API down')
    expect(archive.services.claude.incidentList![1].finalStatus).toBe('resolved')
  })

  it('omits incidentList when accumulated data is from a pre-#375 KV entry (no `incidents` field)', async () => {
    const legacyKV = {
      get: async (key: string) => {
        const store: Record<string, string> = {
          'incidents:monthly:2026-03': JSON.stringify({
            lastUpdated: '2026-03-31T09:00:00Z',
            services: {
              claude: { count: 1, totalMinutes: 60, longestMinutes: 60, dates: ['2026-03-01'], incidentIds: ['a'], durations: { a: 60 } },
            },
          }),
        }
        return store[key] ?? null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(legacyKV, 2026, 3)
    expect(archive.services.claude.incidents).toBe(1)
    expect(archive.services.claude.incidentList).toBeUndefined()
  })

  it('clones incidentList — archive mutation does not affect accumulator data', async () => {
    const sharedDetail = [
      { id: 'a', title: 'incident', startedAt: '2026-03-01T10:00:00Z', resolvedAt: '2026-03-01T11:00:00Z', durationMin: 60, finalStatus: 'resolved' as const },
    ]
    const accumKV = {
      get: async (key: string) => {
        if (key === 'incidents:monthly:2026-03') {
          return JSON.stringify({
            lastUpdated: '2026-03-31T09:00:00Z',
            services: { claude: { count: 1, totalMinutes: 60, longestMinutes: 60, dates: [], incidentIds: ['a'], durations: { a: 60 }, incidents: sharedDetail } },
          })
        }
        return null
      },
      put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace
    const archive = await buildMonthlyArchive(accumKV, 2026, 3)
    // Mutate the archive copy and verify the source array is untouched.
    archive.services.claude.incidentList![0].title = 'mutated'
    expect(sharedDetail[0].title).toBe('incident')
  })

  it('#915 — downtime aggregate derives from the incident list, NOT the inflated monotonic accumulator', async () => {
    // Deepgram June shape: accumulator locked at 176h42m/141h10m (a long-open incident's peak) while
    // the per-incident detail carries the corrected final durations summing to 2733m (45h33m) / max 1620m.
    const detail = [1620, 601, 1, 137, 373, 1].map((d, i) => ({
      id: `d${i}`, title: `t${i}`, startedAt: '2026-03-10', resolvedAt: '2026-03-11',
      durationMin: d, finalStatus: 'resolved' as const, impact: null,
    }))
    const kv = {
      get: async (key: string) => key === 'incidents:monthly:2026-03'
        ? JSON.stringify({
            lastUpdated: '2026-03-31T09:00:00Z',
            services: {
              deepgram: {
                count: 6, totalMinutes: 10602, longestMinutes: 8470, // inflated accumulator
                dates: [], incidentIds: detail.map(e => e.id),
                durations: Object.fromEntries(detail.map(e => [e.id, e.durationMin])),
                incidents: detail, // corrected per-incident detail (source of truth)
              },
            },
          })
        : null,
      put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace
    const archive = await buildMonthlyArchive(kv, 2026, 3)
    expect(archive.services.deepgram.totalDowntimeMin).toBe(2733)   // 45h 33m — not the accumulator's 10602
    expect(archive.services.deepgram.longestIncidentMin).toBe(1620) // 27h — not 8470
    expect(archive.services.deepgram.avgResolutionMin).toBe(Math.round(2733 / 6)) // 456m, from the real total
  })

  it('handles empty KV (no data)', async () => {
    const emptyKV = {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(emptyKV, 2026, 3)
    expect(archive.period).toBe('2026-03')
    expect(archive.daysCollected).toBe(0)
    expect(Object.keys(archive.services)).toHaveLength(0)
  })

  it('handles corrupt KV JSON gracefully', async () => {
    const corruptKV = {
      get: async (key: string) => {
        if (key === 'history:2026-03-01') return 'NOT_JSON'
        if (key === 'history:2026-03-02') return JSON.stringify({ claude: { ok: 288, total: 288 } })
        return null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(corruptKV, 2026, 3)
    expect(archive.daysCollected).toBe(1) // only day 2 parsed
    expect(archive.services.claude.uptime).toBe(100)
  })

  it('handles December → January boundary', async () => {
    const decKV = {
      get: async (key: string) => {
        if (key === 'history:2026-12-01') return JSON.stringify({ claude: { ok: 288, total: 288 } })
        if (key === 'incidents:monthly:2026-12') return JSON.stringify({
          lastUpdated: '2026-12-31T09:00:00Z',
          services: { claude: { count: 2, totalMinutes: 60, longestMinutes: 40, dates: ['2026-12-15'], incidentIds: ['x', 'y'], durations: { x: 40, y: 20 } } },
        })
        return null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(decKV, 2026, 12, [
      { id: 'claude', aiwatchScore: 90, scoreGrade: 'excellent' as const },
    ])
    expect(archive.period).toBe('2026-12')
    expect(archive.services.claude.incidents).toBe(2)
    expect(archive.services.claude.uptime).toBe(100)
  })

  it('snapshots security summary from security:monthly:{period} (#290)', async () => {
    const secEntries: MonthlySecurityEntry[] = [
      { title: 'RCE in openai', url: 'u1', source: 'osv', severity: 'critical', service: 'OpenAI', detectedAt: '2026-03-10T00:00:00Z' },
      // #892 — HN entries reach the PUBLIC archive only with a CVE id; give this one a CVE so it
      // still exercises the hackernews-counting path under the verified-only gate.
      { title: 'HN breach story (CVE-2025-9999)', url: 'u2', source: 'hackernews', detectedAt: '2026-03-15T00:00:00Z' },
      { title: 'Path traversal', url: 'u3', source: 'osv', severity: 'high', service: 'Anthropic (Claude)', detectedAt: '2026-03-20T00:00:00Z' },
    ]
    const kvWithSecurity = {
      get: async (key: string) => {
        if (key === `security:monthly:2026-03`) return JSON.stringify(secEntries)
        return null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(kvWithSecurity, 2026, 3)
    expect(archive.security).not.toBeNull()
    expect(archive.security?.totalAlerts).toBe(3)
    expect(archive.security?.bySource).toEqual({ osv: 2, hackernews: 1, nvd: 0 })
    expect(archive.security?.topFindings[0].title).toBe('RCE in openai') // critical first
  })

  it('leaves archive.security = null when security:monthly key is missing', async () => {
    // Months predating this feature (and months with zero detections) must not crash.
    const archive = await buildMonthlyArchive(mockKV, 2026, 3)
    expect(archive.security).toBeNull()
  })

  it('leaves archive.security = null on malformed security:monthly JSON', async () => {
    const corruptSecurityKV = {
      get: async (key: string) => {
        if (key === 'security:monthly:2026-03') return '{not valid json'
        return null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(corruptSecurityKV, 2026, 3)
    expect(archive.security).toBeNull()
  })

  it('archive.security enriches OSV top findings with per-alert timelines (#291)', async () => {
    const secEntries: MonthlySecurityEntry[] = [
      { title: 'OSV with timeline', url: 'https://osv.dev/vulnerability/GHSA-aaa-bbb-ccc', source: 'osv', severity: 'high', detectedAt: '2026-03-10T00:00:00Z' },
      { title: 'HN no timeline',    url: 'https://news.ycombinator.com/item?id=99',          source: 'hackernews',             detectedAt: '2026-03-11T00:00:00Z' },
    ]
    const timeline: OsvTimeline = {
      vulnId: 'GHSA-aaa-bbb-ccc',
      createdAt: '2026-03-10T00:00:00Z',
      lastSeen: '2026-03-20T00:00:00Z',
      entries: [
        { stage: 'detected',     at: '2026-03-10T00:00:00Z', severity: 'medium' },
        { stage: 'fix_released', at: '2026-03-20T00:00:00Z', fixedVersion: '2.0.0' },
      ],
    }
    const kv = {
      get: async (key: string) => {
        if (key === 'security:monthly:2026-03') return JSON.stringify(secEntries)
        if (key === 'security:timeline:osv:GHSA-aaa-bbb-ccc') return JSON.stringify(timeline)
        return null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(kv, 2026, 3)
    expect(archive.security).not.toBeNull()
    const osvFinding = archive.security!.topFindings.find(f => f.source === 'osv')
    const hnFinding = archive.security!.topFindings.find(f => f.source === 'hackernews')
    expect(osvFinding?.timeline).toHaveLength(2)
    expect(osvFinding?.timeline?.[1].stage).toBe('fix_released')
    expect(hnFinding?.timeline).toBeUndefined()
  })

  it('leaves archive.security = null when the security:monthly KV get rejects', async () => {
    // Pairs with the `.catch(() => null)` guard on the security read — if a future refactor
    // drops the catch, this test fails before the archive rejection propagates to the cron.
    const rejectingKV = {
      get: async (key: string) => {
        if (key === 'security:monthly:2026-03') throw new Error('KV read rejected')
        return null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(rejectingKV, 2026, 3)
    expect(archive.security).toBeNull()
  })

  it('leaves archive.security = null on empty security:monthly array', async () => {
    // A month with the key present but no detections shouldn't produce a zero-valued summary —
    // null is the signal "no security data for this month" for downstream rendering.
    const emptyArrayKV = {
      get: async (key: string) => {
        if (key === 'security:monthly:2026-03') return '[]'
        return null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(emptyArrayKV, 2026, 3)
    expect(archive.security).toBeNull()
  })

  it('sets avgResolutionMin to null when totalMinutes is 0', async () => {
    const kvWithUnresolved = {
      get: async (key: string) => {
        if (key === 'incidents:monthly:2026-04') return JSON.stringify({
          lastUpdated: '2026-04-09T09:00:00Z',
          services: { claude: { count: 2, totalMinutes: 0, longestMinutes: 0, dates: ['2026-04-01'], incidentIds: ['a', 'b'], durations: { a: 0, b: 0 } } },
        })
        return null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(kvWithUnresolved, 2026, 4)
    expect(archive.services.claude.incidents).toBe(2)
    expect(archive.services.claude.avgResolutionMin).toBeNull()
  })
})

// ── Phase 2: Archive-ready notification (aiwatch-reports#4) ──────────

describe('archiveNotifiedKey', () => {
  it('returns the stable archive:notified:{period} form', () => {
    expect(archiveNotifiedKey('2026-04')).toBe('archive:notified:2026-04')
  })
})

describe('buildArchiveReadyEmbed', () => {
  it('renders a full English month label for a valid YYYY-MM', () => {
    const embed = buildArchiveReadyEmbed('2026-04', 31, 30)
    expect(embed.title).toBe('📦 Monthly Archive Ready — 2026-04')
    expect(embed.color).toBe(0x9B59B6)
    expect(embed.description).toContain('**April 2026** archive')
    expect(embed.description).toContain('Services: 31')
    expect(embed.description).toContain('Days collected: 30')
  })

  it('links to the generate-report.yml workflow_dispatch page', () => {
    const embed = buildArchiveReadyEmbed('2026-04', 31, 30)
    expect(embed.description).toContain(REPORTS_WORKFLOW_URL)
    expect(REPORTS_WORKFLOW_URL).toBe(
      'https://github.com/bentleypark/aiwatch-reports/actions/workflows/generate-report.yml',
    )
  })

  it('spells out the month input the operator must enter', () => {
    const embed = buildArchiveReadyEmbed('2026-04', 31, 30)
    expect(embed.description).toMatch(/enter month `2026-04`/)
  })

  it('formats December correctly (month = 12 edge)', () => {
    const embed = buildArchiveReadyEmbed('2026-12', 31, 31)
    expect(embed.description).toContain('**December 2026** archive')
  })

  it('formats January correctly (single-digit month with zero padding)', () => {
    const embed = buildArchiveReadyEmbed('2027-01', 31, 31)
    expect(embed.description).toContain('**January 2027** archive')
  })

  it('renders a usable embed when the archive has zero services or days', () => {
    const embed = buildArchiveReadyEmbed('2026-04', 0, 0)
    expect(embed.title).toBe('📦 Monthly Archive Ready — 2026-04')
    expect(embed.description).toContain('**April 2026** archive')
    expect(embed.description).toContain('Services: 0')
    expect(embed.description).toContain('Days collected: 0')
    expect(embed.description).not.toContain('Invalid Date')
  })

  it('falls back to the raw period when the format is malformed', () => {
    const embed = buildArchiveReadyEmbed('not-a-month', 0, 0)
    expect(embed.title).toBe('📦 Monthly Archive Ready — not-a-month')
    expect(embed.description).toContain('**not-a-month** archive')
    expect(embed.description).not.toContain('Invalid Date')
  })

  it('falls back to the raw period when the month component is out of range', () => {
    const embed = buildArchiveReadyEmbed('2026-13', 0, 0)
    expect(embed.description).toContain('**2026-13** archive')
    expect(embed.description).not.toContain('Invalid Date')
  })

  it('always embeds the archive KV key path for traceability', () => {
    const embed = buildArchiveReadyEmbed('2026-04', 31, 30)
    expect(embed.description).toContain('`archive:monthly:2026-04`')
  })
})

describe('degradation monthly accumulator (#511)', () => {
  it('degradationMonthlyKey is YYYY-MM in UTC', () => {
    expect(degradationMonthlyKey(new Date('2026-06-01T12:00:00Z'))).toBe('probe-degradation:monthly:2026-06')
    expect(degradationMonthlyKey(new Date('2026-01-31T23:59:00Z'))).toBe('probe-degradation:monthly:2026-01')
  })

  describe('addDegradationToMonthly (pure fold)', () => {
    it('starts fresh from null and increments byService only when on-status', () => {
      const out = addDegradationToMonthly(null, 'deepseek', false)
      expect(out).toEqual({ byService: { deepseek: 1 }, noStatusByService: {} })
    })

    it('increments both byService and noStatusByService when not on status page', () => {
      const out = addDegradationToMonthly(null, 'deepseek', true)
      expect(out).toEqual({ byService: { deepseek: 1 }, noStatusByService: { deepseek: 1 } })
    })

    it('accumulates across calls without mutating the input', () => {
      const prev = { byService: { deepseek: 2 }, noStatusByService: { deepseek: 1 } }
      const out = addDegradationToMonthly(prev, 'deepseek', true)
      expect(out).toEqual({ byService: { deepseek: 3 }, noStatusByService: { deepseek: 2 } })
      expect(prev).toEqual({ byService: { deepseek: 2 }, noStatusByService: { deepseek: 1 } }) // unmutated
    })

    it('tracks multiple services independently', () => {
      let acc = addDegradationToMonthly(null, 'deepseek', true)
      acc = addDegradationToMonthly(acc, 'mistral', false)
      expect(acc).toEqual({ byService: { deepseek: 1, mistral: 1 }, noStatusByService: { deepseek: 1 } })
    })
  })

  describe('normalizeDegradationMonthly', () => {
    it('returns empty shape for null/garbage', () => {
      expect(normalizeDegradationMonthly(null)).toEqual({ byService: {}, noStatusByService: {} })
      expect(normalizeDegradationMonthly('nope')).toEqual({ byService: {}, noStatusByService: {} })
    })

    it('keeps only finite non-negative integer counts', () => {
      const out = normalizeDegradationMonthly({
        byService: { deepseek: 3, bad: -1, nan: NaN, frac: 2.7 },
        noStatusByService: { deepseek: 2 },
      })
      expect(out).toEqual({ byService: { deepseek: 3, frac: 2 }, noStatusByService: { deepseek: 2 } })
    })

    it('drops Infinity, negative fractions, and non-number values (Number.isFinite + v>=0 guard, pre-floor)', () => {
      const out = normalizeDegradationMonthly({
        byService: { inf: Infinity, negfrac: -2.7, str: '3', nul: null, obj: {}, ok: 4 },
        noStatusByService: {},
      })
      // Infinity dropped (Number.isFinite), -2.7 dropped (v>=0 runs before Math.floor),
      // '3'/null/{} dropped (typeof !== number); only ok:4 survives.
      expect(out).toEqual({ byService: { ok: 4 }, noStatusByService: {} })
    })
  })

  describe('summarizeDegradation', () => {
    it('returns null for null input or all-zero totals', () => {
      expect(summarizeDegradation(null)).toBeNull()
      expect(summarizeDegradation({ byService: {}, noStatusByService: {} })).toBeNull()
    })

    it('computes total + noStatusTotal across services', () => {
      const out = summarizeDegradation({
        byService: { deepseek: 4, mistral: 1 },
        noStatusByService: { deepseek: 3 },
      })
      expect(out).toEqual({
        total: 5,
        noStatusTotal: 3,
        byService: { deepseek: 4, mistral: 1 },
        noStatusByService: { deepseek: 3 },
      })
    })

    it('returns null when byService is empty even if noStatusByService has counts (corrupt-KV invariant)', () => {
      // total is driven by byService (every nostatus increment also bumps byService in normal flow).
      // A hand-edited/corrupt accumulator with byService empty but noStatus populated → null (garbage
      // in → null out). Pins the byService-drives-total invariant.
      expect(summarizeDegradation({ byService: {}, noStatusByService: { deepseek: 3 } })).toBeNull()
    })
  })
})

// The WIRING half of #1002 / aiwatch-reports#76. resolveArchiveProbeSummary being correct proves
// nothing about the archive carrying its result — deleting the spread at the per-service build site
// left every unit test above green. This drives the real buildMonthlyArchive and reads the field off
// the archive it produced.
describe('buildMonthlyArchive — Responsiveness inputs (#1002 / aiwatch-reports#76)', () => {
  // 7 days is the floor classifyProbe needs (MIN_VALID_DAYS); count 288 = a full day of 5-min probes,
  // over summariesFromDailyData's 200-snapshot bar. p95/p50 = 3× stays under its 10× spread cut.
  const probeDays = Object.fromEntries(
    Array.from({ length: 7 }, (_, i) => [
      `probe:daily:2026-03-${String(i + 1).padStart(2, '0')}`,
      JSON.stringify({
        claude: { p50: 100, p75: 200, p95: 300, min: 50, max: 400, count: 288, spikes: 0 },
        // A second probed service with a DISTINCT p50 — without it nothing pins that each row gets its
        // OWN summary: hardcoding the lookup to 'claude', or hoisting the per-service local out of the
        // loop so one service's summary leaks onto the next row, both pass a claude-only fixture. That
        // leak would publish a p50 under the wrong service, which is the misattribution the display ≡
        // score rule exists to prevent.
        groq: { p50: 250, p75: 400, p95: 600, min: 120, max: 800, count: 288, spikes: 0 },
      }),
    ]),
  )
  const kv = {
    get: async (key: string) => (probeDays as Record<string, string>)[key] ?? null,
    put: async () => {},
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace

  it('carries the p50 + cvCombined the month scored, per service, from that service\'s own summary', async () => {
    const archive = await buildMonthlyArchive(kv, 2026, 3, [
      { id: 'claude', aiwatchScore: 85, scoreGrade: 'excellent' as const },
      { id: 'groq', aiwatchScore: 91, scoreGrade: 'excellent' as const },
      // gemini IS a probe target but has no probe data this month → no summary. It sits in the same
      // archive as two services that DO have one, which is what opens the leak path: a lookup that
      // falls back to the previous row's summary only misbehaves on a row that has none of its own.
      { id: 'gemini', aiwatchScore: 64, scoreGrade: 'fair' as const },
    ])
    // cvCombined = 0.3·cvDaily + 0.7·spread = 0.3·0 + 0.7·((300−100)/100) = 1.4
    expect(archive.services.claude.p50LatencyMs).toBe(100)
    expect(archive.services.claude.cvCombined).toBeCloseTo(1.4, 3)
    // Distinct values, so a row reading the wrong service's summary fails here rather than passing.
    // 0.7·((600−250)/250) = 0.98
    expect(archive.services.groq.p50LatencyMs).toBe(250)
    expect(archive.services.groq.cvCombined).toBeCloseTo(0.98, 3)
    // A row with no summary of its own must report null — never inherit a neighbour's figure.
    expect(archive.services.gemini.p50LatencyMs).toBeNull()
    expect(archive.services.gemini.cvCombined).toBeNull()
  })

  it('the p50 is NOT the unfiltered mean the p75/p95 columns use — they answer different questions', async () => {
    const archive = await buildMonthlyArchive(kv, 2026, 3, [{ id: 'claude', aiwatchScore: 85, scoreGrade: 'excellent' as const }])
    // avgLatencyMs is a mean of daily p75 over ALL days; p50LatencyMs comes from the filtered summary.
    // Publishing the former as "the Responsiveness input" is the defect aiwatch-reports#76 exists to fix.
    expect(archive.services.claude.avgLatencyMs).toBe(200)
    expect(archive.services.claude.p50LatencyMs).toBe(100)
  })

  // Load-bearing beyond its title: the other wiring fixtures use a CONSTANT daily p50, so an unfiltered
  // daily-p50 mean — aiwatch-reports#76's original proposal — is numerically identical to the filtered
  // summary there and no assertion can tell them apart. Here they diverge (count 100 drops every day →
  // null, but an unfiltered mean still returns 100), so this is the only test standing between the code
  // and a silent regression back to the wrong source. Do not relax the count.
  it('nulls both fields when the days are too thin to score (probed, but no Responsiveness)', async () => {
    // count 100 < the 200-snapshot bar → every day dropped → no summary → classifyProbe 'insufficient'.
    // avgLatencyMs still reports, because it never filters: exactly the pair the display ≡ score rule
    // has to keep apart.
    const thin = {
      get: async (key: string) =>
        key.startsWith('probe:daily:2026-03-0')
          ? JSON.stringify({ claude: { p50: 100, p75: 200, p95: 300, min: 50, max: 400, count: 100, spikes: 0 } })
          : null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace
    const archive = await buildMonthlyArchive(thin, 2026, 3, [{ id: 'claude', aiwatchScore: 85, scoreGrade: 'excellent' as const }])
    expect(archive.services.claude.avgLatencyMs).toBe(200)
    expect(archive.services.claude.p50LatencyMs).toBeNull()
    expect(archive.services.claude.cvCombined).toBeNull()
  })

  it('an inheriting service reports the PARENT probe end-to-end, with its own avgLatencyMs still null', () => {
    // The row a reader will find odd, and the one the unit tests could not pin: claudecode has no probe
    // of its own, so avgLatencyMs (keyed by its own id) is null while p50LatencyMs carries claude's —
    // because claude's probe is what actually scored it (#883). Asserted together, on one object, since
    // the pair is the confusing part. It also warns the reports side: a p50 column filtered on
    // `avgLatencyMs !== null` (generate-report.js's existing idiom) would drop exactly this row.
    return buildMonthlyArchive(kv, 2026, 3, [{ id: 'claudecode', aiwatchScore: 80, scoreGrade: 'good' as const }]).then((archive) => {
      expect(archive.services.claudecode.avgLatencyMs).toBeNull()
      expect(archive.services.claudecode.p50LatencyMs).toBe(100)
      expect(archive.services.claudecode.cvCombined).toBeCloseTo(1.4, 3)
    })
  })
})

describe('buildMonthlyArchive — degradation integration (#511)', () => {
  function mkKv(initial: Record<string, string>) {
    return {
      get: async (key: string) => initial[key] ?? null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace
  }

  it('attaches degradation summary when monthly accumulator has counts', async () => {
    const kv = mkKv({
      'probe-degradation:monthly:2026-04': JSON.stringify({
        byService: { deepseek: 4, mistral: 1 },
        noStatusByService: { deepseek: 3 },
      }),
    })
    const archive = await buildMonthlyArchive(kv, 2026, 4)
    expect(archive.degradation).not.toBeNull()
    expect(archive.degradation!.total).toBe(5)
    expect(archive.degradation!.noStatusTotal).toBe(3)
    expect(archive.degradation!.byService).toEqual({ deepseek: 4, mistral: 1 })
  })

  it('attaches null when accumulator is missing', async () => {
    const archive = await buildMonthlyArchive(mkKv({}), 2026, 4)
    expect(archive.degradation).toBeNull()
  })

  it('attaches null when accumulator JSON is malformed (no archive crash)', async () => {
    const archive = await buildMonthlyArchive(mkKv({ 'probe-degradation:monthly:2026-04': '{bad json' }), 2026, 4)
    expect(archive.degradation).toBeNull()
  })

  it('attaches null when accumulator has all-zero totals', async () => {
    const kv = mkKv({ 'probe-degradation:monthly:2026-04': JSON.stringify({ byService: {}, noStatusByService: {} }) })
    const archive = await buildMonthlyArchive(kv, 2026, 4)
    expect(archive.degradation).toBeNull()
  })
})

// ── buildPartialIncidentArchive (#587 mid-month) ──────────────────────
describe('buildPartialIncidentArchive (#587)', () => {
  const mkEntry = (id: string, over = {}) => ({
    id, title: `Incident ${id}`, startedAt: '2026-06-13T01:26:00.000Z',
    resolvedAt: null, durationMin: 0, finalStatus: 'investigating' as const, ...over,
  })
  const mkAccumulator = (services: Record<string, unknown>) => ({ lastUpdated: '2026-06-13T02:00:00.000Z', services }) as Parameters<typeof buildPartialIncidentArchive>[1]

  it('emits incidentList per service from the accumulator (shape matches the real archive)', () => {
    const acc = mkAccumulator({
      bedrock: { count: 1, totalMinutes: 0, longestMinutes: 0, dates: ['2026-06-13'], incidentIds: ['aws-1'], durations: {}, incidents: [mkEntry('aws-1', { title: 'Service impact: Fable 5 and Mythos 5 Access' })] },
    })
    const out = buildPartialIncidentArchive('2026-06', acc)
    expect(out.partial).toBe(true)
    expect(out.period).toBe('2026-06')
    expect(out.services.bedrock.incidentList).toHaveLength(1)
    expect(out.services.bedrock.incidentList[0].id).toBe('aws-1')
    expect(out.services.bedrock.incidentList[0].title).toBe('Service impact: Fable 5 and Mythos 5 Access')
  })

  it('omits services with no incidents (mergeArchiveIntoMap skips empty incidentList anyway)', () => {
    const acc = mkAccumulator({
      bedrock: { count: 1, totalMinutes: 0, longestMinutes: 0, dates: [], incidentIds: ['aws-1'], durations: {}, incidents: [mkEntry('aws-1')] },
      azureopenai: { count: 0, totalMinutes: 0, longestMinutes: 0, dates: [], incidentIds: [], durations: {}, incidents: [] },
    })
    const out = buildPartialIncidentArchive('2026-06', acc)
    expect(out.services.bedrock).toBeDefined()
    expect(out.services.azureopenai).toBeUndefined()
  })

  it('returns an empty services map for null/empty accumulator (no archive, no crash)', () => {
    expect(buildPartialIncidentArchive('2026-06', null).services).toEqual({})
    expect(buildPartialIncidentArchive('2026-06', mkAccumulator({})).services).toEqual({})
  })

  it('deep-clones entries (no shared reference into the accumulator)', () => {
    const entry = mkEntry('aws-1')
    const acc = mkAccumulator({ bedrock: { count: 1, totalMinutes: 0, longestMinutes: 0, dates: [], incidentIds: ['aws-1'], durations: {}, incidents: [entry] } })
    const out = buildPartialIncidentArchive('2026-06', acc)
    expect(out.services.bedrock.incidentList[0]).not.toBe(entry)
    expect(out.services.bedrock.incidentList[0]).toEqual(entry)
  })
})

// ── #975 phantom prune (upstream delete + re-publish) ────────────────

describe('prunePhantomIncidents (#975)', () => {
  // A stored accumulator entry, defaulting to the shape a live-observed unresolved incident leaves.
  const entry = (o: Partial<MonthlyIncidentEntry> & { id: string }): MonthlyIncidentEntry => ({
    title: `Incident ${o.id}`, startedAt: '2026-07-09T13:34:38.481Z', resolvedAt: null,
    durationMin: 0, finalStatus: 'monitoring', impact: 'major', ...o,
  })

  const stored = (entries: MonthlyIncidentEntry[]): MonthlyIncidents => ({
    lastUpdated: '2026-07-09T14:00:00.000Z',
    services: {
      pinecone: {
        count: entries.length,
        totalMinutes: entries.reduce((a: number, e: MonthlyIncidentEntry) => a + e.durationMin, 0),
        longestMinutes: entries.reduce((m: number, e: MonthlyIncidentEntry) => Math.max(m, e.durationMin), 0),
        dates: ['2026-07-09'],
        incidentIds: entries.map((e: MonthlyIncidentEntry) => e.id),
        durations: Object.fromEntries(entries.map((e: MonthlyIncidentEntry) => [e.id, e.durationMin])),
        incidents: entries,
      },
    },
  })

  const liveSvc = (incidents: Array<{ id: string; startedAt: string; status?: string }>): ServiceStatus => ({
    id: 'pinecone', name: 'Pinecone', provider: 'Pinecone', category: 'api', status: 'degraded',
    latency: null, uptime30d: null, lastChecked: '', incidents: incidents.map(i => ({
      id: i.id, title: `Incident ${i.id}`, status: (i.status ?? 'resolved') as any, impact: null,
      startedAt: i.startedAt, duration: null, timeline: [],
    })),
  })

  // The real event: Pinecone published `xqp5fkvlyg6t` (started 13:34), then deleted it and
  // re-published the same outage as `m3wrr6csl9jm` (backdated to 09:50, title reworded).
  const PHANTOM = entry({ id: 'xqp5fkvlyg6t', startedAt: '2026-07-09T13:34:38.481Z' })
  const REPLACEMENT = { id: 'm3wrr6csl9jm', startedAt: '2026-07-09T09:50:14.000Z' }

  const runs = (data: MonthlyIncidents, svc: ServiceStatus, n: number): MonthlyIncidents => {
    let out = data
    for (let i = 0; i < n; i++) out = prunePhantomIncidents(out, [svc], [])
    return out
  }

  it('prunes the phantom only after PHANTOM_PRUNE_AFTER_MISSED_RUNS consecutive misses', () => {
    const live = liveSvc([REPLACEMENT])
    let data = stored([PHANTOM])

    for (let i = 1; i < PHANTOM_PRUNE_AFTER_MISSED_RUNS; i++) {
      data = prunePhantomIncidents(data, [live], [])
      expect(data.services.pinecone.incidents!.map((e: MonthlyIncidentEntry) => e.id)).toEqual(['xqp5fkvlyg6t'])
      expect(data.services.pinecone.incidents![0].missedRuns).toBe(i)
    }
    data = prunePhantomIncidents(data, [live], [])
    expect(data.services.pinecone.incidents).toEqual([])
    expect(data.services.pinecone.incidentIds).toEqual([])
    expect(data.services.pinecone.count).toBe(0)
  })

  it('a transient single-cycle miss never prunes — the counter resets on reappearance', () => {
    const gone = liveSvc([REPLACEMENT])
    const back = liveSvc([REPLACEMENT, { id: 'xqp5fkvlyg6t', startedAt: PHANTOM.startedAt, status: 'monitoring' }])

    let data = prunePhantomIncidents(stored([PHANTOM]), [gone], [])
    expect(data.services.pinecone.incidents![0].missedRuns).toBe(1)

    data = prunePhantomIncidents(data, [back], [])
    expect(data.services.pinecone.incidents![0].missedRuns).toBeUndefined()

    // Two more misses would have pruned had the counter not reset.
    data = runs(data, gone, PHANTOM_PRUNE_AFTER_MISSED_RUNS - 1)
    expect(data.services.pinecone.incidents!.map((e: MonthlyIncidentEntry) => e.id)).toEqual(['xqp5fkvlyg6t'])
  })

  it('never prunes a RESOLVED entry, however long it is absent', () => {
    const resolved = entry({ id: 'old-resolved', finalStatus: 'resolved', resolvedAt: '2026-07-02T00:00:00Z', durationMin: 30, startedAt: '2026-07-01T00:00:00Z' })
    // Live feed has only a NEWER incident, so `oldestLiveStart` is after the resolved entry —
    // guard 3 would hold it anyway; guard 1 must hold it regardless.
    const live = liveSvc([{ id: 'other', startedAt: '2026-07-08T00:00:00Z' }])
    const out = runs(stored([resolved]), live, PHANTOM_PRUNE_AFTER_MISSED_RUNS + 2)
    expect(out.services.pinecone.incidents!.map((e: MonthlyIncidentEntry) => e.id)).toEqual(['old-resolved'])
    expect(out.services.pinecone.count).toBe(1)
  })

  it('an empty live list (failed fetch) never prunes', () => {
    const empty = liveSvc([])
    const out = runs(stored([PHANTOM]), empty, PHANTOM_PRUNE_AFTER_MISSED_RUNS + 2)
    expect(out.services.pinecone.incidents!.map((e: MonthlyIncidentEntry) => e.id)).toEqual(['xqp5fkvlyg6t'])
    expect(out.services.pinecone.incidents![0].missedRuns).toBeUndefined()
  })

  it('a service missing from this cycle entirely never prunes', () => {
    const out = runs(stored([PHANTOM]), liveSvc([REPLACEMENT]), 0)
    expect(prunePhantomIncidents(out, [], []).services.pinecone.incidents!.map((e: MonthlyIncidentEntry) => e.id)).toEqual(['xqp5fkvlyg6t'])
  })

  it('guard 3: an entry OLDER than everything in the live feed is held, not pruned (feed truncation)', () => {
    // The phantom started before the oldest live incident → we cannot distinguish "deleted" from
    // "fell off the end of the feed window", so it must survive indefinitely.
    const oldPhantom = entry({ id: 'ancient', startedAt: '2026-07-01T00:00:00Z' })
    const live = liveSvc([{ id: 'newer', startedAt: '2026-07-05T00:00:00Z' }])
    const out = runs(stored([oldPhantom]), live, PHANTOM_PRUNE_AFTER_MISSED_RUNS + 2)
    expect(out.services.pinecone.incidents!.map((e: MonthlyIncidentEntry) => e.id)).toEqual(['ancient'])
    expect(out.services.pinecone.incidents![0].missedRuns).toBeUndefined()
  })

  it('recomputes count / totalMinutes / longestMinutes from the survivors', () => {
    const a = entry({ id: 'a', startedAt: '2026-07-09T02:00:00Z', finalStatus: 'resolved', durationMin: 30 })
    const b = entry({ id: 'b', startedAt: '2026-07-09T03:00:00Z', finalStatus: 'resolved', durationMin: 90 })
    const live = liveSvc([
      { id: 'a', startedAt: '2026-07-09T02:00:00Z' },
      { id: 'b', startedAt: '2026-07-09T03:00:00Z' },
    ])
    const out = runs(stored([a, b, PHANTOM]), live, PHANTOM_PRUNE_AFTER_MISSED_RUNS)
    const svc = out.services.pinecone
    expect(svc.incidents!.map((e: MonthlyIncidentEntry) => e.id)).toEqual(['a', 'b'])
    expect(svc.count).toBe(2)
    expect(svc.totalMinutes).toBe(120)
    expect(svc.longestMinutes).toBe(90)
    expect(svc.durations).toEqual({ a: 30, b: 90 })
    // `dates` is intentionally untouched (no consumer; recomputing would drop truncated entries' dates).
    expect(svc.dates).toEqual(['2026-07-09'])
  })

  it('a truncated-but-counted incident (id present, no detail row) is never mistaken for a phantom', () => {
    const data = stored([PHANTOM])
    data.services.pinecone.incidentIds.unshift('truncated-old')
    data.services.pinecone.durations['truncated-old'] = 45
    data.services.pinecone.count = 2
    data.services.pinecone.totalMinutes = 45

    const out = runs(data, liveSvc([REPLACEMENT]), PHANTOM_PRUNE_AFTER_MISSED_RUNS)
    // Phantom gone; the truncated entry survives in incidentIds/durations and still counts.
    expect(out.services.pinecone.incidents).toEqual([])
    expect(out.services.pinecone.incidentIds).toEqual(['truncated-old'])
    expect(out.services.pinecone.count).toBe(1)
    expect(out.services.pinecone.totalMinutes).toBe(45)
  })

  // #975 — the highest-consequence guard. `fetchAllServices` applies `applySuppressions` BEFORE the
  // accumulator sees the list (services.ts), so an operator-hidden incident is missing from the live
  // feed by POLICY. Pruning it would erase durable data that `filterSuppressedFromMonthly` is only
  // supposed to hide, and un-suppressing would restore nothing.
  it('never prunes an operator-SUPPRESSED unresolved incident (id scope)', () => {
    const suppressions = [{ scope: 'incident' as const, incId: 'xqp5fkvlyg6t' }]
    const out = (() => {
      let d = stored([PHANTOM])
      for (let i = 0; i < PHANTOM_PRUNE_AFTER_MISSED_RUNS + 2; i++) d = prunePhantomIncidents(d, [liveSvc([REPLACEMENT])], suppressions)
      return d
    })()
    expect(out.services.pinecone.incidents!.map((e: MonthlyIncidentEntry) => e.id)).toEqual(['xqp5fkvlyg6t'])
    expect(out.services.pinecone.incidents![0].missedRuns).toBeUndefined()
    expect(out.services.pinecone.count).toBe(1)
  })

  it('never prunes an operator-SUPPRESSED unresolved incident (service-pattern scope)', () => {
    const suppressions = [{ scope: 'service-pattern' as const, svcId: 'pinecone', match: '5xx errors' }]
    const phantom = entry({ id: 'xqp5fkvlyg6t', title: '[Serverless][Azure][eastus2] 5xx errors for some requests' })
    let d = stored([phantom])
    for (let i = 0; i < PHANTOM_PRUNE_AFTER_MISSED_RUNS + 2; i++) d = prunePhantomIncidents(d, [liveSvc([REPLACEMENT])], suppressions)
    expect(d.services.pinecone.incidents!.map((e: MonthlyIncidentEntry) => e.id)).toEqual(['xqp5fkvlyg6t'])
  })

  // Fail-CLOSED: an unreadable suppression list must not read as "nothing is hidden".
  it('null suppressions (unreadable list) disables pruning entirely', () => {
    let d = stored([PHANTOM])
    for (let i = 0; i < PHANTOM_PRUNE_AFTER_MISSED_RUNS + 2; i++) d = prunePhantomIncidents(d, [liveSvc([REPLACEMENT])], null)
    expect(d.services.pinecone.incidents!.map((e: MonthlyIncidentEntry) => e.id)).toEqual(['xqp5fkvlyg6t'])
    expect(d.services.pinecone.incidents![0].missedRuns).toBeUndefined()
    expect(prunePhantomIncidents(d, [liveSvc([REPLACEMENT])], null)).toBe(d) // identity, no work done
  })

  // Review finding (#975): a hold is NOT a confident miss. Without the reset, a phantom whose older
  // live sibling ages out of the feed freezes at missedRuns=2 forever — never pruned, never cleared,
  // and the internal counter then leaks into the permanent archive at month rollover.
  it('guard-3 hold RESETS the counter, so the N runs are strictly consecutive', () => {
    const withOlder = liveSvc([REPLACEMENT]) // older sibling present → guard 3 passes
    const noOlder = liveSvc([{ id: 'newer', startedAt: '2026-07-09T20:00:00Z' }]) // nothing older → hold

    let d = prunePhantomIncidents(stored([PHANTOM]), [withOlder], [])
    d = prunePhantomIncidents(d, [withOlder], [])
    expect(d.services.pinecone.incidents![0].missedRuns).toBe(2)

    d = prunePhantomIncidents(d, [noOlder], []) // hold → reset
    expect(d.services.pinecone.incidents![0].missedRuns).toBeUndefined()

    // One more confident miss must NOT prune (would have, if the counter had frozen at 2).
    d = prunePhantomIncidents(d, [withOlder], [])
    expect(d.services.pinecone.incidents!.map((e: MonthlyIncidentEntry) => e.id)).toEqual(['xqp5fkvlyg6t'])
    expect(d.services.pinecone.incidents![0].missedRuns).toBe(1)
  })

  it('a malformed stored startedAt is held, never pruned (lexicographic trap)', () => {
    // 'pending' sorts AFTER any '2xxx-…' ISO string, so an unvalidated compare would pass guard 3.
    const bad = entry({ id: 'bad-start', startedAt: 'pending' })
    let d = stored([bad])
    for (let i = 0; i < PHANTOM_PRUNE_AFTER_MISSED_RUNS + 2; i++) d = prunePhantomIncidents(d, [liveSvc([REPLACEMENT])], [])
    expect(d.services.pinecone.incidents!.map((e: MonthlyIncidentEntry) => e.id)).toEqual(['bad-start'])
    expect(d.services.pinecone.incidents![0].missedRuns).toBeUndefined()
  })

  it('an id that is present but non-string on the live side still counts as SEEN', () => {
    // A parser regression emitting numeric ids must not make a present incident look deleted.
    const svc = liveSvc([REPLACEMENT])
    ;(svc.incidents[0] as unknown as { id: unknown }).id = 12345
    const stored1 = stored([entry({ id: '12345', startedAt: '2026-07-09T13:34:38.481Z' })])
    let d = stored1
    for (let i = 0; i < PHANTOM_PRUNE_AFTER_MISSED_RUNS + 2; i++) d = prunePhantomIncidents(d, [svc], [])
    expect(d.services.pinecone.incidents!.map((e: MonthlyIncidentEntry) => e.id)).toEqual(['12345'])
  })

  it('is pure — the input accumulator is not mutated', () => {
    const data = stored([PHANTOM])
    const before = structuredClone(data)
    prunePhantomIncidents(data, [liveSvc([REPLACEMENT])], [])
    expect(data).toEqual(before)
  })

  it('returns the input by identity when nothing changed', () => {
    const data = stored([entry({ id: 'x', finalStatus: 'resolved', durationMin: 10 })])
    expect(prunePhantomIncidents(data, [liveSvc([{ id: 'x', startedAt: '2026-07-09T13:34:38.481Z' }])], [])).toBe(data)
  })

  it('tolerates a structurally-corrupt accumulator', () => {
    expect(prunePhantomIncidents({ lastUpdated: '', services: undefined as any }, [], [])).toEqual({ lastUpdated: '', services: undefined })
  })
})

// ── #975 end-to-end through accumulateMonthlyIncidents ───────────────

describe('accumulateMonthlyIncidents — phantom self-heal (#975)', () => {
  const svc = (incidents: Array<{ id: string; startedAt: string; status: string; duration: string | null }>): ServiceStatus => ({
    id: 'pinecone', name: 'Pinecone', provider: 'Pinecone', category: 'api', status: 'degraded',
    latency: null, uptime30d: null, lastChecked: '', incidents: incidents.map(i => ({
      id: i.id, title: `Incident ${i.id}`, status: i.status as any, impact: 'major',
      startedAt: i.startedAt, duration: i.duration, timeline: [],
    })),
  })

  it('reproduces the reported bug: id A observed live, upstream replaces it with id B → A is gone and count === 1', () => {
    // Cycle 1 — Pinecone is showing `xqp5fkvlyg6t`, unresolved.
    let acc = accumulateMonthlyIncidents(null, [svc([
      { id: 'xqp5fkvlyg6t', startedAt: '2026-07-09T13:34:38.481Z', status: 'monitoring', duration: null },
    ])], '2026-07', [])
    expect(acc.services.pinecone.count).toBe(1)

    // Upstream deletes it and re-publishes the same outage under a new id, backdated + reworded.
    const replaced = svc([
      { id: 'm3wrr6csl9jm', startedAt: '2026-07-09T09:50:14.000Z', status: 'resolved', duration: '4h 48m' },
    ])

    // Both are present for the first few cycles (count 2 — the bug, as observed in production).
    acc = accumulateMonthlyIncidents(acc, [replaced], '2026-07', [])
    expect(acc.services.pinecone.count).toBe(2)
    expect(acc.services.pinecone.incidents!.map((e: MonthlyIncidentEntry) => e.id).sort()).toEqual(['m3wrr6csl9jm', 'xqp5fkvlyg6t'])

    // …then the phantom is reconciled away.
    for (let i = 1; i < PHANTOM_PRUNE_AFTER_MISSED_RUNS; i++) acc = accumulateMonthlyIncidents(acc, [replaced], '2026-07', [])

    expect(acc.services.pinecone.incidents!.map((e: MonthlyIncidentEntry) => e.id)).toEqual(['m3wrr6csl9jm'])
    expect(acc.services.pinecone.count).toBe(1)
    expect(acc.services.pinecone.totalMinutes).toBe(288)
    expect(acc.services.pinecone.longestMinutes).toBe(288)
    expect(acc.services.pinecone.incidents![0].finalStatus).toBe('resolved')
  })

  it('self-heals even on a cycle where the service reports no incident for THIS period', () => {
    // The replacement resolved and aged out of the feed; only a previous-month incident remains.
    // The period filter would `continue` past this service, so the prune must run before it.
    let acc = accumulateMonthlyIncidents(null, [svc([
      { id: 'phantom', startedAt: '2026-07-09T13:34:38.481Z', status: 'monitoring', duration: null },
    ])], '2026-07', [])

    const onlyLastMonth = svc([{ id: 'june', startedAt: '2026-06-20T00:00:00Z', status: 'resolved', duration: '1h' }])
    for (let i = 0; i < PHANTOM_PRUNE_AFTER_MISSED_RUNS; i++) acc = accumulateMonthlyIncidents(acc, [onlyLastMonth], '2026-07', [])

    expect(acc.services.pinecone.incidents).toEqual([])
    expect(acc.services.pinecone.count).toBe(0)
  })
})

// ── #975 internal bookkeeping must not leak to public payloads ───────

describe('stripInternalFields (#975)', () => {
  const withCounter: MonthlyIncidentEntry = {
    id: 'p1', title: 'x', startedAt: '2026-07-09T13:34:38.481Z', resolvedAt: null,
    durationMin: 0, finalStatus: 'monitoring', impact: 'major', missedRuns: 2,
  }

  it('drops missedRuns and preserves everything else', () => {
    const out = stripInternalFields(withCounter)
    expect(out).not.toHaveProperty('missedRuns')
    expect(out).toEqual({
      id: 'p1', title: 'x', startedAt: '2026-07-09T13:34:38.481Z', resolvedAt: null,
      durationMin: 0, finalStatus: 'monitoring', impact: 'major',
    })
  })

  // Guards the whole class, not just today's one field: `stripInternalFields` hard-codes the fields it
  // drops, so a future internal-only addition to MonthlyIncidentEntry would leak silently. This pins
  // the PUBLIC key set of the emitted payload — add a field here only if the reports site may see it.
  it('the emitted public entry exposes ONLY the allowlisted keys', () => {
    const PUBLIC_KEYS = ['id', 'title', 'startedAt', 'resolvedAt', 'durationMin', 'finalStatus', 'impact']
    const acc: MonthlyIncidents = {
      lastUpdated: '', services: { pinecone: {
        count: 1, totalMinutes: 0, longestMinutes: 0, dates: [], incidentIds: ['p1'],
        durations: { p1: 0 }, incidents: [withCounter],
      } },
    }
    const emitted = buildPartialIncidentArchive('2026-07', acc).services.pinecone.incidentList[0]
    expect(Object.keys(emitted).sort()).toEqual([...PUBLIC_KEYS].sort())
  })

  it('buildPartialIncidentArchive (/api/report, current month) never emits missedRuns', () => {
    const acc: MonthlyIncidents = {
      lastUpdated: '', services: { pinecone: {
        count: 1, totalMinutes: 0, longestMinutes: 0, dates: [], incidentIds: ['p1'],
        durations: { p1: 0 }, incidents: [withCounter],
      } },
    }
    const out = buildPartialIncidentArchive('2026-07', acc)
    expect(out.services.pinecone.incidentList[0]).not.toHaveProperty('missedRuns')
    expect(JSON.stringify(out)).not.toContain('missedRuns')
  })
})

describe('computeMonthlyScore (#993)', () => {
  const WINDOW = { startISO: '2026-06-01T00:00:00.000Z', endISO: '2026-07-01T00:00:00.000Z' }
  const noProbe = new Map() // empty summaries → unsupported/insufficient, matching a no-probe month

  const inc = (startedAt: string, durationMin: number, impact: 'minor' | 'major' | 'critical' = 'major') => ({
    id: startedAt, title: 't', startedAt, resolvedAt: startedAt, durationMin,
    finalStatus: 'resolved' as const, impact,
  })

  it('scores over the calendar month, not a build-day snapshot — fewer/shorter incidents ⇒ higher Score', () => {
    // The Deepgram paradox this fixes: month-aggregate incidents improved yet the snapshot Score fell.
    // With a month-windowed score, a genuinely better month must score at least as well.
    const bad = computeMonthlyScore('x', [inc('2026-06-05T00:00:00Z', 600), inc('2026-06-12T00:00:00Z', 600), inc('2026-06-20T00:00:00Z', 600)], 99, noProbe, WINDOW, undefined)
    const good = computeMonthlyScore('x', [inc('2026-06-10T00:00:00Z', 60)], 99, noProbe, WINDOW, undefined)
    expect(good.score).not.toBeNull()
    expect(bad.score).not.toBeNull()
    expect(good.score!).toBeGreaterThan(bad.score!)
  })


  it('includes a last-second incident regardless of sub-second precision (#993 boundary)', () => {
    // A next-day-midnight end bound is precision-agnostic; a `…T23:59:59.999Z` bound would exclude a
    // `…T23:59:59Z` (no ms) incident because 'Z' > '.' in a string compare.
    const lastSecNoMs = computeMonthlyScore('x', [inc('2026-06-30T23:59:59Z', 600)], 99, noProbe, WINDOW, undefined)
    const lastSecMs = computeMonthlyScore('x', [inc('2026-06-30T23:59:59.000Z', 600)], 99, noProbe, WINDOW, undefined)
    const empty = computeMonthlyScore('x', [], 99, noProbe, WINDOW, undefined)
    // Both last-second incidents must be counted → a worse score than the incident-free month.
    expect(lastSecNoMs.score!).toBeLessThan(empty.score!)
    expect(lastSecNoMs.score).toBe(lastSecMs.score)
  })

  it('only counts incidents INSIDE the window', () => {
    // An incident in May (before the window) must not drag June's score down.
    const withMay = computeMonthlyScore('x', [inc('2026-05-15T00:00:00Z', 600), inc('2026-06-10T00:00:00Z', 60)], 99, noProbe, WINDOW, undefined)
    const juneOnly = computeMonthlyScore('x', [inc('2026-06-10T00:00:00Z', 60)], 99, noProbe, WINDOW, undefined)
    expect(withMay.score).toBe(juneOnly.score)
  })

  it('no official uptime ⇒ Uptime component dropped ⇒ low confidence (mirrors the live #713 rule)', () => {
    // Deepgram's real shape: no official uptime, no probe → score computed on incidents+recovery only.
    const r = computeMonthlyScore('x', [inc('2026-06-10T00:00:00Z', 60)], null, noProbe, WINDOW, undefined)
    expect(r.confidence).toBe('low')
    expect(r.score).toBeNull() // #713 withholds a low-confidence score
  })

  it('a clean month with official uptime and no incidents scores high', () => {
    const r = computeMonthlyScore('x', [], 100, noProbe, WINDOW, undefined)
    expect(r.confidence).toBe('high')
    expect(r.score).toBeGreaterThan(80)
  })

  it('#1021 — excludes a usage-limits/quota advisory from the Score by TITLE, even with a stored minor impact', () => {
    // The rebuild-divergence case: a pre-#1021 month stored the Codex "Usage Limits Depleting" advisory as
    // impact:'minor'. The Score must exclude it by title (as the downtime aggregate does), so a month whose
    // ONLY incident is that advisory scores identically to an incident-free month — not the depressed 86→76.
    const advisory = { id: 'a', title: 'Codex Usage Limits Depleting Faster Than Expected', startedAt: '2026-06-05T00:00:00Z', resolvedAt: '2026-06-08T03:00:00Z', durationMin: 4323, finalStatus: 'resolved' as const, impact: 'minor' as const }
    const withAdvisory = computeMonthlyScore('x', [advisory], 100, noProbe, WINDOW, undefined)
    const clean = computeMonthlyScore('x', [], 100, noProbe, WINDOW, undefined)
    expect(withAdvisory.score).toBe(clean.score) // advisory contributes nothing to the Score

    // Control: a real outage with the SAME stored impact + duration DOES drop the Score.
    const realOutage = { ...advisory, title: 'Elevated error rates on Codex' }
    const withOutage = computeMonthlyScore('x', [realOutage], 100, noProbe, WINDOW, undefined)
    expect(withOutage.score!).toBeLessThan(clean.score!)
  })
})
