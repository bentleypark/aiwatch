// #500 — persistent structural-block alert.
//
// Sweeps the `fetch-fail:since:{svcId}` markers (written by trackFetchFailure on first failure,
// cleared by resetFetchFailure on recovery — see utils.ts) and fires ONE operator Discord warning
// per service whose status page has been continuously unreachable >= 1h. Operator-only ops signal:
// it never builds a feed entry or touches the per-user relay. Deduped 24h. Best-effort — the whole
// sweep is wrapped so a failure can't affect the cron's main alert path.
//
// Extracted from index.ts (not inlined) so the orchestration is unit-testable with an injected
// `send` + a mock KV, per the "new worker logic → exported fn + unit test" rule.

import { kvPut, shouldAlertPersistentFailure, formatPersistentFailureAlert, type KVLike } from './utils'

const SINCE_PREFIX = 'fetch-fail:since:'

type DiscordSend = (
  webhookUrl: string,
  embed: { title: string; description: string; color: number },
) => Promise<boolean>

/** The KV surface this sweep needs: a KVLike (get/put/delete — accepted by kvPut) plus list. */
interface KVSweep extends KVLike {
  list(opts: { prefix: string }): Promise<{ keys: Array<{ name: string }> }>
}

export async function checkPersistentFetchFailures(
  kv: KVSweep | undefined,
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
    const listed = await kv.list({ prefix: SINCE_PREFIX })
    for (const key of listed.keys) {
      const svcId = key.name.slice(SINCE_PREFIX.length)
      if (suppressedIds.has(svcId)) continue // #800 — acknowledged dead source, don't re-warn
      const since = await kv.get(key.name).catch(() => null)
      if (!shouldAlertPersistentFailure(since, nowMs)) continue
      const dedupKey = `alerted:fetch-persistent:${svcId}`
      if (await kv.get(dedupKey).catch(() => null)) continue // already warned this 24h
      const name = nameById.get(svcId) ?? svcId
      const ok = await send(discordUrl, {
        title: `⚠️ ${name} — status page unreachable 1h+`,
        description: formatPersistentFailureAlert(name, since as string, nowMs),
        color: 0xe67e22, // warning amber — distinct from down (red) / degraded
      })
      // Write the dedup marker only on a successful send, so a failed Discord POST retries next cron.
      if (ok) await kvPut(kv, dedupKey, '1', { expirationTtl: 86_400 }) // 24h
    }
  } catch (err) {
    console.error('[cron] persistent fetch-failure check failed:', err instanceof Error ? err.message : err)
  }
}
