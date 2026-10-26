// #1797 — a past month's `archive:monthly` row that is still unresolved while the provider has
// resolved it. Resolving the row can move that month's published figures (2026-08 openai: grade
// good→fair), so this never rewrites the archive. It tells the operator, who corrects the row with
// `patch-archive-derived-dupes.ts --correction`.

import { kvPut, type KVLike } from './utils'
import { isMarkableOnStatusEdge } from './recovery-mark'
import type { ServiceStatus } from './types'
import type { MonthlyIncidentEntry } from './monthly-archive'

type DiscordSend = (
  webhookUrl: string,
  embed: { title: string; description: string; color: number },
) => Promise<boolean>

export interface LateResolution {
  period: string
  svcId: string
  svcName: string
  incId: string
  title: string
  startedAt: string
  resolvedAt: string
  storedStatus: MonthlyIncidentEntry['finalStatus']
}

const LATE_RESOLUTION_DEDUP_TTL_S = 30 * 86_400

type ArchiveRows = { services?: Record<string, { incidentList?: MonthlyIncidentEntry[] }> }

function resolvedUpstream(inc: ServiceStatus['incidents'][number]): inc is ServiceStatus['incidents'][number] & { resolvedAt: string } {
  return inc.status === 'resolved' && typeof inc.resolvedAt === 'string' && isMarkableOnStatusEdge(inc)
}

/** The past months a live, upstream-resolved incident started in. */
export function lateResolutionPeriods(services: ServiceStatus[], nowMs: number): string[] {
  const current = new Date(nowMs).toISOString().slice(0, 7)
  const periods = new Set<string>()
  for (const svc of services) {
    for (const inc of svc.incidents ?? []) {
      const period = inc.startedAt?.slice(0, 7)
      if (resolvedUpstream(inc) && period && period < current) periods.add(period)
    }
  }
  return [...periods].sort()
}

/** Rows of `period`'s archive that are still unresolved while the same service's live feed has the
 *  same id resolved. */
export function findLateResolutions(period: string, archive: ArchiveRows, services: ServiceStatus[]): LateResolution[] {
  const out: LateResolution[] = []
  for (const svc of services) {
    const rows = archive.services?.[svc.id]?.incidentList
    if (!rows?.length) continue
    const open = new Map(rows.filter((r) => r.finalStatus !== 'resolved').map((r) => [r.id, r]))
    for (const inc of svc.incidents ?? []) {
      const row = open.get(inc.id)
      if (!row || !resolvedUpstream(inc)) continue
      out.push({
        period,
        svcId: svc.id,
        svcName: svc.name,
        incId: inc.id,
        title: row.title,
        startedAt: row.startedAt,
        resolvedAt: inc.resolvedAt,
        storedStatus: row.finalStatus,
      })
    }
  }
  return out
}

export function formatLateResolutionAlert(r: LateResolution): { title: string; description: string } {
  return {
    title: `🗂️ ${r.svcName} — ${r.period} archive row still open, resolved upstream`,
    description: [
      `**${r.title}**`,
      `id \`${r.incId}\` · started ${r.startedAt} · resolved upstream ${r.resolvedAt}`,
      `\`archive:monthly:${r.period}\` still stores it as \`${r.storedStatus}\`.`,
      `Correct it with a \`ROW_REPLACEMENTS\` entry and \`npx tsx scripts/patch-archive-derived-dupes.ts --period ${r.period} --correction <name>\`, after reviewing the figure diff.`,
    ].join('\n'),
  }
}

export function lateResolutionDedupKey(r: Pick<LateResolution, 'period' | 'svcId' | 'incId'>): string {
  return `alerted:late-res:${r.period}:${r.svcId}:${r.incId}`
}

export async function checkLateResolutions(
  kv: KVLike | undefined,
  discordUrl: string | undefined,
  services: ServiceStatus[],
  nowMs: number,
  send: DiscordSend,
): Promise<void> {
  if (!kv || !discordUrl) return
  try {
    for (const period of lateResolutionPeriods(services, nowMs)) {
      let raw: string | null
      try {
        raw = await kv.get(`archive:monthly:${period}`)
      } catch (err) {
        console.warn(`[cron] late-resolution: archive:monthly:${period} read failed:`, err instanceof Error ? err.message : err)
        continue
      }
      if (!raw) continue
      let archive: ArchiveRows
      try {
        archive = JSON.parse(raw) as ArchiveRows
      } catch (err) {
        console.warn(`[cron] late-resolution: archive:monthly:${period} unparseable:`, err instanceof Error ? err.message : err)
        continue
      }
      for (const r of findLateResolutions(period, archive, services)) {
        const dedupKey = lateResolutionDedupKey(r)
        let alreadySent: string | null = null
        try {
          alreadySent = await kv.get(dedupKey)
        } catch (err) {
          console.warn(`[cron] late-resolution dedup read failed for ${dedupKey} — may re-alert:`, err instanceof Error ? err.message : err)
        }
        if (alreadySent) continue
        const ok = await send(discordUrl, { ...formatLateResolutionAlert(r), color: 0x9b59b6 })
        if (ok && !(await kvPut(kv, dedupKey, '1', { expirationTtl: LATE_RESOLUTION_DEDUP_TTL_S }))) {
          console.warn(`[cron] late-resolution alerted ${dedupKey} but could not persist it — will re-alert next run`)
        }
      }
    }
  } catch (err) {
    console.error('[cron] late-resolution check failed:', err instanceof Error ? err.message : err)
  }
}
