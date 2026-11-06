// #1152 — publish, then enrich. A new-incident operator alert whose inline AI analysis did not land
// is sent at once; its message id is kept, and the AI section is PATCHed in once `ai:analysis` exists.
// Operator webhook only: the #486 per-user relay and `alert:feed` keep the alert as it was sent.

import { DISCORD_EMBED_DESC_MAX, defuseAutolinkDomain } from './alerts'
import { kvPut, type KVLike } from './utils'

export const ENRICH_PENDING_KEY = 'discord:enrich:pending'
/** How long a sent alert waits for its analysis before it is given up on. */
export const ENRICH_WINDOW_MS = 2 * 60 * 60 * 1000
/** PATCHes per cron run, matching the per-run send cap. */
export const ENRICH_MAX_PER_RUN = 5

export interface EnrichRecord {
  messageId: string
  svcId: string
  incId: string
  title: string
  color: number
  sentAt: string
  /** The operator description as sent. */
  full: string
  /** The shared part of it, without the operator-only sections appended after the link. */
  core: string
  /** Where the AI section goes, in both `full` and `core`. */
  at: number
  expiresAt: number
}

export function withWaitParam(webhookUrl: string): string {
  const u = new URL(webhookUrl)
  u.searchParams.set('wait', 'true')
  return u.toString()
}

export function messageEditUrl(webhookUrl: string, messageId: string): string {
  const u = new URL(webhookUrl)
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/messages/${messageId}`
  u.searchParams.delete('wait')
  return u.toString()
}

export function parseMessageId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const id = (body as { id?: unknown }).id
  return typeof id === 'string' && /^\d+$/.test(id) ? id : null
}

/** The description with the AI section in place, or null when neither form fits Discord's cap. */
export function insertAnalysis(rec: Pick<EnrichRecord, 'full' | 'core' | 'at'>, section: string): string | null {
  const ins = `\n${defuseAutolinkDomain(section)}`
  for (const base of [rec.full, rec.core]) {
    if (base.length + ins.length <= DISCORD_EMBED_DESC_MAX) return base.slice(0, rec.at) + ins + base.slice(rec.at)
  }
  return null
}

export function parsePending(raw: string | null): EnrichRecord[] | null {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v)
      ? v.filter((r): r is EnrichRecord => !!r && typeof r.messageId === 'string' && typeof r.full === 'string'
        && typeof r.core === 'string' && typeof r.at === 'number' && typeof r.expiresAt === 'number')
      : null
  } catch {
    return null
  }
}

export interface EnrichCounts { enriched: number; failed: number; expired: number }

/**
 * One enrichment pass: queue `added`, then for each pending record PATCH the section in when it is
 * available, drop it when its window has passed, and keep it otherwise. A failed PATCH is not retried.
 */
export async function runEnrichment(
  kv: KVLike,
  added: EnrichRecord[],
  readSection: (rec: EnrichRecord) => Promise<string | null>,
  patch: (rec: EnrichRecord, description: string) => Promise<boolean>,
  now: number,
): Promise<EnrichCounts> {
  const counts: EnrichCounts = { enriched: 0, failed: 0, expired: 0 }
  const stored = await kv.get(ENRICH_PENDING_KEY).then(parsePending, () => null)
  if (!stored) {
    console.error('[cron] #1152 enrich queue unreadable — left as is; these alerts will not get their AI section:', added.map((r) => r.incId).join(', '))
    return { ...counts, failed: added.length }
  }
  const pending = [...stored, ...added]
  const keep: EnrichRecord[] = []
  const ready: Array<{ rec: EnrichRecord; section: string }> = []
  let expired = 0
  for (const rec of pending) {
    if (ready.length >= ENRICH_MAX_PER_RUN) { keep.push(rec); continue }
    const section = await readSection(rec).catch(() => null)
    if (section) ready.push({ rec, section })
    else if (now >= rec.expiresAt) expired++
    else keep.push(rec)
  }
  if (keep.length !== stored.length || added.length > 0) {
    const ttl = Math.ceil((Math.max(...keep.map((r) => r.expiresAt), now) - now + ENRICH_WINDOW_MS) / 1000)
    if (!(await kvPut(kv, ENRICH_PENDING_KEY, JSON.stringify(keep), { expirationTtl: ttl }))) {
      console.error('[cron] #1152 enrich queue write failed — no edits this run; these alerts will not get their AI section:', added.map((r) => r.incId).join(', '))
      return { ...counts, failed: added.length }
    }
  }
  counts.expired = expired
  for (const { rec, section } of ready) {
    const description = insertAnalysis(rec, section)
    if (description && await patch(rec, description).catch(() => false)) counts.enriched++
    else counts.failed++
  }
  return counts
}
