// #378 / #1368 — the operator Discord alert an Edge SSR surface fires when it serves the degraded
// "Status data is temporarily unavailable" render. The Worker (`POST /api/internal/edge-fallback`)
// dedups on a 5-minute KV cooldown per surface+slug and sends the Discord message; this module is
// only the caller side.
//
// WHY THIS MODULE EXISTS (#1368). `api/is-down.ts` and `api/reports.ts` each carried a near-identical
// copy of the dispatch, and both copies shared one defect: a falsy token returned silently in EVERY
// environment, so a misconfigured production deployment was indistinguishable from a correctly
// unconfigured preview. `classifyAlertConfig` below is that distinction, made explicit and testable.
// The history, its evidence, and what remains open are in `docs/reference/discord-alert-paths.md`.
//
// `api/_shared/` is underscore-prefixed, so this file is a helper and does NOT count against the
// Vercel Hobby 12-Serverless-Function cap (#862/#867).
//
// The Worker base URL is a PARAMETER, deliberately. `api/__tests__/worker-api-constant.test.ts`
// (#1268) asserts that `is-down.ts`, `is-down-group.ts` and `reports.ts` each declare
// `const WORKER_API = '<production host>'` — a guard against a local-verify edit shipping. In
// `reports.ts` this alert is the constant's ONLY consumer, so importing a base URL from here would
// remove its reason to declare one.

/** 500ms. Short enough that a fully-down Worker doesn't compound the user-facing wait, since the
 *  caller awaits this before responding.
 *
 *  ⚠️ The budget was justified against the wrong work (#1368): its original comment sized it for "a
 *  healthy Worker to respond from the same edge region", i.e. a Worker hop. On a dedup MISS the
 *  callee awaits a KV read, then `sendDiscordAlert` — which sets no timeout of its own — then a KV
 *  write, before responding. Whether 500ms suffices is unmeasured, and so is what a timeout costs
 *  (whether the abort cancels the Worker's send or its dedup write). Do not retune it from this note. */
export const ALERT_TIMEOUT_MS = 500

export type AlertConfigVerdict =
  /** A token is present — dispatch. */
  | 'send'
  /** No usable token, and we are in production. This is a deployment defect, not a normal skip. */
  | 'misconfigured'
  /** No usable token, and `VERCEL_ENV` did not say production — which covers local and preview,
   *  where this is ordinary, AND the case where the variable could not be read at all. The two are
   *  separated by the value printed in the log line, not by this verdict. */
  | 'skip-nonprod'

/**
 * The one decision that used to be a bare `if (!token) return`. Split out as a pure function so both
 * verdicts are assertable separately — which half of the suite each mutant kills is worked out in
 * `__tests__/edge-fallback-alert.test.ts`'s header, not restated here.
 *
 * Empty and whitespace-only are both treated as absent: a present-but-blank variable is a
 * misconfiguration, not an opt-out. Without the trim a blank value is truthy, so it would dispatch
 * `Bearer ` and earn a Worker 401 — a response, not a throw, and therefore silent before #1368.
 */
export function classifyAlertConfig(
  token: string | undefined,
  vercelEnv: string | undefined,
): AlertConfigVerdict {
  if (token?.trim()) return 'send'
  return vercelEnv === 'production' ? 'misconfigured' : 'skip-nonprod'
}

/** Optional-chained rather than `process.env.X`, so a runtime without the global yields `undefined`
 *  instead of a throw — a fallback render must never be turned into a hard error by its own alerting. */
function readEnv(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]
}

/** Per-isolate, so a large outage producing many fallback renders logs once per isolate rather than
 *  once per request. Mirrors the `warnedExcludedSlugs` / `warnedMissingSlugs` pattern already used in
 *  `api/is-down.ts`: re-fires on cold start and across the fleet, which is enough visibility without
 *  log volume scaling with request rate.
 *
 *  Keyed BY VERDICT, not by "a line was emitted". A single flag would let a first `skip-nonprod`
 *  warn permanently suppress a later `misconfigured` error in the same isolate — an `error` swallowed
 *  by a `warn`, which is this module's own defect class one level down. It is only reachable if the
 *  environment can change under a live isolate, which on Vercel it does not; keying on the verdict
 *  costs one line and removes the need to reason about that at all.
 *
 *  Only the no-token verdicts are deduped. Both dispatch outcomes below — a non-OK response and a
 *  thrown request — stay per-event, because each is one distinct delivery that did not happen. */
const warnedVerdicts = new Set<AlertConfigVerdict>()

export interface EdgeFallbackAlert {
  /** `'is-down'` | `'reports'` | … — the Worker sanitizes and uses it in the dedup key. */
  surface: string
  /** Service slug, or a sanitized path for a path-based surface. Sanitized Worker-side too. */
  slug: string
  /** Free-form failure class, chosen by the caller. Deliberately not enumerated here: the values are
   *  each caller's own branch labels, so a list in this file would be a copy that drifts. */
  reason: string
}

/**
 * Best-effort notify. Never throws and never rejects: the user-facing fallback render must not be
 * affected by the state of its own alerting.
 *
 * @param workerApi  the caller's own pinned Worker base URL — see the #1268 note at the top.
 * @param logLabel   log prefix identifying the calling surface, e.g. `is-down/claude-api`.
 */
export async function notifyEdgeFallback(
  workerApi: string,
  alert: EdgeFallbackAlert,
  logLabel: string,
): Promise<void> {
  const rawToken = readEnv('EDGE_ALERT_TOKEN')
  const vercelEnv = readEnv('VERCEL_ENV')
  const verdict = classifyAlertConfig(rawToken, vercelEnv)
  // `classifyAlertConfig` takes the RAW value — its job is to judge what the environment holds — and
  // a `send` verdict is the guarantee that this trimmed copy is a non-empty string.
  const token = rawToken?.trim() ?? ''

  if (verdict !== 'send') {
    // Both no-token verdicts log, and each line prints the `VERCEL_ENV` it observed — which is what
    // separates a genuine preview skip from a production deploy whose `VERCEL_ENV` could not be read,
    // since both land here. Deduped per verdict: one line per cold start, not per request.
    if (!warnedVerdicts.has(verdict)) {
      warnedVerdicts.add(verdict)
      const msg = `[${logLabel}] EDGE_ALERT_TOKEN is missing or empty (VERCEL_ENV=${vercelEnv ?? '<unset>'})`
        + ` — the #378 Edge SSR fallback alert cannot fire, so operator Discord stays silent on every`
        + ` fallback render.`
      // error in production (a broken alarm); warn elsewhere, where an absent token is ordinary.
      if (verdict === 'misconfigured') {
        console.error(`${msg} Set it on both Vercel and the Worker and redeploy (refs #1368).`)
      } else {
        console.warn(msg)
      }
    }
    return
  }

  try {
    const res = await fetch(`${workerApi}/api/internal/edge-fallback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    })
    // The Worker RETURNS 401 (its own copy of the secret absent, or disagreeing with ours) and 400
    // (unusable payload) rather than throwing, so the catch below never sees them. Dropping the
    // resolved Response would leave "the two ends disagree" as silent as the empty token was — on the
    // failure a two-sided secret rotation is most likely to produce. Its 401 carries no detail by
    // design, so the caller is the only place it is observable.
    //
    // NOT covered here: the Worker can answer 200 while carrying `dispatched: false` in its body, so
    // an OK response is not proof of delivery. Reading that flag would mean parsing the body of a
    // best-effort alert, and the cases behind it are the Worker's own blind spot — #1257's territory.
    if (!res.ok) {
      console.error(
        `[${logLabel}] edge-fallback alert REJECTED by the Worker (HTTP ${res.status}) — the alert did`
        + ` not reach Discord (refs #1368).`,
      )
    }
    res.body?.cancel().catch(() => undefined)
  } catch (err) {
    // Swallow — the alert is best-effort and the fallback render is unaffected. Unlike the no-token
    // verdicts above, this is reported per event: a dispatch that was attempted and failed is a
    // different fact from one that was never attempted, and conflating the two is the defect this
    // module exists to fix. `err.name` is logged because the message text is runtime-dependent while
    // the name separates a timeout from a transport failure.
    const name = err instanceof Error ? err.name : 'unknown'
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[${logLabel}] edge-fallback alert dispatch failed (${name}): ${message}`)
  }
}
