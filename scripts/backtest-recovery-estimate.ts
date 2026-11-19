#!/usr/bin/env -S npx tsx
/**
 * #2005 step 3 — time-ordered backtest of recovery-bound candidates against the per-service past p80.
 * Reads the step-2 training set (`build-recovery-training-set.ts --out`) and, optionally, the backed-up
 * `incident:ledger:*` files for the AI reference row. Fetches nothing and writes nothing but `--out`.
 *
 *   npx tsx scripts/backtest-recovery-estimate.ts --train <set>.json [--data ~/aiwatch-data] [--from 2026-08-01] [--out <file>.json]
 *
 * Every candidate predicts an incident from rows resolved before that incident started, the rule
 * `compareWithRecoveryBaseline` uses.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { summarizeRecoveryHistory } from '../worker/src/recovery-baseline'
import { accuracyOf } from '../worker/src/incident-history'
import type { IncidentHistoryRecord } from '../worker/src/incident-history'
import type { TrainingRow } from './build-recovery-training-set'
import { isMain } from './is-main.mjs'

export const CANDIDATES = ['pastP80', 'backoffP80', 'stageP80', 'conformalP80'] as const
export type Candidate = (typeof CANDIDATES)[number] | 'ai'

export const CONFORMAL_TARGET = 0.8
export const CONFORMAL_MIN_POOL = 30
export const BOOTSTRAP_DRAWS = 2000
const NOT_LIVE_STAGES = new Set(['resolved', 'postmortem'])

/** Pure. A first update the incident's own page posted before it resolved, at a stage that is not its end. */
export function hadLiveNotice(r: TrainingRow): boolean {
  return r.first !== null && Date.parse(r.first.at) < Date.parse(r.resolvedAt) && !NOT_LIVE_STAGES.has(r.first.stage)
}

function asRecord(r: TrainingRow): IncidentHistoryRecord {
  return { svcId: r.svc, incId: r.id, title: r.title, startedAt: r.startedAt, resolvedAt: r.resolvedAt, durationMin: r.durationMin } as IncidentHistoryRecord
}

/** Pure. Past p80 in minutes over `rows`, or null under the floor — `summarizeRecoveryHistory` itself, so the rule is not copied. */
export function p80Of(rows: TrainingRow[]): number | null {
  return summarizeRecoveryHistory(rows.map(asRecord), [])?.p80Min ?? null
}

/** Pure. Nearest-rank quantile, the rank `summarizeRecoveryHistory` uses for its p80. */
export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil(q * s.length) - 1)]
}

/** Pure. Rows resolved strictly before `startedAt`. */
export function priorTo(rows: TrainingRow[], startedAt: string): TrainingRow[] {
  const t = Date.parse(startedAt)
  return rows.filter((r) => Date.parse(r.resolvedAt) < t)
}

/**
 * Pure. Each candidate's bound (minutes) for one incident, from the prior rows only; a candidate
 * with no bound is absent. `residuals` are log(actual / pastP80) of earlier scored incidents that
 * resolved before this one started — the conformal pool.
 */
export function predict(
  target: TrainingRow,
  priorSvc: TrainingRow[],
  priorGroup: TrainingRow[],
  priorAll: TrainingRow[],
  residuals: number[],
  priorProvider: TrainingRow[] = [],
): Partial<Record<(typeof CANDIDATES)[number], number>> {
  const out: Partial<Record<(typeof CANDIDATES)[number], number>> = {}
  const past = p80Of(priorSvc)
  if (past !== null) out.pastP80 = past
  const provider = p80Of(priorProvider)
  const backoff = past ?? provider ?? p80Of(priorGroup) ?? p80Of(priorAll)
  if (backoff !== null) out.backoffP80 = backoff
  if (hadLiveNotice(target)) {
    const stage = target.first!.stage
    const sameStage = (rs: TrainingRow[]) => rs.filter((r) => hadLiveNotice(r) && r.first!.stage === stage)
    const s = p80Of(sameStage(priorSvc)) ?? backoff
    if (s !== null) out.stageP80 = s
  }
  if (past !== null && residuals.length >= CONFORMAL_MIN_POOL) {
    out.conformalP80 = past * Math.exp(quantile(residuals, CONFORMAL_TARGET))
  }
  return out
}

export interface Scored { id: string; svc: string; startedAt: string; durationMin: number; live: boolean; bounds: Partial<Record<Candidate, number>> }

/** Pure. Walk forward through the incidents starting on or after `from`, in start order. */
export function backtest(rows: TrainingRow[], from: string, ai: Map<string, number> = new Map()): Scored[] {
  const usable = rows.filter((r) => !r.timesInverted)
  const bySvc = new Map<string, TrainingRow[]>()
  const byGroup = new Map<string, TrainingRow[]>()
  const byProvider = new Map<string, TrainingRow[]>()
  for (const r of usable) {
    bySvc.set(r.svc, [...(bySvc.get(r.svc) ?? []), r])
    if (r.group) byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r])
    if (r.provider) byProvider.set(r.provider, [...(byProvider.get(r.provider) ?? []), r])
  }
  const fromMs = Date.parse(from)
  const tests = usable.filter((r) => Date.parse(r.startedAt) >= fromMs).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
  const scored: Scored[] = []
  for (const t of tests) {
    const startMs = Date.parse(t.startedAt)
    const residuals = scored
      .filter((s) => s.bounds.pastP80 !== undefined && Date.parse(s.startedAt) + s.durationMin * 60_000 < startMs)
      .map((s) => Math.log(s.durationMin / s.bounds.pastP80!))
    const bounds: Partial<Record<Candidate, number>> = predict(
      t,
      priorTo(bySvc.get(t.svc) ?? [], t.startedAt),
      t.group ? priorTo(byGroup.get(t.group) ?? [], t.startedAt) : [],
      priorTo(usable, t.startedAt),
      residuals,
      t.provider ? priorTo(byProvider.get(t.provider) ?? [], t.startedAt) : [],
    )
    const aiHours = ai.get(`${t.svc}|${t.id}`)
    if (aiHours !== undefined) bounds.ai = aiHours * 60
    scored.push({ id: t.id, svc: t.svc, startedAt: t.startedAt, durationMin: t.durationMin, live: hadLiveNotice(t), bounds })
  }
  return scored
}

export interface Metrics { n: number; coverage: number; accurate: number; over: number; medianRatio: number }

/** Pure. Scores of one candidate on the given incidents (each must carry that candidate's bound). */
export function metricsOf(items: Scored[], c: Candidate): Metrics {
  const n = items.length
  let covered = 0, accurate = 0, over = 0
  const ratios: number[] = []
  for (const s of items) {
    const bound = s.bounds[c]!
    if (s.durationMin <= bound) covered++
    const v = accuracyOf({ predictedRecoveryHours: bound / 60, durationMin: s.durationMin })
    if (v === 'accurate') accurate++
    else if (v === 'over-predicted') over++
    ratios.push(bound / s.durationMin)
  }
  return { n, coverage: covered / n, accurate: accurate / n, over: over / n, medianRatio: n ? quantile(ratios, 0.5) : NaN }
}

/** Pure. Seeded PRNG (mulberry32), so a rerun on the same file prints the same intervals. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Pure. 95% interval of metric(c) − metric(base) over the same incidents, resampling whole incident
 * ids: one provider incident carried by several services (claude / claudeai) is one draw, not several.
 */
export function pairedInterval(items: Scored[], c: Candidate, base: Candidate, key: 'coverage' | 'accurate', draws = BOOTSTRAP_DRAWS, seed = 2005, level = 0.95): [number, number] {
  const clusters = [...items.reduce((m, s) => m.set(s.id, [...(m.get(s.id) ?? []), s]), new Map<string, Scored[]>()).values()]
  const next = rng(seed)
  const diffs: number[] = []
  for (let d = 0; d < draws; d++) {
    const sample: Scored[] = []
    for (let i = 0; i < clusters.length; i++) sample.push(...clusters[Math.floor(next() * clusters.length)])
    diffs.push(metricsOf(sample, c)[key] - metricsOf(sample, base)[key])
  }
  return interval(diffs, level)
}

/** Pure. Central `level` interval of `xs`, nearest-rank. */
export function interval(xs: number[], level: number): [number, number] {
  return [quantile(xs, (1 - level) / 2), quantile(xs, (1 + level) / 2)]
}

/** Pure. First numeric AI estimate (hours) per `svc|incId` from ledger documents, made before the incident resolved. */
export function firstAiEstimates(ledgers: Array<Array<{ svcId: string; incId: string; resolvedAt: string; predictionSnapshots?: Array<{ at: string; estimateHours?: number | null }> }>>): Map<string, number> {
  const out = new Map<string, number>()
  for (const doc of ledgers) {
    for (const e of doc) {
      const first = [...(e.predictionSnapshots ?? [])]
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
        .find((s) => typeof s.estimateHours === 'number' && s.estimateHours > 0 && Date.parse(s.at) < Date.parse(e.resolvedAt))
      if (first) out.set(`${e.svcId}|${e.incId}`, first.estimateHours as number)
    }
  }
  return out
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const pp = ([lo, hi]: [number, number]) => `[${(lo * 100).toFixed(1)}, ${(hi * 100).toFixed(1)}]`

/** Pure. One table, every candidate scored on the same incidents: those of `items` where all of `cands` have a bound. */
export function report(title: string, items: Scored[], cands: Candidate[]): string {
  const base = cands[0]
  const common = items.filter((s) => cands.every((c) => s.bounds[c] !== undefined))
  const lines = [`### ${title}: where ${cands.join(', ')} all have a bound (n ${common.length}, unique incidents ${new Set(common.map((s) => s.id)).size})`, '', '| candidate | coverage | accurate | over | median bound/actual | Δcoverage 95% | Δaccurate 95% |', '|---|---|---|---|---|---|---|']
  if (!common.length) return lines.join('\n')
  for (const c of cands) {
    const m = metricsOf(common, c)
    const diff = c === base ? ['—', '—'] : (['coverage', 'accurate'] as const).map((k) => pp(pairedInterval(common, c, base, k)))
    lines.push(`| ${c} | ${pct(m.coverage)} | ${pct(m.accurate)} | ${pct(m.over)} | ${m.medianRatio.toFixed(2)} | ${diff.join(' | ')} |`)
  }
  return lines.join('\n')
}

function main(argv: string[]): void {
  const opt = (name: string) => {
    const i = argv.indexOf(name)
    return i < 0 ? undefined : argv[i + 1]
  }
  const train = opt('--train')
  if (!train) throw new Error('missing --train')
  const from = opt('--from') ?? '2026-08-01'
  const data = opt('--data')
  const rows = JSON.parse(readFileSync(train, 'utf8')) as TrainingRow[]
  let ai = new Map<string, number>()
  if (data) {
    const kv = join(data, 'kv')
    ai = firstAiEstimates(readdirSync(kv).filter((f) => f.startsWith('incident%3Aledger%3A')).map((f) => JSON.parse(readFileSync(join(kv, f), 'utf8'))))
  }
  const scored = backtest(rows, from, ai)
  const filled = (c: Candidate) => scored.filter((s) => s.bounds[c] !== undefined).length
  const out = [
    `rows ${rows.length}; scored from ${from}: ${scored.length} (unique incidents ${new Set(scored.map((s) => s.id)).size}), live notice ${scored.filter((s) => s.live).length}`,
    `bound present: ${[...CANDIDATES, 'ai' as const].map((c) => `${c} ${filled(c)}`).join(', ')}`,
    '',
    report('All scored incidents', scored, ['pastP80', 'conformalP80']),
    '',
    report('All scored incidents', scored, ['pastP80', 'stageP80', 'conformalP80']),
    '',
    report('No past p80', scored.filter((s) => s.bounds.pastP80 === undefined), ['backoffP80']),
    '',
    report('All scored incidents; ai is the first numeric ledger estimate made before resolution', scored, ['pastP80', 'ai', 'conformalP80']),
  ].join('\n')
  console.log(out)
  const file = opt('--out')
  if (file) writeFileSync(file, JSON.stringify(scored))
}

if (isMain(import.meta.url)) main(process.argv.slice(2))
