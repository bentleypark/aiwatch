// #1531 Part 5 — the Edge is-down pages' one Worker read, sent a second time when the first is slow.
// The total wait stays the 5 s the pages had before.

export const HEDGE_AFTER_MS = 2500
export const DEADLINE_MS = 5000

export type HedgedFetchResult<T> =
  | { ok: true; data: T; attempt: 1 | 2 }
  | { ok: false; reason: string }

async function attemptJson<T>(url: string, signal: AbortSignal): Promise<{ ok: true; data: T } | { ok: false; reason: string }> {
  let res: Response
  try {
    res = await fetch(url, { signal })
  } catch {
    return { ok: false, reason: 'worker_unreachable' }
  }
  if (!res.ok) return { ok: false, reason: `worker_http_${res.status}` }
  try {
    return { ok: true, data: await res.json() as T }
  } catch {
    return { ok: false, reason: 'parse_error' }
  }
}

/** Fetch + parse JSON. A second request starts at `hedgeAfterMs` if the first has not finished; the
 *  first success wins. A failure that arrives before the hedge is returned as is. Both are abandoned
 *  at `deadlineMs`. */
export function hedgedJsonFetch<T>(
  url: string,
  { hedgeAfterMs = HEDGE_AFTER_MS, deadlineMs = DEADLINE_MS }: { hedgeAfterMs?: number; deadlineMs?: number } = {},
): Promise<HedgedFetchResult<T>> {
  return new Promise((resolve) => {
    const controllers: AbortController[] = []
    const failures: string[] = []
    let settled = false
    let inFlight = 0

    const finish = (result: HedgedFetchResult<T>) => {
      if (settled) return
      settled = true
      clearTimeout(hedgeTimer)
      clearTimeout(deadlineTimer)
      for (const c of controllers) c.abort()
      resolve(result)
    }

    const launch = (attempt: 1 | 2) => {
      const controller = new AbortController()
      controllers.push(controller)
      inFlight++
      void attemptJson<T>(url, controller.signal).then((result) => {
        inFlight--
        if (result.ok) return finish({ ok: true, data: result.data, attempt })
        failures.push(result.reason)
        if (inFlight === 0) finish({ ok: false, reason: failures[0] })
      })
    }

    const hedgeTimer = setTimeout(() => launch(2), hedgeAfterMs)
    const deadlineTimer = setTimeout(() => finish({ ok: false, reason: failures[0] ?? 'worker_timeout' }), deadlineMs)
    launch(1)
  })
}
