// #629/#1395 — in addition to each workflow's own `schedule` trigger, the worker's */5 Cloudflare
// cron dispatches it directly via the GitHub API (workflow_dispatch), on a per-consumer KV cooldown
// (see MISTRAL_DISPATCH_CONFIG for why Mistral's differs from DeepSeek's). Why this exists: #629,
// #1395 — not restated here.
//
// Because KV reads are only eventually consistent (so the cooldown is not a hard guarantee against a
// duplicate dispatch), each workflow's own `concurrency` group is what actually prevents pile-up,
// alongside the workflow's job timeout: a concurrency group holds at most one running and one pending
// run, and a new arrival cancels the pending one — documented GitHub Actions behavior.
//
// #1395 — parameterised from a DeepSeek-only shape (deliberately reverted to single-consumer during
// #1381's review, since generalising ahead of a second real consumer was unevidenced abstraction).
// That evidence now exists: Mistral's `mistral-feed.yml` has the same expiring-KV failure mode, but
// NOT the same cooldown shape — see MISTRAL_DISPATCH_CONFIG below for why.

const REPO = 'bentleypark/aiwatch'
const REF = 'main'

/** Build the GitHub workflow_dispatch request (pure — no I/O). */
export function buildWorkflowDispatchRequest(token: string, workflowFile: string): { url: string; init: RequestInit } {
  return {
    url: `https://api.github.com/repos/${REPO}/actions/workflows/${workflowFile}/dispatches`,
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

export interface WorkflowDispatchConfig {
  workflowFile: string
  /** Must be unique per consumer — a shared key would make one workflow's dispatch suppress the other's. */
  cooldownKey: string
  cooldownS: number
  failCooldownS: number
}

// DeepSeek: the worker's own cron (`*/5 * * * *`, wrangler.toml) calls maybeDispatchWorkflow every 5
// min; cooldownS just under that (240s) so a normal cycle dispatches once while a same-cycle
// re-invocation (retry / overlapping isolate) is suppressed. failCooldownS (900s) applies equally to
// a non-204 response and a thrown fetch (see the `catch` block below) — cost hygiene only (fewer
// retries against api.github.com, less log noise); it makes no claim about why the call failed, and
// 900s is short enough relative to `DEEPSEEK_FEED_SOFT_STALE_S` (1h) and `DEEPSEEK_FEED_TTL_S` (3h,
// both `parsers/flashduty.ts`) that it is not itself a source of missed freshness — though it is not
// a freshness guarantee either: the 900s clock starts at the failed dispatch, not at the last
// successful feed push, and the next `*/5` cycle after the cooldown is what actually recovers it.
export const DEEPSEEK_DISPATCH_CONFIG: WorkflowDispatchConfig = {
  workflowFile: 'deepseek-feed.yml',
  cooldownKey: 'deepseek:dispatch:cooldown',
  cooldownS: 240,
  failCooldownS: 900,
}

// Mistral: NOT the same cadence as DeepSeek's `*/5`. The scrape job drives headed Chrome under xvfb
// reading ~93 tooltips + ~80 incident pages (a verified run took 3m49s wall, 3m32s of actual
// scraping — run 34581851025), and the source's one measured pacing-sensitive failure mode is
// rate-limiting (150ms pacing lost 3/93 tooltips, 700ms lost 0, measured 2026-09-10 —
// scripts/scrape-mistral-status.mjs). Dispatching on every `*/5` tick (12x/hour) would multiply
// request volume against exactly the throttling the pacing exists to avoid, for a job whose own
// 12min timeout already fits several runs inside one hour. cooldownS (55min) is chosen to land
// roughly once an hour; a dispatch can only actually occur on the worker's own `*/5` tick, and this
// value sits exactly on a tick boundary (3300s = 11 × 300s) rather than clear of one, so do not derive
// a precise realized interval or write-count from it — that boundary makes the actual cadence a
// function of intra-cycle timing this file doesn't control, not of this constant alone.
//
// failCooldownS matches cooldownS, not a longer back-off like DeepSeek's: 55min is already the target
// interval here, not a back-off from a shorter one the way DeepSeek's 900s is from its 240s, so there
// is no shorter interval to fall back toward. Backing off further on a failure would only reduce how
// many attempts land inside `MISTRAL_FEED_TTL_S` (3h, parsers/rootly.ts) for no offsetting benefit.
export const MISTRAL_DISPATCH_CONFIG: WorkflowDispatchConfig = {
  workflowFile: 'mistral-feed.yml',
  cooldownKey: 'mistral:dispatch:cooldown',
  cooldownS: 55 * 60,
  failCooldownS: 55 * 60,
}

interface DispatchEnv {
  GH_DISPATCH_TOKEN?: string
  STATUS_CACHE: KVNamespace
}

/**
 * Dispatch the configured workflow if outside its cooldown window. No-op (silently) when the token
 * isn't configured. Never throws — a dispatch failure must not break the rest of the cron.
 */
export async function maybeDispatchWorkflow(env: DispatchEnv, config: WorkflowDispatchConfig): Promise<void> {
  if (!env.GH_DISPATCH_TOKEN || !env.STATUS_CACHE) return
  const inCooldown = await env.STATUS_CACHE.get(config.cooldownKey).catch(() => null)
  if (inCooldown) return

  const { url, init } = buildWorkflowDispatchRequest(env.GH_DISPATCH_TOKEN, config.workflowFile)
  try {
    const res = await fetch(url, init)
    res.body?.cancel?.()
    if (res.status === 204) {
      await env.STATUS_CACHE.put(config.cooldownKey, '1', { expirationTtl: config.cooldownS }).catch(() => undefined)
    } else {
      console.warn(`[workflow-dispatch] ${config.workflowFile} workflow_dispatch returned HTTP ${res.status}`)
      await env.STATUS_CACHE.put(config.cooldownKey, '1', { expirationTtl: config.failCooldownS }).catch(() => undefined)
    }
  } catch (err) {
    // #1395 — set the fail-cooldown on this path too (previously unset, for both consumers): left
    // unset, a throwing fetch makes every */5 tick re-attempt until it stops throwing. Applied
    // uniformly to both configs, same as the non-204 branch above, rather than special-casing one.
    console.warn(`[workflow-dispatch] ${config.workflowFile} dispatch failed:`, err instanceof Error ? err.message : err)
    await env.STATUS_CACHE.put(config.cooldownKey, '1', { expirationTtl: config.failCooldownS }).catch(() => undefined)
  }
}
