// #1531 Part 7 — read the hourly Vercel Blob copy of the lean status payload and cut the same view
// the Worker would have served for `statusUrl`.

import { buildStatusView, parseStatusView, type LeanStatusPayload } from '../../worker/src/status-view'
import { LAST_GOOD_COPY_URL } from '../../worker/src/last-good-copy-path'

export const LAST_GOOD_MAX_AGE_MS = 3 * 60 * 60 * 1000

export function lastGoodView<T>(statusUrl: string, copyUrl: string = LAST_GOOD_COPY_URL, now: () => number = Date.now) {
  const view = parseStatusView(new URL(statusUrl).searchParams)
  return async (signal: AbortSignal): Promise<T | null> => {
    if (!view) return null
    try {
      const res = await fetch(copyUrl, { signal })
      if (!res.ok) return null
      const payload = await res.json() as LeanStatusPayload & { lastUpdated?: string }
      const updatedAt = Date.parse(payload.lastUpdated ?? '')
      if (!(now() - updatedAt <= LAST_GOOD_MAX_AGE_MS)) return null
      return buildStatusView(view, payload) as T
    } catch {
      return null
    }
  }
}
