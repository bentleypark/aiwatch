// #629 — reliably trigger the deepseek-feed GitHub Action from the worker's */5 Cloudflare cron.
//
// GitHub scheduled workflows are best-effort and heavily throttled (a `*/10` cron observed running
// only ~every 2h), which let the Flashduty feed KV expire (3h TTL) or go soft-stale (>1h), dropping
// DeepSeek from the Score ranking. Cloudflare's scheduled handler, by contrast, fires reliably every
// 5 min — so the worker dispatches the workflow each cycle (workflow_dispatch API), making DeepSeek a
// first-class */5 service. A short KV cooldown spaces dispatches to ~one per cron cycle; because KV
// reads are only eventually consistent (so the cooldown can't be a hard guarantee), the workflow's
// own `concurrency` group is the LOAD-BEARING guard against pile-up, alongside the workflow's job
// timeout. Overlapping dispatches do NOT queue: a concurrency group holds at most one running and one
// pending run, and a new arrival CANCELS the pending one — so a held run sheds the dispatches behind
// it as zero-job `cancelled` runs (#1253 measured 11 of 26). The GitHub `schedule` stays as a backup.

export const DISPATCH_COOLDOWN_KEY = 'deepseek:dispatch:cooldown'
// Just under the */5 cron interval (300s) so each cycle normally dispatches once while a same-cycle
// re-invocation (retry / overlapping isolate) is suppressed.
export const DISPATCH_COOLDOWN_S = 240
// Longer cooldown after a FAILED dispatch (bad/expired PAT, renamed workflow): the hourly schedule
// backup keeps DeepSeek data fresh meanwhile, so back off to cut api.github.com pressure + log noise
// rather than re-firing every */5 cycle.
export const DISPATCH_FAIL_COOLDOWN_S = 900

const REPO = 'bentleypark/aiwatch'
const WORKFLOW_FILE = 'deepseek-feed.yml'
const REF = 'main'

/** Build the GitHub workflow_dispatch request (pure — no I/O). */
export function buildWorkflowDispatchRequest(token: string): { url: string; init: RequestInit } {
  return {
    url: `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'aiwatch-worker', // GitHub API rejects requests without a User-Agent
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: REF }),
    },
  }
}

interface DispatchEnv {
  GH_DISPATCH_TOKEN?: string
  STATUS_CACHE: KVNamespace
}

/**
 * Dispatch the deepseek-feed workflow if outside the cooldown window. No-op (silently) when the token
 * isn't configured. Never throws — a dispatch failure must not break the rest of the cron.
 */
export async function maybeDispatchDeepseekFeed(env: DispatchEnv): Promise<void> {
  if (!env.GH_DISPATCH_TOKEN || !env.STATUS_CACHE) return
  const inCooldown = await env.STATUS_CACHE.get(DISPATCH_COOLDOWN_KEY).catch(() => null)
  if (inCooldown) return

  const { url, init } = buildWorkflowDispatchRequest(env.GH_DISPATCH_TOKEN)
  try {
    const res = await fetch(url, init)
    res.body?.cancel?.()
    if (res.status === 204) {
      await env.STATUS_CACHE.put(DISPATCH_COOLDOWN_KEY, '1', { expirationTtl: DISPATCH_COOLDOWN_S }).catch(() => undefined)
    } else {
      // Persistent failure (bad token, missing workflow) → back off (hourly schedule covers freshness).
      console.warn(`[deepseek-dispatch] workflow_dispatch returned HTTP ${res.status}`)
      await env.STATUS_CACHE.put(DISPATCH_COOLDOWN_KEY, '1', { expirationTtl: DISPATCH_FAIL_COOLDOWN_S }).catch(() => undefined)
    }
  } catch (err) {
    console.warn('[deepseek-dispatch] dispatch failed:', err instanceof Error ? err.message : err)
  }
}
