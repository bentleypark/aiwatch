// #1896 — the RTT degradation count step of the */5 cron, extracted from index.ts.

import { kvPut, type KVLike } from './utils'
import { DEGRADATION_DEDUP_TTL_SEC, type ProbeSpike } from './probe'
import { classifyDegradation } from './daily-summary'
import { degradationMonthlyKey, addDegradationToMonthly, degradationEventFor, normalizeDegradationMonthly, DEGRADATION_MONTHLY_TTL_SECONDS } from './monthly-archive'
import { serializeDetectionEntry, isProbeEarlier } from './detection'

/** Count one detected spike run. Returns false when the service was already counted within the dedup TTL. */
export async function recordDegradation(
  kv: KVLike,
  spike: ProbeSpike,
  cachedStatus: string | undefined,
  now: Date,
): Promise<boolean> {
  const alertKey = `alerted:probe-spike:${spike.serviceId}`
  const existing = await kv.get(alertKey).catch(() => null)
  if (existing) return false
  await kvPut(kv, alertKey, '1', { expirationTtl: DEGRADATION_DEDUP_TTL_SEC })
  // #464 — count this RTT degradation. If the service's
  // official status is still operational, the degradation isn't on the status page → the
  // `nostatus` figure. Best-effort, mirrors the fetch-fail:daily counter (48h TTL).
  // #1233 KNOWN LIMITATION — `classifyDegradation` is a two-way boolean, so an `unknown` service
  // answers `false` and its RTT degradation is booked as "already on the status page" when in fact
  // we could not read that page. Reachable: `detectConsecutiveSpikes` has a lower bar than
  // `isProbeFailing`, so a spiking service can stay `unknown` through cross-validation and land
  // here. Left as-is deliberately — the honest fix is a third outcome.
  const svcOperational = cachedStatus === 'operational'
  const outcome = classifyDegradation(svcOperational)
  const isNoStatus = outcome === 'degradation_nostatus'
  const degradationDate = now.toISOString().split('T')[0]
  const degBase = `probe-degradation:daily:${spike.serviceId}:${degradationDate}`
  const prevDeg = parseInt(await kv.get(degBase).catch(() => null) ?? '0', 10) || 0
  await kvPut(kv, degBase, String(prevDeg + 1), { expirationTtl: 172800 })
  if (isNoStatus) {
    const nsKey = `probe-degradation:nostatus:daily:${spike.serviceId}:${degradationDate}`
    const prevNs = parseInt(await kv.get(nsKey).catch(() => null) ?? '0', 10) || 0
    await kvPut(kv, nsKey, String(prevNs + 1), { expirationTtl: 172800 })
  }
  // #511 — dual-write the monthly accumulator (60d TTL) so the archive cron can read
  // month-complete figures past the daily 48h TTL.
  const degMonthKey = degradationMonthlyKey(now)
  const degMonthRaw = await kv.get(degMonthKey).catch(() => null)
  let degMonth = null
  try { degMonth = degMonthRaw ? normalizeDegradationMonthly(JSON.parse(degMonthRaw)) : null } catch { degMonth = null }
  const nextDegMonth = addDegradationToMonthly(degMonth, spike.serviceId, isNoStatus,
    degradationEventFor(spike, isNoStatus, cachedStatus ?? null, now.toISOString()))
  await kvPut(kv, degMonthKey, JSON.stringify(nextDegMonth), { expirationTtl: DEGRADATION_MONTHLY_TTL_SECONDS })
  // Record probe spike as earliest detection
  const detectKey = `detected:${spike.serviceId}`
  const existingDetect = await kv.get(detectKey).catch(() => null)
  if (isProbeEarlier(existingDetect, spike.since)) {
    await kvPut(kv, detectKey, serializeDetectionEntry({ t: spike.since, incId: null }), { expirationTtl: 604800 })
  }
  return true
}
