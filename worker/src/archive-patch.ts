// #1295 — recompute a FROZEN monthly archive after `status_history`-derived duplicates were pruned
// from the accumulator it was built from.
//
// `archive:monthly:2026-08` was built in the 00:00-00:15 UTC window on the 1st, hours before the
// accumulation guard deployed, so it froze the duplicated rows into a permanent, TTL-less key. The
// accumulator has since been pruned; this is the same correction applied to the published copy.
//
// **Nothing here is a mirror.** Every figure is produced by the functions that built the archive —
// `aggregateIncidentDurations` for the downtime statistics and `computeMonthlyScore` for the monthly
// Score — and the collision rule is `derivedDayAlreadyBankedFromFeed`, the guard that shipped in the
// same issue. A node-side reimplementation was the first design and was abandoned: `computeMonthlyScore`
// delegates to the whole Score engine, and a mirror of it that drifts publishes a wrong score in a
// permanent record with nothing to catch it.
//
// The **reproduction gate** is what makes that safe to rely on. For each service it is about to
// change, the STORED figures are recomputed from its STORED `incidentList`; one whose numbers do not
// come back identical is refused rather than guessed at, exactly as `patch-archive-automonitor.mjs`
// (#1210) refuses a service it cannot account for. A service with no collision is never rewritten, so
// it is never reproduced either — step 2's `diff` is what shows the operator that untouched remainder.
import { aggregateIncidentDurations, computeMonthlyScore } from './monthly-archive'
import type { MonthlyIncidentEntry } from './monthly-archive'
import { derivedDayAlreadyBankedFromFeed } from './monthly-archive'
import { resolveProbeId } from './probe'
import { SERVICES } from './services'
import type { Incident, ProbeSummary } from './types'

/** STATUS_CACHE (worker/wrangler.toml). Pinned against the toml by the test beside this file. */
export const NAMESPACE_ID = 'e49508d80bb144e9a7ff872f2be771a4'

/** The calendar month as the half-open UTC window `computeMonthlyScore` scores over. */
export function monthWindow(period: string): { startISO: string; endISO: string } {
  const [y, m] = period.split('-').map(Number)
  return {
    startISO: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
    endISO: new Date(Date.UTC(y, m, 1)).toISOString(),
  }
}

/**
 * The commands the operator runs, as data so they can be pinned.
 *
 * They live HERE, not in the CLI, because every #1295 review round found a defect in an operator
 * procedure while it sat in an untested script — a `--expiration-ttl` flag wrangler
 * rejects, a backup filename shared with two sibling scripts. `scripts/` has no type-checking (no root
 * tsconfig) and `test:scripts` globs `*.test.mjs`, so a `.ts` script there is covered by nothing.
 *
 * **No `--ttl`, unlike the accumulator prune.** `archive:monthly:*` is permanent (`kv-schema.md`) and
 * `buildMonthlyArchive` writes it with no expiry; a TTL here would put a deletion date on the only
 * durable copy of the month.
 */
export function applyCommands(key: string, outPath: string, backupPath: string): string[] {
  const wrangler = `--config worker/wrangler.toml --namespace-id ${NAMESPACE_ID} --remote`
  return [
    `  1. back up:  npx wrangler kv key get ${key} ${wrangler} > ${backupPath}`,
    `  2. inspect:  diff <(python3 -m json.tool ${backupPath}) <(python3 -m json.tool ${outPath})`,
    `  3. apply:    npx wrangler kv key put ${key} --path ${outPath} ${wrangler}`,
    `  4. verify:   npx wrangler kv key get ${key} ${wrangler} | diff - ${outPath} && echo OK`,
  ]
}

/** The archive fields this patch touches. Everything else is copied through untouched. */
export interface ArchiveServiceFigures {
  incidents: number
  totalDowntimeMin: number | null
  longestIncidentMin: number | null
  avgResolutionMin: number | null
  countedIncidents: number | null
  monthlyScore: number | null
  monthlyGrade: string | null
  monthlyScoreConfidence: string | null
}

export interface ArchivePatchChange {
  id: string
  removed: string[]
  before: ArchiveServiceFigures
  after: ArchiveServiceFigures
  keptList: MonthlyIncidentEntry[]
}

/** The minimal archive shape this reads. Anything else in the document is preserved verbatim. */
export interface PatchableArchive {
  services?: Record<string, Record<string, unknown>>
}

/** `validDays` is the one `ProbeSummary` field the archive does not store. It gates the short-history
 *  penalty, which cannot apply to a completed month, and the reproduction gate proves the choice: on
 *  the real 2026-08 archive every scored service reproduces with this value. A month that does NOT
 *  reproduce is refused, so a future archive where this mattered could not be patched silently. */
const ASSUMED_VALID_DAYS = 30

/** The resource a synthesized row names, from the title `parseBetterStackDowntimeIncidents` writes. */
export function resourceOfDerivedEntry(entry: { title?: string }): string | null {
  const m = /^(.*) — recovered$/.exec(entry.title ?? '')
  return m ? m[1] : null
}

/** Adapt a stored entry to the shape the shipped guard reads. The guard takes the live `Incident`
 *  shape and keys the resource off `componentNames`, which the stored row does not carry — the title
 *  is what there is, and the same extraction the accumulator prune uses. */
function asGuardInput(entry: MonthlyIncidentEntry): Pick<Incident, 'componentNames' | 'startedAt'> | null {
  const resource = resourceOfDerivedEntry(entry)
  if (!resource) return null
  // Exactly the two fields the guard reads — no cast, so the compiler proves the adapter is complete.
  // A stored row carries no `componentNames`; the resource comes from the title the synthesizer wrote.
  return { componentNames: [resource], startedAt: entry.startedAt }
}

/** Rebuild the probe summary the Score was computed against, keyed by PROBE id — an inheriting
 *  service (#883) scores on its parent's probe, and keying by service id instead was measured to
 *  change `codex` by 4 points and `claudecode` by 1. */
function summariesFor(id: string, svc: Record<string, unknown>): Map<string, ProbeSummary> {
  const out = new Map<string, ProbeSummary>()
  const p50 = svc.p50LatencyMs
  const cv = svc.cvCombined
  if (typeof p50 === 'number' && typeof cv === 'number') {
    // `p95: p50` on purpose. The Score reads neither (`grep '\.p95\b' score.ts probe.ts` → 0), and the
    // archive's `p95LatencyMs` is a DIFFERENT statistic — `computeMonthlyLatencyStats`' unfiltered mean
    // of daily p95 keyed by the SERVICE's id, while a real `ProbeSummary.p95` is probe-keyed. Sourcing
    // it here would mix two keyings to fill a field nothing reads.
    out.set(resolveProbeId(id), { p50, p95: p50, cvCombined: cv, validDays: ASSUMED_VALID_DAYS })
  }
  return out
}

/** Every figure this patch writes, computed by the archive's own functions from a given entry list.
 *
 *  FOUR of the nine are invariant under this patch, by two different mechanisms, so dropping their
 *  writes is an equivalent mutation rather than an untested one:
 *  `longestIncidentMin` / `countedIncidents` / `avgResolutionMin` because `aggregateIncidentDurations`
 *  `continue`s on `derived === 'status_history'` BEFORE counting, and this patch removes only such rows;
 *  `monthlyScoreConfidence` because `score.ts` computes it from uptime presence and probe availability
 *  alone, neither of which reads the incident list. The first three stop being invariant if #1292's
 *  exclusions are ever revisited. */
export function figuresFrom(
  id: string,
  svc: Record<string, unknown>,
  list: MonthlyIncidentEntry[],
  window: { startISO: string; endISO: string },
): ArchiveServiceFigures {
  const agg = aggregateIncidentDurations(list, list.length, 0, 0)
  const avg = agg.countedCount != null && agg.countedCount > 0 && agg.countedTotalMin != null
    ? Math.round(agg.countedTotalMin / agg.countedCount)
    : null
  const uptime = typeof svc.officialUptime === 'number' ? svc.officialUptime : null
  const m = computeMonthlyScore(id, list, uptime, summariesFor(id, svc), window,
    SERVICES.find((s) => s.id === id))
  return {
    incidents: list.length,
    totalDowntimeMin: agg.totalMin,
    longestIncidentMin: agg.longestMin,
    avgResolutionMin: avg,
    countedIncidents: agg.countedCount,
    monthlyScore: m.score,
    monthlyGrade: m.grade,
    monthlyScoreConfidence: m.confidence,
  }
}

/** What the archive currently stores, in the same shape `figuresFrom` returns. */
export function storedFigures(svc: Record<string, unknown>): ArchiveServiceFigures {
  const num = (v: unknown) => (typeof v === 'number' ? v : null)
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  return {
    incidents: typeof svc.incidents === 'number' ? svc.incidents : 0,
    totalDowntimeMin: num(svc.totalDowntimeMin),
    longestIncidentMin: num(svc.longestIncidentMin),
    avgResolutionMin: num(svc.avgResolutionMin),
    countedIncidents: num(svc.countedIncidents),
    monthlyScore: num(svc.monthlyScore),
    monthlyGrade: str(svc.monthlyGrade),
    monthlyScoreConfidence: str(svc.monthlyScoreConfidence),
  }
}

/** The fields that differ between two figure sets, named. Empty means identical. */
export function figureDiff(a: ArchiveServiceFigures, b: ArchiveServiceFigures): string[] {
  const out: string[] = []
  for (const k of Object.keys(a) as (keyof ArchiveServiceFigures)[]) {
    if (a[k] !== b[k]) out.push(`${k} ${String(a[k])}→${String(b[k])}`)
  }
  return out
}

/**
 * Plan the correction. Pure: reads the archive, writes nothing.
 *
 * A service is REFUSED — not guessed at — when its stored figures do not reproduce from its stored
 * list. That is the only guard against patching a service whose archive was built by a code path this
 * no longer matches.
 */
export function planArchivePatch(
  archive: PatchableArchive,
  window: { startISO: string; endISO: string },
): { changes: ArchivePatchChange[]; refusals: string[] } {
  const changes: ArchivePatchChange[] = []
  const refusals: string[] = []
  for (const [id, svc] of Object.entries(archive.services ?? {})) {
    const list = svc.incidentList
    if (!Array.isArray(list) || list.length === 0) continue
    const entries = list as MonthlyIncidentEntry[]

    const dupes = entries.filter((e) => {
      if (e.derived !== 'status_history') return false
      const asIncident = asGuardInput(e)
      return asIncident != null && derivedDayAlreadyBankedFromFeed(entries, asIncident)
    })
    if (dupes.length === 0) continue

    const stored = storedFigures(svc)
    const reproduced = figuresFrom(id, svc, entries, window)
    const drift = figureDiff(stored, reproduced)
    if (drift.length > 0) {
      refusals.push(`${id}: stored figures do not reproduce from the stored list — ${drift.join(', ')}`)
      continue
    }

    const drop = new Set(dupes.map((e) => e.id))
    const kept = entries.filter((e) => !drop.has(e.id))
    changes.push({
      id,
      removed: [...drop],
      before: stored,
      after: figuresFrom(id, svc, kept, window),
      keptList: kept,
    })
  }
  return { changes, refusals }
}

/** Apply a plan to the archive document, in place. Separated so the plan is inspectable first. */
export function applyArchivePatch(archive: PatchableArchive, changes: ArchivePatchChange[]): PatchableArchive {
  for (const c of changes) {
    const svc = archive.services?.[c.id]
    if (!svc) continue
    svc.incidentList = c.keptList
    svc.incidents = c.after.incidents
    svc.totalDowntimeMin = c.after.totalDowntimeMin
    svc.longestIncidentMin = c.after.longestIncidentMin
    svc.avgResolutionMin = c.after.avgResolutionMin
    svc.countedIncidents = c.after.countedIncidents
    svc.monthlyScore = c.after.monthlyScore
    svc.monthlyGrade = c.after.monthlyGrade
    svc.monthlyScoreConfidence = c.after.monthlyScoreConfidence
  }
  return archive
}
