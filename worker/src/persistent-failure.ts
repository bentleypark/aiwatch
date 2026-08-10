// #500 — persistent structural-block alert.
//
// Sweeps the consolidated tracking blob's `failSince` fields (written by trackFetchFailure on first
// failure, cleared by resetFetchFailure on recovery — see utils.ts's #1224 tracking-state block) and
// fires ONE operator Discord warning per service whose status page has been continuously unreachable
// >= 1h. Operator-only ops signal: it never builds a feed entry or touches the per-user relay.
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

import { kvPut, readTrackingState, isFailSinceLive, shouldAlertPersistentFailure, formatPersistentFailureAlert, type KVLike } from './utils'

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
  // skip the daily persistent-failure alert (the operator already knows it's structurally blocked).
  suppressedIds: Set<string> = new Set(),
): Promise<void> {
  if (!kv || !discordUrl) return
  try {
    const nameById = new Map(services.map((s) => [s.id, s.name]))
    // Ground truth for a 24h-deduped operator alert — reads the tracking blob directly (#1224),
    // once per cron cycle, not per service.
    const store = await readTrackingState(kv)
    for (const [svcId, entry] of Object.entries(store)) {
      if (!isFailSinceLive(entry, nowMs)) continue // frozen leftover — the source stopped reporting failures at all
      const since = entry.failSince!
      if (suppressedIds.has(svcId)) continue // #800 — acknowledged dead source, don't re-warn
      if (!shouldAlertPersistentFailure(since, nowMs)) continue
      const dedupKey = `alerted:fetch-persistent:${svcId}`
      if (await kv.get(dedupKey).catch(() => null)) continue // already warned this 24h
      const name = nameById.get(svcId) ?? svcId
      const ok = await send(discordUrl, {
        title: `⚠️ ${name} — status page unreachable 1h+`,
        description: formatPersistentFailureAlert(name, since, nowMs),
        color: 0xe67e22, // warning amber — distinct from down (red) / degraded
      })
      // Write the dedup marker only on a successful send, so a failed Discord POST retries next cron.
      if (ok) await kvPut(kv, dedupKey, '1', { expirationTtl: 86_400 }) // 24h
    }
  } catch (err) {
    console.error('[cron] persistent fetch-failure check failed:', err instanceof Error ? err.message : err)
  }
}
