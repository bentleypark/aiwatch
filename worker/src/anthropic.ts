// Shared Anthropic Messages API client (via the Cloudflare AI Gateway).
//
// #955 — SINGLE SOURCE OF TRUTH for the model id + request shape. Before this module,
// `ai-analysis.ts` and `monthly-narrative.ts` each hardcoded `claude-sonnet-4-20250514`
// (pinned in #21, 2026-03-26). That id reached its retirement date on 2026-06-15 and
// began returning 404, which both call sites swallowed into a bare `return null` — so
// the Sonnet fallback was dead for weeks with zero Sonnet successes in `ai:usage` and
// nothing in the logs. Keep the model here; never re-inline it.
//
// AIWatch calls the Messages REST API with raw `fetch()` (no @anthropic-ai/sdk), so this
// is the REST wire shape, not an SDK client.

/** Cloudflare AI Gateway route for the Anthropic API. */
export const AI_GATEWAY_ANTHROPIC_URL =
  'https://gateway.ai.cloudflare.com/v1/11485987aa7d4639df5ba09d671b5615/aiwatch/anthropic/v1/messages'

/**
 * Fallback model for the Gemma→Claude hybrid.
 *
 * `claude-sonnet-4-20250514` retired 2026-06-15. Sonnet 5 is the like-for-like successor
 * (same $3/$15 sticker), but it is NOT a bare string swap — see `anthropicRequestBody`.
 */
export const ANTHROPIC_MODEL = 'claude-sonnet-5'

export const ANTHROPIC_VERSION = '2023-06-01'

/** Per-attempt wall-clock cap. The caller's outer budget still wins if it is shorter. */
export const ANTHROPIC_TIMEOUT_MS = 10_000

/** Upper bound on an honoured `retry-after`. We run inside a cron with a finite budget. */
export const RETRY_AFTER_CAP_MS = 2_000

/** Backoff for a transient failure that carried no usable `retry-after`. */
export const TRANSIENT_BACKOFF_MS = 500

/**
 * Outcome of one logical Anthropic call (including its retries).
 *
 * The `permanent` / `transient` split is the whole point: before #955 every non-2xx
 * collapsed to `null`, so a retired-model 404 (retrying can never help) was indistinguishable
 * from a 529 overload (retrying is exactly the right move). Callers use this to decide both
 * whether to retry now and how long to lock the incident out of re-analysis.
 */
export type AnthropicOutcome =
  | { kind: 'ok'; text: string }
  | { kind: 'permanent'; status: number; detail: string }
  | { kind: 'transient'; status: number | null; detail: string }
  | { kind: 'aborted'; reason: 'budget' | 'timeout' }

export interface AnthropicCallOptions {
  system: string
  user: string
  maxTokens: number
  /** Outer budget from the caller. When it aborts, we stop retrying and return `aborted`. */
  signal?: AbortSignal
  timeoutMs?: number
  /** Extra attempts after the first. Default 1 (so: one call, one retry). */
  retries?: number
  logPrefix?: string
  // Seams for unit tests — production callers never pass these.
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * Which HTTP statuses are worth retrying.
 *
 * 408 (timeout), 429 (rate limit) and every 5xx are transient. Everything else in the 4xx
 * range is a permanent request-level problem — a bad model id (404), a revoked key (401),
 * an unsupported parameter (400). Retrying those just burns the cron budget.
 */
export function classifyAnthropicStatus(status: number): 'permanent' | 'transient' {
  if (status === 408 || status === 429 || status >= 500) return 'transient'
  return 'permanent'
}

/**
 * Parse a `retry-after` header into milliseconds, clamped to `capMs`.
 *
 * Anthropic sends delta-seconds. The HTTP-date form is legal but we deliberately ignore it:
 * a date implies a wait far longer than a cron cycle, so falling back to our own short
 * backoff (and letting the next cycle retry) is strictly better than blocking.
 */
export function parseRetryAfterMs(header: string | null, capMs = RETRY_AFTER_CAP_MS): number | null {
  if (!header) return null
  const seconds = Number(header.trim())
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return Math.min(seconds * 1000, capMs)
}

/**
 * The exact Messages API request body.
 *
 * `thinking: {type: 'disabled'}` is deliberate. Sonnet 4 ran with thinking off when `thinking`
 * was omitted; on Sonnet 5 the same omission selects ADAPTIVE thinking, where the model decides
 * per request whether to think. Thinking tokens come out of `max_tokens`, so on a complex
 * incident an adaptive run could spend the budget reasoning and return a truncated JSON body.
 *
 * Measured, so nobody mistakes this for a repair of an observed bug: against a representative
 * incident prompt at `max_tokens: 600`, Sonnet 5 emitted NO thinking block either way and both
 * responses parsed (134 vs 149 output tokens, 2026-07-09). Disabling thinking is a guard that
 * makes the output budget deterministic, not a fix. Pinned by `anthropic.test.ts`.
 */
export function anthropicRequestBody(system: string, user: string, maxTokens: number): Record<string, unknown> {
  return {
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    thinking: { type: 'disabled' },
    system,
    messages: [{ role: 'user', content: user }],
  }
}

/** Sleep that rejects as soon as `signal` aborts, so a retry wait cannot outlive the budget. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Compose the caller's outer budget with a per-attempt timeout into one signal.
 *
 * Hand-rolled rather than `AbortSignal.any` + `AbortSignal.timeout` so we can tell the two
 * apart afterwards (`timedOut()`): a budget abort means "the caller gave up on us", a timeout
 * means "this attempt was too slow" — only the latter is worth another attempt.
 */
function linkSignals(outer: AbortSignal | undefined, timeoutMs: number) {
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, timeoutMs)
  const onAbort = () => ctrl.abort()
  if (outer) {
    if (outer.aborted) ctrl.abort()
    else outer.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: ctrl.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * Call the Anthropic Messages API once, retrying transient failures.
 *
 * NEVER THROWS — every failure is reported as a typed `AnthropicOutcome`, because the two
 * production callers both sit on paths (cron alerting, monthly archive) where an exception
 * would take down work unrelated to the analysis.
 */
export async function callAnthropicMessages(
  apiKey: string,
  opts: AnthropicCallOptions,
): Promise<AnthropicOutcome> {
  const {
    system, user, maxTokens, signal,
    timeoutMs = ANTHROPIC_TIMEOUT_MS,
    retries = 1,
    logPrefix = '[anthropic]',
    fetchImpl = fetch,
    sleepImpl = sleep,
  } = opts

  const body = JSON.stringify(anthropicRequestBody(system, user, maxTokens))

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) return { kind: 'aborted', reason: 'budget' }

    const link = linkSignals(signal, timeoutMs)

    try {
      const res = await fetchImpl(AI_GATEWAY_ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body,
        signal: link.signal,
      })

      if (res.ok) {
        const data = await res.json().catch(() => null) as { content?: Array<{ type: string; text?: string }> } | null
        const text = data?.content?.find(c => c.type === 'text')?.text
        if (text) return { kind: 'ok', text }
        // A 200 with no text block means the model spent its budget elsewhere (thinking,
        // truncation). Retrying the identical prompt would reproduce it.
        const detail = 'no text block in response'
        console.error(`${logPrefix} ${ANTHROPIC_MODEL} 200 but ${detail}`)
        return { kind: 'permanent', status: 200, detail }
      }

      const detail = (await res.text().catch(() => '')).slice(0, 300)
      const cls = classifyAnthropicStatus(res.status)
      console.error(`${logPrefix} ${ANTHROPIC_MODEL} returned ${res.status} (${cls}): ${detail}`)
      if (cls === 'permanent') return { kind: 'permanent', status: res.status, detail }
      if (attempt === retries) return { kind: 'transient', status: res.status, detail }
      const waitMs = parseRetryAfterMs(res.headers.get('retry-after')) ?? TRANSIENT_BACKOFF_MS
      await sleepImpl(waitMs, signal)
    } catch (err) {
      // Outer budget wins over everything: never retry once the caller has given up.
      if (signal?.aborted) return { kind: 'aborted', reason: 'budget' }
      if (link.timedOut()) {
        if (attempt === retries) return { kind: 'aborted', reason: 'timeout' }
        console.warn(`${logPrefix} ${ANTHROPIC_MODEL} attempt ${attempt} timed out after ${timeoutMs}ms, retrying`)
        continue
      }
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`${logPrefix} ${ANTHROPIC_MODEL} network error: ${detail}`)
      if (attempt === retries) return { kind: 'transient', status: null, detail }
      try {
        await sleepImpl(TRANSIENT_BACKOFF_MS, signal)
      } catch {
        return { kind: 'aborted', reason: 'budget' }
      }
    } finally {
      link.dispose()
    }
  }

  // Unreachable: the loop always returns on its final iteration.
  return { kind: 'transient', status: null, detail: 'retries exhausted' }
}
