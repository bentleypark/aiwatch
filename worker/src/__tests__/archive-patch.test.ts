// #1295 — the archive correction: same duplicates, applied to the frozen copy the reports site reads.
//
// What is under test is mostly that this module does NOT reimplement anything. The figures come from
// `aggregateIncidentDurations` and `computeMonthlyScore`, and the collision rule is the shipped
// `derivedDayAlreadyBankedFromFeed` — so the assertions here are about the REPRODUCTION GATE (a
// service whose stored numbers do not come back identical must be refused, never guessed at) and about
// the boundary adapter that lets the guard read a stored row.
import { describe, it, expect } from 'vitest'
import {
  planArchivePatch, applyArchivePatch, figuresFrom, storedFigures, figureDiff, resourceOfDerivedEntry,
} from '../archive-patch'
import type { PatchableArchive } from '../archive-patch'
import { applyCommands, monthWindow, NAMESPACE_ID } from '../archive-patch'
import { buildMonthlyArchive } from '../monthly-archive'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MonthlyIncidentEntry } from '../monthly-archive'

const WINDOW = { startISO: '2026-08-01T00:00:00.000Z', endISO: '2026-09-01T00:00:00.000Z' }
const RESOURCE = 'Google Gemma 4 31B IT'
// status.together.ai is America/Los_Angeles: local day 2026-08-04 runs 07:00Z → 07:00Z, anchor 19:00Z.
const ANCHOR = '2026-08-04T19:00:00.000Z'

// The feed row sits at 02:00Z on the NEXT UTC date — still inside together's local day (07:00Z→07:00Z),
// so the guard matches it while `incidentDay` files it on a different day. That is what makes removing
// the derived row move `weightedAffectedDays`, and therefore `monthlyScore`. A same-UTC-day fixture
// leaves the score identical and the three score writes in `applyArchivePatch` unpinned — verified by
// mutation: dropping each of them survived until this row crossed the date.
const CROSS_DAY_FEED = '2026-08-05T02:00:00.000Z'

const feed = (title: string, startedAt: string, durationMin = 11): MonthlyIncidentEntry => ({
  id: `#rss-${title}-${startedAt}`, title, startedAt,
  resolvedAt: new Date(Date.parse(startedAt) + durationMin * 60_000).toISOString(),
  durationMin, finalStatus: 'resolved', impact: 'minor',
})
const derived = (resource = RESOURCE, startedAt = ANCHOR, day = '2026-08-04', durationMin = 20_000): MonthlyIncidentEntry => ({
  id: `bs-hist:r-1:${day}`, title: `${resource} — recovered`, startedAt,
  resolvedAt: new Date(Date.parse(startedAt) + durationMin * 60_000).toISOString(),
  durationMin, finalStatus: 'resolved', impact: 'minor', derived: 'status_history', derivedDay: day,
})

/** An archive service whose stored figures are, by construction, what the real functions produce. */
/** A second feed row on an unrelated day, so `countedCount` is 2. */
const OTHER_DAY_FEED = feed(`${RESOURCE} — down`, '2026-08-20T12:00:00.000Z', 10)

/** The fields a real archive service carries BESIDE the nine this patch computes. The fixture had none
 *  of them, so a mutation replacing the whole service object with just the planned writes passed every
 *  test — the preservation check was looking one level out, at siblings and top-level keys. */
const NEIGHBOUR_FIELDS = {
  uptime: 100, uptimeSource: 'platform_avg', score: 75, grade: 'good', scoreConfidence: 'high',
  avgLatencyMs: 216, p95LatencyMs: 300, latencySpikes: 208, p50LatencyMs: 185, cvCombined: 0.542,
}

const archiveWith = (entries: MonthlyIncidentEntry[], extra: Record<string, unknown> = {}) => {
  const svc: Record<string, unknown> = {
    incidentList: entries, officialUptime: 99.44, ...NEIGHBOUR_FIELDS, ...extra,
  }
  const real = figuresFrom('together', svc, entries, WINDOW)
  return { services: { together: { ...svc, ...real } } }
}

// THE test this file exists for. Everything else builds its "stored" figures by calling `figuresFrom`,
// so a drift in that function shifts both sides of the reproduction gate and cancels out — four
// mutations survived the rest of this suite (probe-id keying, ASSUMED_VALID_DAYS, the uptime argument,
// and the `incidents` source). `figuresFrom` transcribes six decisions out of `buildMonthlyArchive`'s
// per-service block; only the real builder can adjudicate that transcription.
describe('#1295 — figuresFrom reproduces what the BUILDER writes', () => {
  const day = (d: string) => `2026-08-${d}`
  const entry = (id: string, startedAt: string, durationMin: number, extra: Partial<MonthlyIncidentEntry> = {}): MonthlyIncidentEntry => ({
    id, title: `${id} outage`, startedAt,
    resolvedAt: new Date(Date.parse(startedAt) + durationMin * 60_000).toISOString(),
    durationMin, finalStatus: 'resolved', impact: 'minor', ...extra,
  })

  it('matches the archive the real builder produces, for a probed service and an INHERITING one', async () => {
    // `claudecode` inherits `claude`'s probe (#883) — the case that made keying the summary by service
    // id instead of probe id shift `codex` by 4 points and `claudecode` by 1.
    const period = '2026-08'
    const incidents = {
      lastUpdated: '2026-08-31T00:00:00.000Z',
      services: {
        // 91/3 = 30.33 → round 30, ceil 31, floor 30: kills `ceil`. `claudecode` below carries
        // 92/3 = 30.67 → round 31, floor 30, ceil 31: kills `floor`. One fraction pins only one
        // direction, and a `.5` fixture pins neither — the earlier 91/2 left both open.
        claude: { count: 3, totalMinutes: 91, longestMinutes: 61, dates: [day('04'), day('05')],
          incidentIds: ['c1', 'c2', 'c3'], durations: { c1: 61, c2: 20, c3: 10 },
          incidents: [
            entry('c1', '2026-08-04T10:00:00.000Z', 61),
            entry('c2', '2026-08-05T10:00:00.000Z', 20),
            entry('c3', '2026-08-09T10:00:00.000Z', 10),
          ] },
        // A derived row makes `countedCount` (1) differ from the list length (2) — without it,
        // sourcing `incidents` from `countedCount` is an equivalent mutation.
        claudecode: { count: 4, totalMinutes: 122, longestMinutes: 42, dates: [day('06'), day('07')],
          incidentIds: ['cc1', 'cc2', 'cc3', 'bs-hist:r:2026-08-07'],
          durations: { cc1: 42, cc2: 30, cc3: 20, 'bs-hist:r:2026-08-07': 30 },
          incidents: [
            entry('cc1', '2026-08-06T10:00:00.000Z', 42),
            entry('cc2', '2026-08-11T10:00:00.000Z', 30),
            entry('cc3', '2026-08-13T10:00:00.000Z', 20),
            entry('bs-hist:r:2026-08-07', '2026-08-07T19:00:00.000Z', 30,
              { title: 'r — recovered', derived: 'status_history', derivedDay: '2026-08-07' }),
          ] },
      },
    }
    // Real KV shapes, not invented ones: `history:` is `{ ok, total, officialUptime }` and
    // `probe:daily:` is `{ p50, p75, p95, min, max, count, spikes }`. A first version used `up:` and a
    // `cv:` field, which produced `p50LatencyMs: null` / `officialUptime: null` / `monthlyScore: null` —
    // every mutant below survived against it, because the axes they move were not populated at all.
    const store: Record<string, string> = {
      [`incidents:monthly:${period}`]: JSON.stringify(incidents),
    }
    for (let d = 1; d <= 31; d++) {
      const dd = String(d).padStart(2, '0')
      store[`history:2026-08-${dd}`] = JSON.stringify({
        claude: { ok: 286, total: 288, officialUptime: 99.2 },
        claudecode: { ok: 287, total: 288, officialUptime: 99.5 },
      })
      store[`probe:daily:2026-08-${dd}`] = JSON.stringify({
        claude: { p50: 100, p75: 120, p95: 200, min: 80, max: 260, count: 288, spikes: 0 },
      })
    }
    const kv = { get: async (k: string) => store[k] ?? null, put: async () => {} } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(kv, 2026, 8, [
      { id: 'claude', aiwatchScore: 85, scoreGrade: 'excellent' as const, scoreConfidence: 'high' as const },
      { id: 'claudecode', aiwatchScore: 80, scoreGrade: 'good' as const, scoreConfidence: 'high' as const },
    ])
    // Non-vacuous on the axes the mutants move: a null here means the fixture never populated them.
    for (const id of ['claude', 'claudecode']) {
      const s = archive.services[id] as unknown as Record<string, unknown>
      expect(s.p50LatencyMs, `${id}: no probe summary — the probe axis is untested`).not.toBeNull()
      expect(s.officialUptime, `${id}: no official uptime — the uptime axis is untested`).not.toBeNull()
      expect(s.monthlyScore, `${id}: no monthly score — the score axis is untested`).not.toBeNull()
    }

    let compared = 0
    for (const [id, svc] of Object.entries(archive.services)) {
      const rec = svc as unknown as Record<string, unknown>
      const list = rec.incidentList as MonthlyIncidentEntry[] | undefined
      if (!list || list.length === 0) continue
      compared++
      expect(figureDiff(storedFigures(rec), figuresFrom(id, rec, list, WINDOW)),
        `${id}: figuresFrom disagrees with buildMonthlyArchive`).toEqual([])
    }
    // Non-vacuous: the loop must actually have compared both services.
    expect(compared).toBe(2)
  })
})

// The operator procedure. It lives in this module rather than the CLI precisely so these can exist:
// `scripts/` has no root tsconfig to type-check it and `test:scripts` globs `*.test.mjs`, so a `.ts`
// script there is covered by nothing — and every #1295 round found a defect in an operator procedure
// that sat uncovered.
describe('#1295 — the operator procedure', () => {
  const CMDS = applyCommands('archive:monthly:2026-08', '/out/a.patched.json', '/out/a-before.json')

  it('sets NO --ttl — this key is permanent', () => {
    // The single most destructive latent error here: a `--ttl` copy-pasted from the accumulator prune
    // would put a deletion date on the only durable copy of the month. `buildMonthlyArchive` writes
    // this key with no expiry.
    expect(CMDS.some((c) => c.includes('--ttl'))).toBe(false)
    expect(CMDS.some((c) => c.includes('--expiration-ttl'))).toBe(false)
  })

  it('writes the FILE, not the filename, and names the namespace and config in the command', () => {
    // `wrangler kv key put <key> [value]` takes a positional value, so dropping `--path` succeeds and
    // writes the path string into the key.
    expect(CMDS[2]).toMatch(/kv key put archive:monthly:2026-08 --path \/out\/a\.patched\.json /)
    expect(CMDS[2]).toContain(`--namespace-id ${NAMESPACE_ID}`)
    expect(CMDS[2]).toContain('--config worker/wrangler.toml')
  })

  it('targets the remote store on every wrangler command', () => {
    const kv = CMDS.filter((c) => c.includes('npx wrangler'))
    expect(kv).toHaveLength(3)
    for (const c of kv) expect(c).toContain('--remote')
  })

  it('verifies against the patched document, not the backup', () => {
    expect(CMDS[3]).toContain('diff - /out/a.patched.json')
    expect(CMDS[0]).toContain('> /out/a-before.json')
  })

  it('pins NAMESPACE_ID in its declared form', () => {
    // Substring matching passed on a truncated and even an empty id in the sibling script (#1295 r5).
    const toml = readFileSync(join(__dirname, '../../wrangler.toml'), 'utf-8')
    expect(toml).toContain(`id = "${NAMESPACE_ID}"`)
  })

  it('scores over the calendar month, half-open', () => {
    // A slip here shifts the window `computeMonthlyScore` scores over, straight into a permanent key.
    expect(monthWindow('2026-08')).toEqual({
      startISO: '2026-08-01T00:00:00.000Z', endISO: '2026-09-01T00:00:00.000Z',
    })
    expect(monthWindow('2026-12')).toEqual({
      startISO: '2026-12-01T00:00:00.000Z', endISO: '2027-01-01T00:00:00.000Z',
    })
  })
})

describe('#1295 — resourceOfDerivedEntry', () => {
  it('reads the resource off a synthesized title and nothing else', () => {
    expect(resourceOfDerivedEntry(derived())).toBe(RESOURCE)
    expect(resourceOfDerivedEntry(feed(`${RESOURCE} — down`, ANCHOR))).toBeNull()
    // Anchored at the END: a title that merely CONTAINS the suffix is not a synthesized row, and an
    // unanchored match would hand the guard a resource name the synthesizer never wrote.
    expect(resourceOfDerivedEntry({ title: 'api — recovered after maintenance' })).toBeNull()
  })
})

describe('#1295 — the reproduction gate', () => {
  it('plans the correction when the stored figures reproduce', () => {
    const arch = archiveWith([feed(`${RESOURCE} — down`, CROSS_DAY_FEED), derived()])
    const { changes, refusals } = planArchivePatch(arch, WINDOW)
    expect(refusals).toEqual([])
    expect(changes).toHaveLength(1)
    expect(changes[0].removed).toEqual(['bs-hist:r-1:2026-08-04'])
    expect(changes[0].after.incidents).toBe(1)
  })

  it('REFUSES a service whose stored figures do not reproduce, and plans nothing for it', () => {
    // The one guard against patching an archive built by a code path this no longer matches. Without
    // it, a drifted service would be silently rewritten with figures nobody can account for.
    const arch = archiveWith([feed(`${RESOURCE} — down`, CROSS_DAY_FEED), derived()])
    arch.services.together.totalDowntimeMin = 99999
    const { changes, refusals } = planArchivePatch(arch, WINDOW)
    expect(changes).toEqual([])
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toMatch(/do not reproduce/)
    expect(refusals[0]).toMatch(/totalDowntimeMin/)
  })

  it('refuses on a drifted monthlyScore too, not just the downtime sums', () => {
    const arch = archiveWith([feed(`${RESOURCE} — down`, CROSS_DAY_FEED), derived()])
    const stored = storedFigures(arch.services.together)
    arch.services.together.monthlyScore = (stored.monthlyScore ?? 0) + 1
    const { refusals } = planArchivePatch(arch, WINDOW)
    expect(refusals[0]).toMatch(/monthlyScore/)
  })
})

describe('#1295 — what it leaves alone', () => {
  it('plans nothing when no synthesized row collides with a feed row', () => {
    const arch = archiveWith([feed(`${RESOURCE} — down`, '2026-08-01T03:00:00.000Z'), derived()])
    expect(planArchivePatch(arch, WINDOW).changes).toEqual([])
  })

  it('plans nothing for a service with no incident list at all', () => {
    expect(planArchivePatch({ services: { quiet: { incidentList: [] } } }, WINDOW).changes).toEqual([])
  })

  it('does not remove a NON-derived row whatever else is banked', () => {
    const rss = feed(`${RESOURCE} — recovered`, '2026-08-04T15:00:00.000Z')
    const arch = archiveWith([feed(`${RESOURCE} — down`, CROSS_DAY_FEED), rss])
    expect(planArchivePatch(arch, WINDOW).changes).toEqual([])
  })
})

describe('#1295 — applyArchivePatch', () => {
  it('rewrites every field the plan moved, and the list', () => {
    const arch = archiveWith([feed(`${RESOURCE} — down`, CROSS_DAY_FEED), OTHER_DAY_FEED, derived()])
    const { changes } = planArchivePatch(arch, WINDOW)
    const out = applyArchivePatch(arch, changes).services!.together
    expect((out.incidentList as MonthlyIncidentEntry[]).map((e) => e.id))
      .toEqual([`#rss-${RESOURCE} — down-${CROSS_DAY_FEED}`, OTHER_DAY_FEED.id])
    // EVERY field the plan computed, not only the ones that happened to move.
    expect(storedFigures(out)).toEqual(changes[0].after)
    // The written document must itself reproduce — otherwise the patch publishes figures that its own
    // gate would refuse on the next run.
    expect(figureDiff(storedFigures(out), figuresFrom('together', out, out.incidentList as MonthlyIncidentEntry[], WINDOW)))
      .toEqual([])
  })

  it('writes the GRADE when the score crosses a band', () => {
    // The grade is written from the same `computeMonthlyScore` result as the score, on the next line —
    // but a fixture whose score moves within one band leaves that write unpinned (86→87 both `good`).
    // Measured: 1 pair moves 87→88, 4 pairs 83→86, and 12 pairs 74→80 — the first that crosses.
    const pairs = ['04', '06', '08', '10', '12', '14', '16', '18', '20', '22', '24', '26'].flatMap((dd) => {
      const anchor = `2026-08-${dd}T19:00:00.000Z`
      return [
        feed(`${RESOURCE} — down`, `2026-08-${String(Number(dd) + 1).padStart(2, '0')}T02:00:00.000Z`),
        derived(RESOURCE, anchor, `2026-08-${dd}`),
      ]
    })
    const arch = archiveWith(pairs)
    const { changes } = planArchivePatch(arch, WINDOW)
    expect(changes).toHaveLength(1)
    expect(changes[0].before.monthlyGrade).not.toBe(changes[0].after.monthlyGrade)
    const out = applyArchivePatch(arch, changes).services!.together
    expect(storedFigures(out)).toEqual(changes[0].after)
  })

  it('preserves everything outside the service it changes', () => {
    // The emitted document is applied with `kv key put --path` — a WHOLE-VALUE overwrite of a
    // TTL-less key whose only other copy (`incidents:monthly:*`) expires at 60d. Deleting the other
    // services, or the top-level `narrative` the reports site reads as its draft, survived every other
    // test in this file: what gets destroyed is a value that still parses (#1256).
    const arch = archiveWith([feed(`${RESOURCE} — down`, CROSS_DAY_FEED), derived()]) as Record<string, unknown>
    const untouched = { incidents: 3, totalDowntimeMin: 42, monthlyScore: 88 }
    ;(arch.services as Record<string, unknown>).openai = { ...untouched }
    arch.narrative = 'operator-reviewed draft'
    arch.period = '2026-08'

    const kept = (((arch.services as Record<string, Record<string, unknown>>).together
      .incidentList) as MonthlyIncidentEntry[]).filter((e) => e.derived !== 'status_history')
      .map((e) => ({ ...e }))
    const { changes } = planArchivePatch(arch as PatchableArchive, WINDOW)
    expect(changes.map((c) => c.id)).toEqual(['together'])
    const out = applyArchivePatch(arch as PatchableArchive, changes) as Record<string, unknown>
    expect((out.services as Record<string, unknown>).openai).toEqual(untouched)
    // ...and inside the service it DOES rewrite. Every field the reports site renders beside the
    // computed nine lives here, and a whole-value `kv key put` would drop them silently.
    const patched = (out.services as Record<string, Record<string, unknown>>).together
    for (const [k, v] of Object.entries(NEIGHBOUR_FIELDS)) expect(patched[k], k).toEqual(v)
    expect(patched.officialUptime).toBe(99.44)
    // ...and one level further in: every field of the ENTRIES that survive. The shipped line is a
    // `filter`, which keeps the objects whole, but a refactor to `.map()` projecting a few fields
    // would drop `finalStatus` / `impact` / `autoMonitor` / `derived` / `derivedDay` — flags
    // `MonthlyIncidentEntry` documents as un-re-derivable after a round-trip — while every figure
    // still matched. Verified by mutation.
    expect(patched.incidentList).toEqual(kept)
    expect(out.narrative).toBe('operator-reviewed draft')
    expect(out.period).toBe('2026-08')
  })

  it('is idempotent — a patched archive plans no further change', () => {
    const arch = archiveWith([feed(`${RESOURCE} — down`, CROSS_DAY_FEED), derived()])
    const { changes } = planArchivePatch(arch, WINDOW)
    const patched = applyArchivePatch(arch, changes)
    const again = planArchivePatch(patched, WINDOW)
    expect(again.changes).toEqual([])
    // `refusals` too: a patched service has no collision left, so it exits before the gate — a document
    // its own gate would reject is otherwise indistinguishable from an idempotent one here.
    expect(again.refusals).toEqual([])
  })
})
