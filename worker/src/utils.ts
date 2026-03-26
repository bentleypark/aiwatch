// Shared utility functions for AIWatch Worker

export function formatDuration(start: Date, end: Date): string {
  const diffMs = end.getTime() - start.getTime()
  if (diffMs < 60_000) return '~1m'
  const hours = Math.floor(diffMs / 3_600_000)
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000)
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
    await kv.put(failKey, String(next), { expirationTtl: 1800 }).catch(() => {})
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
  if (existing !== null) await kv.delete(key).catch(() => {})
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
