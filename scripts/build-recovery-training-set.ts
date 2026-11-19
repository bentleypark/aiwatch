#!/usr/bin/env -S npx tsx
/**
 * #2005 step 2 — the offline training set for the recovery-estimate backtest. Reads only files:
 * the permanent `archive:monthly:*` and `incident:duration-overrides` copies in the private
 * `aiwatch-data` repo's `kv/` (#2034), and the provider timelines pulled once into `pulls/2005/`.
 * Fetches nothing and writes nothing but `--out`.
 *
 *   npx tsx scripts/build-recovery-training-set.ts --data ~/aiwatch-data --out <file>.json
 *
 * One row per (service, incident) that `editorialRecoveryRecords` keeps, with the provider's first
 * update when a timeline joins. The pulled `n` is left out: it is the update count of the finished timeline.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { editorialRecoveryRecords } from '../worker/src/recovery-baseline'
import { SERVICES } from '../worker/src/services'
import { serviceGroupOf } from '../worker/src/service-groups'
import type { DurationOverride } from '../worker/src/overrides'
import type { ServiceConfig } from '../worker/src/types'
import { isMain } from './is-main.mjs'

export interface ArchiveRow {
  id: string
  title: string
  startedAt: string
  resolvedAt: string | null
  durationMin: number
  impact?: string | null
  autoMonitor?: boolean
  derived?: string
  startUnknown?: boolean
}

export interface FirstUpdate { at: string; stage: string; body: string; source: 'atlassian' | 'incidentio' | 'xai-compat' }

export interface TrainingRow {
  svc: string
  provider: string | null
  category: string | null
  group: string | null
  id: string
  title: string
  finalImpact: string | null
  startedAt: string
  resolvedAt: string
  durationMin: number
  derived: boolean
  startUnknown: boolean
  timesInverted: boolean
  first: (FirstUpdate & { delayMin: number }) | null
}

type JoinEntry = { kind: string; status: number | string; first?: { t: string; s: string; body: string } | null }
type IncidentIoEntry = { status: number | string; updates?: Array<{ published_at: string; to_status: string; text: string }> }
type XaiIncident = { id: string; started_at: string; incident_updates: Array<{ status: string; body: string; created_at: string }> }

export const XAI_COMPAT_SERVICES = new Set(['cursor', 'grokbot'])
export const XAI_MATCH_WINDOW_MIN = 10

function splitKey(key: string): { host: string; id: string } {
  const cut = key.lastIndexOf('|')
  return { host: key.slice(0, cut), id: key.slice(cut + 1) }
}

/** Pure. First updates by incident id: Atlassian ones from the join pull, incident.io ones from their
 *  own pull (the join pull cut incident.io's rich-text body at 300 characters). Throws when one id is
 *  keyed under two hosts, since the lookup is by id. */
export function indexFirstUpdates(join: Record<string, JoinEntry>, incidentIo: Record<string, IncidentIoEntry>): Map<string, FirstUpdate> {
  const byId = new Map<string, FirstUpdate>()
  const hostOf = new Map<string, string>()
  const claim = (key: string) => {
    const { host, id } = splitKey(key)
    const seen = hostOf.get(id)
    if (seen !== undefined && seen !== host) throw new Error(`incident id ${id} is keyed under ${seen} and ${host}`)
    hostOf.set(id, host)
    return id
  }
  for (const [key, entry] of Object.entries(join)) {
    const id = claim(key)
    if (entry.kind === 'atlassian' && entry.status === 200 && entry.first) {
      byId.set(id, { at: entry.first.t, stage: entry.first.s, body: entry.first.body, source: 'atlassian' })
    }
  }
  for (const [key, entry] of Object.entries(incidentIo)) {
    const id = claim(key)
    const first = [...(entry.updates ?? [])].sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at))[0]
    if (entry.status === 200 && first) byId.set(id, { at: first.published_at, stage: first.to_status, body: first.text, source: 'incidentio' })
  }
  return byId
}

/** Pure. The one compat incident starting within ±`XAI_MATCH_WINDOW_MIN` of the row, or null when none or several do. */
export function matchXaiByStart(startedAt: string, incidents: XaiIncident[]): FirstUpdate | null {
  const t = Date.parse(startedAt)
  const hits = incidents.filter((i) => Math.abs(Date.parse(i.started_at) - t) <= XAI_MATCH_WINDOW_MIN * 60_000)
  if (hits.length !== 1) return null
  const updates = [...hits[0].incident_updates].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
  if (!updates.length) return null
  return { at: updates[0].created_at, stage: updates[0].status, body: updates[0].body, source: 'xai-compat' }
}

/** Pure. Kept rows of one service's archive months, joined to a first update where one exists. */
export function buildServiceRows(
  config: Pick<ServiceConfig, 'id' | 'provider' | 'category' | 'autoMonitorTitles' | 'titleMap'>,
  rows: ArchiveRow[],
  overrides: DurationOverride[],
  firstById: Map<string, FirstUpdate>,
  xai: XaiIncident[],
): TrainingRow[] {
  const resolved = rows.filter((r) => r.resolvedAt)
  const kept = editorialRecoveryRecords(resolved.map((r) => ({ ...r, incId: r.id, autoMonitor: r.autoMonitor ? (true as const) : undefined })), overrides, config)
  return kept.map((r) => {
    const first = firstById.get(r.id) ?? (XAI_COMPAT_SERVICES.has(config.id) ? matchXaiByStart(r.startedAt, xai) : null)
    return {
      svc: config.id,
      provider: config.provider ?? null,
      category: config.category ?? null,
      group: serviceGroupOf(config.id) ?? null,
      id: r.id,
      title: r.title,
      finalImpact: r.impact ?? null,
      startedAt: r.startedAt,
      resolvedAt: r.resolvedAt as string,
      durationMin: r.durationMin,
      derived: Boolean(r.derived),
      startUnknown: Boolean(r.startUnknown),
      timesInverted: Date.parse(r.resolvedAt as string) < Date.parse(r.startedAt),
      first: first ? { ...first, delayMin: Math.round((Date.parse(first.at) - Date.parse(r.startedAt)) / 60_000) } : null,
    }
  })
}

/** Pure. Archive documents in month order → each service's rows across them. */
export function rowsByService(archives: Array<{ services?: Record<string, { incidentList?: ArchiveRow[] }> }>): Map<string, ArchiveRow[]> {
  const out = new Map<string, ArchiveRow[]>()
  for (const a of archives) {
    for (const [svc, s] of Object.entries(a.services ?? {})) out.set(svc, [...(out.get(svc) ?? []), ...(s.incidentList ?? [])])
  }
  return out
}

function main(argv: string[]): void {
  const arg = (name: string) => {
    const i = argv.indexOf(name)
    if (i < 0 || !argv[i + 1]) throw new Error(`missing ${name}`)
    return argv[i + 1]
  }
  const data = arg('--data')
  const out = arg('--out')
  const kv = join(data, 'kv')
  const monthFiles = readdirSync(kv).filter((f) => /^archive%3Amonthly%3A\d{4}-\d{2}$/.test(f)).sort()
  const archives = monthFiles.map((f) => JSON.parse(readFileSync(join(kv, f), 'utf8')))
  const overrides = JSON.parse(readFileSync(join(kv, 'incident%3Aduration-overrides'), 'utf8')) as DurationOverride[]
  const pulls = join(data, 'pulls', '2005')
  const firstById = indexFirstUpdates(
    JSON.parse(readFileSync(join(pulls, 'join-2026-11-18.json'), 'utf8')),
    JSON.parse(readFileSync(join(pulls, 'incidentio-2026-11-19.json'), 'utf8')),
  )
  const xai = (JSON.parse(readFileSync(join(pulls, 'xai-compat-2026-11-18.json'), 'utf8')) as { incidents: XaiIncident[] }).incidents

  const bySvc = rowsByService(archives)
  const configById = new Map(SERVICES.map((s) => [s.id, s]))
  const unknown = [...bySvc.keys()].filter((id) => !configById.has(id))
  if (unknown.length) throw new Error(`archive services with no config: ${unknown.join(', ')}`)
  const rows = [...bySvc].flatMap(([svc, list]) => buildServiceRows(configById.get(svc)!, list, overrides, firstById, xai))

  writeFileSync(out, JSON.stringify(rows))
  const joined = rows.filter((r) => r.first)
  const unique = (rs: TrainingRow[]) => new Set(rs.map((r) => r.id)).size
  console.log(`months ${monthFiles.map((f) => f.slice(-7)).join(' ')}`)
  console.log(`rows ${rows.length}, joined ${joined.length}; unique incidents ${unique(rows)}, joined ${unique(joined)}; timesInverted ${rows.filter((r) => r.timesInverted).length}`)
  console.log(`services ${new Set(rows.map((r) => r.svc)).size}; with >= 10 joined rows ${[...new Set(joined.map((r) => r.svc))].filter((s) => joined.filter((r) => r.svc === s).length >= 10).length}`)
}

if (isMain(import.meta.url)) main(process.argv.slice(2))
