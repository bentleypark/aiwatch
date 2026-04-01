// Shared utility functions for AIWatch Worker

export function formatDuration(start: Date, end: Date): string {
  const diffMs = end.getTime() - start.getTime()
  const totalMin = Math.max(1, Math.ceil(diffMs / 60_000))
  const hours = Math.floor(totalMin / 60)
  const minutes = totalMin % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function sanitize(s: string, maxLen = 1000): string {
  return s
    .replace(/@(everyone|here)/g, '@\u200b$1')
    .replace(/<@[!&]?\d+>/g, '[mention]')
    .replace(/```/g, '\\`\\`\\`')
    .slice(0, maxLen)
}

export interface KVLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/** Safe KV write with error logging. Returns true on success, false on failure. */
export async function kvPut(kv: KVLike | KVNamespace, key: string, value: string, opts?: { expirationTtl?: number }): Promise<boolean> {
  try {
    await kv.put(key, value, opts)
    return true
  } catch (err) {
    console.warn('[kv] write failed:', key, err instanceof Error ? err.message : err)
    return false
  }
}

/** Safe KV delete with error logging. */
export async function kvDel(kv: KVLike | KVNamespace, key: string): Promise<void> {
  try {
    await kv.delete(key)
  } catch (err) {
    console.warn('[kv] delete failed:', key, err instanceof Error ? err.message : err)
  }
}

/**
 * Track consecutive RSS fetch failures per service.
 * Returns true if failure count has reached the threshold (service should be degraded).
 * Returns false if still below threshold (treat as operational / no data).
 */
export async function trackFetchFailure(kv: KVLike | undefined, svcId: string, threshold = 3): Promise<boolean> {
  if (!kv) return false
  const failKey = `fetch-fail:${svcId}`
  const count = parseInt(await kv.get(failKey).catch(() => null) ?? '0', 10) || 0
  const next = count + 1
  if (next <= threshold) {
    await kvPut(kv, failKey, String(next), { expirationTtl: 1800 })
  }
  return next >= threshold
}

/**
 * Reset fetch failure counter on successful fetch.
 */
export async function resetFetchFailure(kv: KVLike | undefined, svcId: string): Promise<void> {
  if (!kv) return
  const key = `fetch-fail:${svcId}`
  const existing = await kv.get(key).catch(() => null)
  if (existing !== null) await kvDel(kv, key)
}

/**
 * Track consecutive component ID misses per service.
 * Returns true if miss count has reached the threshold (alert should fire).
 */
export async function trackComponentMiss(kv: KVLike | undefined, svcId: string, threshold = 3): Promise<boolean> {
  if (!kv) return false
  const key = `component-missing:${svcId}`
  const count = parseInt(await kv.get(key).catch(() => null) ?? '0', 10) || 0
  const next = count + 1
  if (next <= threshold) {
    await kvPut(kv, key, String(next), { expirationTtl: 1800 })
  }
  return next >= threshold
}

/**
 * Reset component miss counter on successful component lookup.
 */
export async function resetComponentMiss(kv: KVLike | undefined, svcId: string): Promise<void> {
  if (!kv) return
  const key = `component-missing:${svcId}`
  const existing = await kv.get(key).catch(() => null)
  if (existing !== null) await kvDel(kv, key)
}

/**
 * Detect component ID mismatches that need alerting.
 * Returns list of services that have reached the miss threshold and haven't been alerted yet.
 */
export async function detectComponentMismatches(
  services: { id: string; name: string; statusComponentId: string }[],
  kv: KVLike,
  threshold = 3,
): Promise<{ id: string; name: string; statusComponentId: string; missCount: number; alertKey: string }[]> {
  const results: { id: string; name: string; statusComponentId: string; missCount: number; alertKey: string }[] = []
  for (const svc of services) {
    const missCount = parseInt(await kv.get(`component-missing:${svc.id}`).catch(() => null) ?? '0', 10) || 0
    if (missCount < threshold) continue
    const alertKey = `alerted:component-missing:${svc.id}`
    const alreadyAlerted = await kv.get(alertKey).catch(() => null)
    if (alreadyAlerted) continue
    results.push({ ...svc, missCount, alertKey })
  }
  return results
}

export async function fetchWithTimeout(url: string, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'follow' })
  } finally {
    clearTimeout(timer)
  }
}
