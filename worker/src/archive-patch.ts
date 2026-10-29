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
import { aggregateIncidentDurations, archiveFollowThrough, averageResolutionMin, computeMonthlyScore, parseDurationMin, summarizeSecurityAlerts } from './monthly-archive'
import type { DegradationEvent, DegradationFollowThrough, MonthlyIncidentEntry, MonthlySecurityEntry, MonthlySecuritySummary } from './monthly-archive'
import { isPubliclyVerifiedAlert, STALE_PUBLICATION_MS } from './security-monitor'
import { derivedDayAlreadyBankedFromFeed } from './monthly-archive'
import { resolveProbeId } from './probe'
import { SERVICES } from './services'
import { isSuppressedByIdTitle, type SuppressionEntry } from './suppression'
export { normalizeSuppressionsCounted, SUPPRESSIONS_KEY } from './suppression'
import type { Incident, ProbeSummary } from './types'
import type { AIWatchScore } from './score'
import { formatDuration } from './utils'

/** STATUS_CACHE (worker/wrangler.toml). Pinned against the toml by the test beside this file. */
export const NAMESPACE_ID = 'e49508d80bb144e9a7ff872f2be771a4'

export { monthWindow } from './monthly-archive'

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

/** #1779 — `figuresFrom` also returns the breakdown, which the reproduction gate does not compare. */
export type PatchedFigures = ArchiveServiceFigures & { monthlyScoreBreakdown: AIWatchScore['breakdown'] }

export interface ArchivePatchChange {
  id: string
  removed: string[]
  /** #1731 — stored figures that did not reproduce, accepted by name for this service. */
  acceptedDrift?: string[]
  before: ArchiveServiceFigures
  after: PatchedFigures
  keptList: MonthlyIncidentEntry[]
}

/** The minimal archive shape this reads. Anything else in the document is preserved verbatim. */
export interface PatchableArchive {
  services?: Record<string, Record<string, unknown>>
  period?: string
  degradation?: { events?: DegradationEvent[]; followThrough?: DegradationFollowThrough[] } | null
}

/** `validDays` is the one `ProbeSummary` field the archive does not store. It gates the short-history
 *  penalty, which cannot apply to a completed month, and the reproduction gate proves the choice: on
 *  the real 2026-08 archive every scored service reproduces with this value. A month that does NOT
 *  reproduce is refused, so a future archive where this mattered could not be patched silently. */
const ASSUMED_VALID_DAYS = 30

/** The resource a synthesized row names, from the title `parseBetterStackDowntimeIncidents` writes. */
export function resourceOfDerivedEntry(entry: { title?: string }): string | null {
  const m = /^(.*) — (?:recovered|downtime|down)$/.exec(entry.title ?? '')
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

/** Every figure this patch writes, computed by the archive's own functions from a given entry list. */
export function figuresFrom(
  id: string,
  svc: Record<string, unknown>,
  list: MonthlyIncidentEntry[],
  window: { startISO: string; endISO: string },
): PatchedFigures {
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
    countedIncidents: agg.countedCount ?? list.length,
    monthlyScore: m.score,
    monthlyGrade: m.grade,
    monthlyScoreConfidence: m.confidence,
    monthlyScoreBreakdown: m.breakdown,
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
    svc.monthlyScoreBreakdown = c.after.monthlyScoreBreakdown
  }
  const followThrough = archiveFollowThrough(archive)
  if (followThrough) archive.degradation!.followThrough = followThrough
  return archive
}

/** #1664 — the provider's own record of one event: what a correction adds. Duration and status are derived. */
export interface ProviderEvent {
  id: string
  title: string
  startedAt: string
  resolvedAt: string
  impact: MonthlyIncidentEntry['impact']
}

/** #1664 — one service's archived rows replaced with the provider's own record of the same event. */
export interface RowReplacement {
  period: string
  service: string
  source: string
  remove: string[]
  add: ProviderEvent[]
}

export const ROW_REPLACEMENTS: Record<string, RowReplacement> = {
  '2026-09-azureopenai': {
    period: '2026-09',
    service: 'azureopenai',
    source: 'https://azure.status.microsoft/en-us/status/history/ — Tracking ID 7QL5-Z50, "Between 10:03 UTC and 15:58 UTC on 29 September 2026", Sweden Central',
    remove: [
      'azure-openai-and-foundry-agent-service-intermittent-request-failures-and-increased-latency',
      'intermittent-request-failures-and-increased-latency-across-azure-openai-azure-ai-foundry-and-cognitive-services',
      'observing-improvements-intermittent-request-failures-and-increased-latency-across-azure-openai-azure-ai-foundry-and-cognitive-services',
    ],
    add: [{
      id: 'azure-7QL5-Z50',
      title: 'Intermittent request failures and increased latency across Azure OpenAI, Azure AI Foundry, and Cognitive Services',
      startedAt: '2026-09-29T10:03:00.000Z',
      resolvedAt: '2026-09-29T15:58:00.000Z',
      impact: 'major',
    }],
  },
  '2026-09-chatgpt': {
    period: '2026-09',
    service: 'chatgpt',
    source: 'https://status.openai.com/incidents/01M3R1T4FCR1337FBBYY9K2RPB — resolved 2026-10-01T23:44:57Z (#1797)',
    remove: ['01M3R1T4FCR1337FBBYY9K2RPB'],
    add: [{
      id: '01M3R1T4FCR1337FBBYY9K2RPB',
      title: 'Elevated errors in ChatGPT Space Pages',
      startedAt: '2026-09-30T02:20:32.108Z',
      resolvedAt: '2026-10-01T23:44:57.067Z',
      impact: 'minor',
    }],
  },
  '2026-09-fal': {
    period: '2026-09',
    service: 'fal',
    source: 'https://status.fal.ai — notices cmtn4hy2u0d4r1mqj4tgiir1w and cmumesz6f02sk0wmobbyr9i01, dropped by the parser until #1830',
    remove: [],
    add: [{
      id: 'cmtn4hy2u0d4r1mqj4tgiir1w',
      title: 'fal.run is unreachable for synchronous requests',
      startedAt: '2026-09-04T13:58:00.000Z',
      resolvedAt: '2026-09-04T14:28:00.000Z',
      impact: 'major',
    }, {
      id: 'cmumesz6f02sk0wmobbyr9i01',
      title: 'Investigating slowness and reduced traffic',
      startedAt: '2026-09-29T08:23:20.404Z',
      resolvedAt: '2026-09-29T08:41:50.684Z',
      impact: 'minor',
    }],
  },
  '2026-08-openai': {
    period: '2026-08',
    service: 'openai',
    source: 'https://status.openai.com/incidents/01M1CYZDD84XD0H56XNEV2PT98 — resolved 2026-09-01T19:05:46Z (#1797)',
    remove: ['01M1CYZDD84XD0H56XNEV2PT98'],
    add: [{
      id: '01M1CYZDD84XD0H56XNEV2PT98',
      title: 'Elevated latency in the Responses API',
      startedAt: '2026-08-31T22:27:56.967Z',
      resolvedAt: '2026-09-01T19:05:46.393Z',
      impact: 'minor',
    }],
  },
}

const isCanonicalUtc = (s: string) => {
  const t = Date.parse(s)
  return Number.isFinite(t) && new Date(t).toISOString() === s
}

/**
 * Plan a row replacement. Pure, and behind the same reproduction gate as `planArchivePatch`: the
 * service's stored figures must come back identical from its stored list, or it is refused. Every id in
 * `remove` must be present, and no resulting id may repeat. An added event must be canonical UTC, end
 * after it starts, and start inside the month.
 */
export function planRowReplacement(
  archive: PatchableArchive,
  window: { startISO: string; endISO: string },
  spec: RowReplacement,
): { changes: ArchivePatchChange[]; refusals: string[] } {
  const refuse = (why: string) => ({ changes: [], refusals: [`${spec.service}: ${why}`] })
  const lo = Date.parse(window.startISO)
  const hi = Date.parse(window.endISO)
  for (const e of spec.add) {
    if (!isCanonicalUtc(e.startedAt) || !isCanonicalUtc(e.resolvedAt)) return refuse(`${e.id} timestamps are not canonical UTC`)
    const start = Date.parse(e.startedAt)
    if (Date.parse(e.resolvedAt) <= start) return refuse(`${e.id} does not end after it starts`)
    if (start < lo || start >= hi) return refuse(`${e.id} starts outside ${window.startISO.slice(0, 7)}`)
  }

  const svc = archive.services?.[spec.service]
  const list = svc?.incidentList ?? (svc?.incidents === 0 ? [] : undefined)
  if (!svc || !Array.isArray(list)) return refuse('no incident list in the archive')
  const entries = list as MonthlyIncidentEntry[]

  const present = new Set(entries.map((e) => e.id))
  const missing = spec.remove.filter((id) => !present.has(id))
  if (missing.length) return refuse(`rows to remove are not in the archive — ${missing.join(', ')}`)

  const drift = figureDiff(storedFigures(svc), figuresFrom(spec.service, svc, entries, window))
  if (drift.length) return refuse(`stored figures do not reproduce from the stored list — ${drift.join(', ')}`)

  const drop = new Set(spec.remove)
  const next = entries.filter((e) => !drop.has(e.id))
  for (const e of spec.add) {
    if (next.some((k) => k.id === e.id)) return refuse(`added id collides with another row — ${e.id}`)
    next.push({
      ...e,
      durationMin: parseDurationMin(formatDuration(new Date(e.startedAt), new Date(e.resolvedAt))),
      finalStatus: 'resolved',
    })
  }
  return {
    changes: [{
      id: spec.service,
      removed: [...drop],
      before: storedFigures(svc),
      after: figuresFrom(spec.service, svc, next, window),
      keptList: next,
    }],
    refusals: [],
  }
}

/**
 * #1735 — drop every stored row the current suppression list hides, behind the same reproduction gate as
 * `planArchivePatch`. Only services that lose a row change; every other byte of the archive is kept.
 */
export function planSuppressionPatch(
  archive: PatchableArchive,
  window: { startISO: string; endISO: string },
  suppressions: SuppressionEntry[],
  acceptDrift: ReadonlySet<string> = new Set(),
): { changes: ArchivePatchChange[]; refusals: string[] } {
  const changes: ArchivePatchChange[] = []
  const refusals: string[] = []
  const usedAccept = new Set<string>()
  for (const [id, svc] of Object.entries(archive.services ?? {})) {
    const list = svc.incidentList
    if (!Array.isArray(list) || list.length === 0) continue
    const entries = list as MonthlyIncidentEntry[]
    const drop = new Set(entries.filter((e) => isSuppressedByIdTitle(e.id, e.title, id, suppressions)).map((e) => e.id))
    if (drop.size === 0) continue

    const stored = storedFigures(svc)
    const drift = figureDiff(stored, figuresFrom(id, svc, entries, window))
    if (drift.length > 0 && !acceptDrift.has(id)) {
      refusals.push(`${id}: stored figures do not reproduce from the stored list — ${drift.join(', ')}`)
      continue
    }
    const kept = entries.filter((e) => !drop.has(e.id))
    const change: ArchivePatchChange = { id, removed: [...drop], before: stored, after: figuresFrom(id, svc, kept, window), keptList: kept }
    if (drift.length > 0) {
      change.acceptedDrift = drift
      usedAccept.add(id)
    }
    changes.push(change)
  }
  for (const id of acceptDrift) {
    if (!usedAccept.has(id)) refusals.push(`${id}: named to accept drift, but it has no suppressed row with non-reproducing figures`)
  }
  return { changes, refusals }
}

/** #1793 — the only figures `planRecompute` may move: the ones a later counting rule changed. */
const RECOMPUTABLE_FIGURES: readonly (keyof ArchiveServiceFigures)[] = ['avgResolutionMin', 'countedIncidents']

/**
 * #1793 — recompute named services' figures from their unchanged stored list. Refused when a named
 * service has nothing to recompute, or when anything outside `RECOMPUTABLE_FIGURES` would move. The
 * stored `monthlyScoreBreakdown` is carried through as it is.
 */
export function planRecompute(
  archive: PatchableArchive,
  window: { startISO: string; endISO: string },
  ids: readonly string[],
): { changes: ArchivePatchChange[]; refusals: string[] } {
  const changes: ArchivePatchChange[] = []
  const refusals: string[] = []
  for (const id of ids) {
    const svc = archive.services?.[id]
    const list = svc?.incidentList
    if (!svc || !Array.isArray(list) || list.length === 0) {
      refusals.push(`${id}: no incident list in the archive`)
      continue
    }
    const entries = list as MonthlyIncidentEntry[]
    if (svc.incidents !== entries.length) {
      refusals.push(`${id}: incidentList ${entries.length} != incidents ${String(svc.incidents)} — the stored figures did not come from this list`)
      continue
    }
    const before = storedFigures(svc)
    const after = { ...figuresFrom(id, svc, entries, window), monthlyScoreBreakdown: svc.monthlyScoreBreakdown as PatchedFigures['monthlyScoreBreakdown'] }
    const moved = (Object.keys(before) as (keyof ArchiveServiceFigures)[]).filter((k) => before[k] !== after[k])
    if (moved.length === 0) {
      refusals.push(`${id}: stored figures already reproduce — nothing to recompute`)
      continue
    }
    const outside = moved.filter((k) => !RECOMPUTABLE_FIGURES.includes(k))
    if (outside.length > 0) {
      refusals.push(`${id}: recomputing would also move ${figureDiff(before, after).filter((d) => outside.some((k) => d.startsWith(`${k} `))).join(', ')}`)
      continue
    }
    changes.push({ id, removed: [], before, after, keptList: entries })
  }
  return { changes, refusals }
}

/**
 * aiwatch-reports#161 — each service's `totalDowntimeMin` and `avgResolutionMin` recounted from its stored
 * `incidentList` with today's `aggregateIncidentDurations` and today's suppression list, so a report can
 * compare a month archived before #1505 with one archived after it. null where the list is shorter than
 * the month's incident count: the stored figures then came from the accumulator's pre-summed total, which
 * cannot be recounted.
 */
export function recountDowntime(
  archive: PatchableArchive,
  suppressions: SuppressionEntry[],
): Record<string, { downtime: number | null; mttr: number | null }> {
  const out: Record<string, { downtime: number | null; mttr: number | null }> = {}
  for (const [id, svc] of Object.entries(archive.services ?? {})) {
    const list = Array.isArray(svc.incidentList) ? (svc.incidentList as MonthlyIncidentEntry[]) : []
    const count = typeof svc.incidents === 'number' ? svc.incidents : 0
    if (list.length < count) {
      out[id] = { downtime: null, mttr: null }
      continue
    }
    const kept = list.filter((e) => !isSuppressedByIdTitle(e.id, e.title ?? '', id, suppressions))
    const agg = aggregateIncidentDurations(kept, kept.length, 0, 0)
    out[id] = { downtime: agg.totalMin, mttr: averageResolutionMin(agg.countedTotalMin, agg.countedCount ?? 0) }
  }
  return out
}

/** #1805 — security alerts removed from a stored month because they were first published long before
 *  the month detected them (a re-modified record read as new). `publishedAt` is the advisory's own date. */
export interface SecurityRemoval {
  period: string
  source: string
  remove: Array<{ url: string; publishedAt: string }>
}

export const SECURITY_REMOVALS: Record<string, SecurityRemoval> = {
  '2026-09-republished': {
    period: '2026-09',
    source: 'osv.dev `database_specific.github_reviewed_at` (else `published`), or NVD `published` where OSV has no record — read 2026-10-27 (#1805)',
    remove: [
      { url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-9856', publishedAt: '2026-08-02T15:10:53.809Z' },
      { url: 'https://github.com/anthropics/anthropic-sdk-python/security/advisories/GHSA-q5f5-3gjm-7mfm', publishedAt: '2026-04-01T21:15:30Z' },
      { url: 'https://github.com/anthropics/anthropic-sdk-python/security/advisories/GHSA-w828-4qhx-vxx3', publishedAt: '2026-04-01T21:17:34Z' },
      { url: 'https://github.com/langchain-ai/langsmith-sdk/security/advisories/GHSA-3644-q5cj-c5c7', publishedAt: '2026-05-13T15:29:30Z' },
      { url: 'https://github.com/langchain-ai/langchain/security/advisories/GHSA-gr75-jv2w-4656', publishedAt: '2026-06-16T15:03:14Z' },
      { url: 'https://nvd.nist.gov/vuln/detail/CVE-2025-6984', publishedAt: '2025-09-04T10:42:33.990Z' },
      { url: 'https://github.com/langchain-ai/langchain/security/advisories/GHSA-2g6r-c272-w58r', publishedAt: '2026-02-11T14:23:13Z' },
      { url: 'https://github.com/langchain-ai/langchain/security/advisories/GHSA-6qv9-48xg-fc7f', publishedAt: '2025-11-20T17:42:12Z' },
      { url: 'https://github.com/langchain-ai/langchain/security/advisories/GHSA-926x-3r5x-gfhw', publishedAt: '2026-04-08T21:51:32Z' },
      { url: 'https://github.com/langchain-ai/langchain/security/advisories/GHSA-c67j-w6g6-q2cm', publishedAt: '2025-12-23T18:46:13Z' },
      { url: 'https://github.com/langchain-ai/langchain/security/advisories/GHSA-pjwx-r37v-7724', publishedAt: '2026-05-08T23:07:32Z' },
      { url: 'https://github.com/langchain-ai/langchain/security/advisories/GHSA-qh6h-p6c9-ff54', publishedAt: '2026-03-27T19:45:00Z' },
      { url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-4372', publishedAt: '2026-05-24T13:40:40.995Z' },
      { url: 'https://nvd.nist.gov/vuln/detail/CVE-2025-3933', publishedAt: '2025-07-11T09:22:27.103Z' },
      { url: 'https://nvd.nist.gov/vuln/detail/CVE-2025-6921', publishedAt: '2025-09-23T13:56:15.636Z' },
      { url: 'https://nvd.nist.gov/vuln/detail/CVE-2025-6638', publishedAt: '2025-09-12T10:46:07.934Z' },
      { url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-1839', publishedAt: '2026-04-07T05:22:00.959Z' },
      { url: 'https://nvd.nist.gov/vuln/detail/CVE-2025-5197', publishedAt: '2025-08-06T11:53:37.232Z' },
      { url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-5241', publishedAt: '2026-06-03T12:33:10.227Z' },
      { url: 'https://nvd.nist.gov/vuln/detail/CVE-2024-11394', publishedAt: '2024-11-22T21:23:49.302Z' },
      { url: 'https://nvd.nist.gov/vuln/detail/CVE-2025-3777', publishedAt: '2025-07-07T09:55:38.190Z' },
      { url: 'https://nvd.nist.gov/vuln/detail/CVE-2024-11392', publishedAt: '2024-11-22T21:23:27.024Z' },
      { url: 'https://nvd.nist.gov/vuln/detail/CVE-2025-6051', publishedAt: '2025-09-14T17:03:02.953Z' },
      { url: 'https://nvd.nist.gov/vuln/detail/CVE-2024-11393', publishedAt: '2024-11-22T21:23:38.476Z' },
    ],
  },
}

const canonicalJson = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonicalJson).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`
      : JSON.stringify(v)

const withoutTimelines = (s: MonthlySecuritySummary) =>
  ({ ...s, topFindings: s.topFindings.map(({ timeline: _t, ...f }) => f) })

/**
 * Plan a stored month's `security` section with `spec.remove` taken out. Pure. The stored section must
 * come back identical (timelines aside) from the stored `security:monthly` entries through the builder's
 * own gate and summary, or the run is refused; every listed url must be present, and every entry it
 * matches must have been detected more than `STALE_PUBLICATION_MS` after `publishedAt`. Timelines on the
 * remaining top findings are carried over from the stored section.
 */
export function planSecurityPatch(
  stored: MonthlySecuritySummary | null | undefined,
  accumulated: unknown,
  spec: SecurityRemoval,
): { security: MonthlySecuritySummary | null; refusals: string[] } {
  const refuse = (why: string) => ({ security: null, refusals: [`security: ${why}`] })
  if (!stored) return refuse('the archive has no security section')
  if (!Array.isArray(accumulated)) return refuse('security:monthly is not an array')
  const verified = (accumulated as MonthlySecurityEntry[]).filter(isPubliclyVerifiedAlert)
  const reproduced = withoutTimelines(summarizeSecurityAlerts(verified))
  if (stored.byServiceSource === undefined) delete reproduced.byServiceSource
  if (canonicalJson(reproduced) !== canonicalJson(withoutTimelines(stored))) {
    return refuse('the stored section does not reproduce from security:monthly')
  }
  const drop = new Set<string>()
  for (const r of spec.remove) {
    const published = Date.parse(r.publishedAt)
    const matched = verified.filter((e) => e.url === r.url)
    if (matched.length === 0) return refuse(`${r.url} is not in the month`)
    if (!Number.isFinite(published)) return refuse(`${r.url} has no parseable publishedAt`)
    for (const e of matched) {
      if (!(Date.parse(e.detectedAt) - published > STALE_PUBLICATION_MS)) {
        return refuse(`${r.url} was detected ${e.detectedAt}, within ${STALE_PUBLICATION_MS / 86400000} days of ${r.publishedAt}`)
      }
    }
    drop.add(r.url)
  }
  const kept = verified.filter((e) => !drop.has(e.url))
  if (kept.length === 0) return { security: null, refusals: [] }
  const timelines = new Map(stored.topFindings.filter((f) => f.timeline).map((f) => [f.url, f.timeline]))
  const after = summarizeSecurityAlerts(kept)
  return {
    security: { ...after, topFindings: after.topFindings.map((f) => (timelines.has(f.url) ? { ...f, timeline: timelines.get(f.url) } : f)) },
    refusals: [],
  }
}
