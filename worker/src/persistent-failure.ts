// #500 — persistent unreadable-source alert.
//
// Sweeps the consolidated tracking blob's `failSince` fields (written by trackFetchFailure at a
// threshold crossing, cleared by resetFetchFailure on recovery — see utils.ts's #1224 tracking-state block) and
// fires ONE operator Discord warning per service whose status source has been continuously unreadable
// >= 1h. #1391 — "unreadable", not "unreachable": trackFetchFailure arms `failSince` from the parse
// branches too, so the streak establishes nothing about WHY.
// Operator-only ops signal: it never builds a feed entry or touches the per-user relay.
// Deduped 24h. Best-effort — the whole sweep is wrapped so a failure can't affect the cron's main
// alert path.
//
// `failSince` itself never expires (#1224 folded it into a TTL-less blob), so `isFailSinceLive` is
// what stands in for the old key's 25h TTL: a service whose status-page fetch goes fully dead (a 4xx
// #689 dead-source read, a flashduty-feed early return) stops calling trackFetchFailure/
// resetFetchFailure entirely, and without this gate its frozen `failSince` would re-fire this alert
// every 24h forever instead of falling silent once `failCountAt` goes stale.
//
// Extracted from index.ts (not inlined) so the orchestration is unit-testable with an injected
// `send` + a mock KV, per the "new worker logic → exported fn + unit test" rule.

import { kvPut, readTrackingState, isFailSinceLive, shouldAlertPersistentFailure, formatPersistentFailureAlert, type KVLike, type PersistentFailureCause, type ServiceTrackingState } from './utils'
import { parseFailKey, parseParseFailDay, reasonsFor, slotOf, type ParseFailDay } from './parse-failure-log'

/** #1391 — how many 5-minute slots back a parse booking still counts as the current cause. Width is
 *  pinned by `persistent-failure.test.ts`, not by this line. */
export const PARSE_CAUSE_RECENCY_SLOTS = 2

/** #1391 — pure. Collect whichever of the two signals exist at alert time. Neither ranks over the
 *  other: each ages on its own clock, so electing one can discard the newer observation. */
function persistentFailureCause(
  entry: Pick<ServiceTrackingState, 'sourceReadFailure'>,
  day: ParseFailDay,
  svcId: string,
  nowMs: number,
): PersistentFailureCause {
  const cause: PersistentFailureCause = {}
  const slot = day.slots[svcId]
  if (slot !== undefined && slotOf(nowMs) - slot <= PARSE_CAUSE_RECENCY_SLOTS) {
    // `slots` dates the LAST booking and names no reason, so singling one out would claim a
    // currency the record cannot support.
    cause.reasons = reasonsFor(day, svcId)
  }
  if (entry.sourceReadFailure) cause.failure = entry.sourceReadFailure
  return cause
}

type DiscordSend = (
  webhookUrl: string,
  embed: { title: string; description: string; color: number },
) => Promise<boolean>

export async function checkPersistentFetchFailures(
  kv: KVLike | undefined,
  discordUrl: string | undefined,
  services: Array<{ id: string; name: string }>,
  nowMs: number,
  send: DiscordSend,
  // #800 — svcIds whose status page is a KNOWN, acknowledged deactivation (statusSourceDeactivated):
  // skip the daily persistent-failure alert (the operator already acknowledged this source).
  suppressedIds: Set<string> = new Set(),
): Promise<void> {
  if (!kv || !discordUrl) return
  try {
    const nameById = new Map(services.map((s) => [s.id, s.name]))
    // Ground truth for a 24h-deduped operator alert — reads the tracking blob directly (#1224),
    // once per cron cycle, not per service.
    const store = await readTrackingState(kv)
    // #1391 — the day's parse bookings, read at most ONCE per sweep and only when a service actually
    // reaches the send. Steady state here is "nothing due", so this adds no read on the common path
    // (#1224's steady-state-zero invariant).
    let day: ParseFailDay | null = null
    for (const [svcId, entry] of Object.entries(store)) {
      if (!isFailSinceLive(entry, nowMs)) continue // frozen leftover — the source stopped reporting failures at all
      const since = entry.failSince!
      if (suppressedIds.has(svcId)) continue // #800 — acknowledged dead source, don't re-warn
      if (!shouldAlertPersistentFailure(since, nowMs)) continue
      const dedupKey = `alerted:fetch-persistent:${svcId}`
      if (await kv.get(dedupKey).catch(() => null)) continue // already warned this 24h
      const name = nameById.get(svcId) ?? svcId
      if (!day) {
        const raw = await kv.get(parseFailKey(new Date(nowMs).toISOString().split('T')[0])).catch(() => null)
        day = parseParseFailDay(raw)
      }
      const cause = persistentFailureCause(entry, day, svcId, nowMs)
      const ok = await send(discordUrl, {
        title: `⚠️ ${name} — status source unreadable 1h+`,
        description: formatPersistentFailureAlert(name, since, nowMs, cause),
        color: 0xe67e22, // warning amber — distinct from down (red) / degraded
      })
      // Write the dedup marker only on a successful send, so a failed Discord POST retries next cron.
      if (ok) await kvPut(kv, dedupKey, '1', { expirationTtl: 86_400 }) // 24h
    }
  } catch (err) {
    console.error('[cron] persistent fetch-failure check failed:', err instanceof Error ? err.message : err)
  }
}
