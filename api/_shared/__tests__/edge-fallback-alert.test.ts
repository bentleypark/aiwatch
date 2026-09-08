import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { classifyAlertConfig } from '../edge-fallback-alert'

// #1368 — the #378 Edge SSR fallback alert never fired in production because the production
// `EDGE_ALERT_TOKEN` was empty and the guard (`if (!token) return`) treated that identically to the
// correctly-absent local/preview case: no request, no log, nothing to notice for four months.
//
// These tests are written in BOTH directions on purpose (`feedback_mutation_test_both_directions`).
// A suite that only asserted "production + no token → diagnostic" passes on code that is loud in
// EVERY environment — i.e. with the distinction collapsed, which is the thing being built. And a
// suite that only asserted the non-production branch passes on the buggy code that shipped, which
// took that branch everywhere. Each direction is pinned separately.
//
// The wiring block below drives the REAL exported `notifyEdgeFallback`, not a local re-implementation
// of its logic (`debugging_fix_the_called_path_not_the_tested_twin`): the pure classifier being green
// says nothing about whether the shipped function consults it.

const PROD_WORKER = 'https://aiwatch-worker.p2c2kbf.workers.dev'
const ALERT: { surface: string; slug: string; reason: string } =
  { surface: 'is-down', slug: 'claude-api', reason: 'worker_timeout' }

describe('classifyAlertConfig (#1368)', () => {
  it('dispatches whenever a token is present, in any environment', () => {
    expect(classifyAlertConfig('tok', 'production')).toBe('send')
    expect(classifyAlertConfig('tok', 'preview')).toBe('send')
    expect(classifyAlertConfig('tok', undefined)).toBe('send')
  })

  it('calls an EMPTY production token a misconfiguration — the state that actually occurred', () => {
    // The bug was not an absent variable — Vercel held `EDGE_ALERT_TOKEN=""`. Observed 2026-09-08:
    // `vercel env ls` (CLI v50) rendered it `Encrypted`, indistinguishable from a real value, so the
    // listing looked correct. That is third-party CLI behaviour and may change; the durable part is
    // that the value had to be pulled and measured, not listed.
    expect(classifyAlertConfig('', 'production')).toBe('misconfigured')
  })

  it('also calls an absent production token a misconfiguration', () => {
    expect(classifyAlertConfig(undefined, 'production')).toBe('misconfigured')
  })

  it('treats a whitespace-only token as absent — it is truthy, and would dispatch `Bearer `', () => {
    // Same misconfiguration CLASS as the empty string that caused #1368 (a paste into `vercel env
    // add`), but it survives a bare truthiness check and produces a Worker 401 instead of a log.
    expect(classifyAlertConfig(' ', 'production')).toBe('misconfigured')
    expect(classifyAlertConfig('\n', 'production')).toBe('misconfigured')
    expect(classifyAlertConfig(' ', 'preview')).toBe('skip-nonprod')
  })

  it('classifies a missing token outside production as an ordinary skip, not a misconfiguration', () => {
    // This direction matters: classifying every environment as misconfigured would report a defect on
    // every local run and preview deploy.
    expect(classifyAlertConfig('', 'preview')).toBe('skip-nonprod')
    expect(classifyAlertConfig('', 'development')).toBe('skip-nonprod')
    expect(classifyAlertConfig(undefined, undefined)).toBe('skip-nonprod')
  })
})

describe('notifyEdgeFallback wiring (#1368)', () => {
  const originalProcess = (globalThis as { process?: unknown }).process
  let fetchSpy: ReturnType<typeof vi.fn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  /** Fresh module per test: the misconfiguration log is deduped per isolate via module state, so a
   *  shared instance would let the first test's log suppress every later assertion. */
  const freshNotify = async () => {
    vi.resetModules()
    return (await import('../edge-fallback-alert')).notifyEdgeFallback
  }

  const setEnv = (env: Record<string, string | undefined>) => {
    ;(globalThis as { process?: unknown }).process = { env }
  }

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    ;(globalThis as { process?: unknown }).process = originalProcess
  })

  it('logs an error and issues NO request when the production token is empty', async () => {
    setEnv({ EDGE_ALERT_TOKEN: '', VERCEL_ENV: 'production' })
    const notify = await freshNotify()

    await notify(PROD_WORKER, ALERT, 'is-down/claude-api')

    // The defect in one assertion: this is the call that used to produce nothing at all.
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0][0])).toContain('EDGE_ALERT_TOKEN')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('warns rather than errors outside production, and issues no request', async () => {
    setEnv({ EDGE_ALERT_TOKEN: '', VERCEL_ENV: 'preview' })
    const notify = await freshNotify()

    await notify(PROD_WORKER, ALERT, 'is-down/claude-api')

    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('names the environment it observed, so an UNREADABLE VERCEL_ENV is visible', async () => {
    // Without this the fix inherits the bug's failure mode: production selection depends on
    // VERCEL_ENV, and if that were unreadable at runtime the verdict falls to the non-production
    // branch — silence again, from a different cause, and indistinguishable from a correct skip.
    setEnv({ EDGE_ALERT_TOKEN: '' })
    const notify = await freshNotify()

    await notify(PROD_WORKER, ALERT, 'is-down/claude-api')

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('VERCEL_ENV=<unset>')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('POSTs the alert to the Worker with the bearer token when configured', async () => {
    setEnv({ EDGE_ALERT_TOKEN: 'real-token', VERCEL_ENV: 'production' })
    const notify = await freshNotify()

    await notify(PROD_WORKER, ALERT, 'is-down/claude-api')

    expect(errorSpy).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${PROD_WORKER}/api/internal/edge-fallback`)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer real-token')
    // The Worker requires `surface` and `slug` (400s without them) and keys its dedup on the pair.
    expect(JSON.parse(String(init.body))).toEqual(ALERT)
  })

  it('uses the base URL it is GIVEN, so each surface keeps its own pinned WORKER_API (#1268)', async () => {
    setEnv({ EDGE_ALERT_TOKEN: 'real-token', VERCEL_ENV: 'production' })
    const notify = await freshNotify()

    await notify('https://example.invalid', ALERT, 'api/reports')

    expect(fetchSpy.mock.calls[0][0]).toBe('https://example.invalid/api/internal/edge-fallback')
  })

  it('deduplicates the misconfiguration log per isolate', async () => {
    setEnv({ EDGE_ALERT_TOKEN: '', VERCEL_ENV: 'production' })
    const notify = await freshNotify()

    await notify(PROD_WORKER, ALERT, 'is-down/claude-api')
    await notify(PROD_WORKER, ALERT, 'is-down/openai-api')

    // A large outage produces many fallback renders; the alarm-is-broken line is one fact, not N.
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0][0])).toContain('VERCEL_ENV=production')
  })

  it('reports a Worker REJECTION — a 401 must not read like a delivered alert', async () => {
    // The nearest neighbour of #1368's own bug. The Worker answers 401 when its copy of the secret is
    // absent or disagrees with ours, and 400 on a payload it cannot use — it RETURNS those, it does
    // not throw, so the catch below never sees them. Discarding the resolved Response would leave
    // "the two ends disagree" exactly as silent as the empty token was, on the failure the remedy
    // (rotate the secret on BOTH ends) is most likely to produce.
    setEnv({ EDGE_ALERT_TOKEN: 'stale-token', VERCEL_ENV: 'production' })
    fetchSpy.mockResolvedValue(new Response('{"ok":false,"error":"unauthorized"}', { status: 401 }))
    const notify = await freshNotify()

    await notify(PROD_WORKER, ALERT, 'is-down/claude-api')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0][0])).toContain('401')
  })

  it('reports every rejected dispatch, not just the first — each is a distinct lost alert', async () => {
    setEnv({ EDGE_ALERT_TOKEN: 'stale-token', VERCEL_ENV: 'production' })
    fetchSpy.mockResolvedValue(new Response(null, { status: 401 }))
    const notify = await freshNotify()

    await notify(PROD_WORKER, ALERT, 'is-down/claude-api')
    await notify(PROD_WORKER, ALERT, 'is-down/openai-api')

    // Unlike the no-token verdicts, these are per-event: two fallbacks lost two alerts.
    expect(errorSpy).toHaveBeenCalledTimes(2)
  })

  it('reports every thrown dispatch per event, and names err.name', async () => {
    // Extending the per-verdict dedup over the catch block would otherwise pass. `err.name` is what
    // separates a TimeoutError from a TypeError; the message text alone is runtime-dependent.
    setEnv({ EDGE_ALERT_TOKEN: 'real-token', VERCEL_ENV: 'production' })
    fetchSpy.mockRejectedValue(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }))
    const notify = await freshNotify()

    await notify(PROD_WORKER, ALERT, 'is-down/claude-api')
    await notify(PROD_WORKER, ALERT, 'is-down/openai-api')

    expect(warnSpy).toHaveBeenCalledTimes(2)
    expect(String(warnSpy.mock.calls[0][0])).toContain('TimeoutError')
  })

  it('bounds the dispatch with a timeout signal — it is awaited before the user-facing render', async () => {
    // The single user-impacting property of this module: both call sites await it before responding,
    // so an unbounded fetch to an unhealthy Worker hangs the degraded render. Dropping `signal:` in a
    // refactor is otherwise invisible in CI and in production alike.
    setEnv({ EDGE_ALERT_TOKEN: 'real-token', VERCEL_ENV: 'production' })
    const notify = await freshNotify()

    await notify(PROD_WORKER, ALERT, 'is-down/claude-api')

    const init = fetchSpy.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('a first non-production warn does not suppress a later production error', async () => {
    // The dedup flag is keyed by VERDICT, not by "a line was emitted". A single flag would let a warn
    // swallow an error for the life of the isolate — this module's own defect class, one level down.
    setEnv({ EDGE_ALERT_TOKEN: '', VERCEL_ENV: 'preview' })
    const notify = await freshNotify()
    await notify(PROD_WORKER, ALERT, 'is-down/claude-api')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).not.toHaveBeenCalled()

    setEnv({ EDGE_ALERT_TOKEN: '', VERCEL_ENV: 'production' })
    await notify(PROD_WORKER, ALERT, 'is-down/claude-api')
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('reports a dispatch failure without throwing — a broken alert never breaks the render', async () => {
    setEnv({ EDGE_ALERT_TOKEN: 'real-token', VERCEL_ENV: 'production' })
    fetchSpy.mockRejectedValue(new Error('TimeoutError'))
    const notify = await freshNotify()

    await expect(notify(PROD_WORKER, ALERT, 'is-down/claude-api')).resolves.toBeUndefined()

    // warn, not error: attempted-and-failed is a different fact from never-attempted, and collapsing
    // the two is precisely the defect this module was extracted to fix.
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('tolerates a runtime with no `process` global at all, without throwing', async () => {
    delete (globalThis as { process?: unknown }).process
    const notify = await freshNotify()

    await expect(notify(PROD_WORKER, ALERT, 'is-down/claude-api')).resolves.toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
    // Positive assertion, deliberately: for a fix whose thesis is that silence is never an acceptable
    // answer, a hostile runtime is the branch that most needs to still say something. Asserting only
    // absence would pass on a refactor that treats "no `process`" as "nothing to report".
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('VERCEL_ENV=<unset>')
  })
})
