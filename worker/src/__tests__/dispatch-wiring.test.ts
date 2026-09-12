import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #1395 — the `index.ts` cron-handler seam for the two workflow_dispatch call sites, in the idiom
// `client-poll-wiring.test.ts` / `feed-poll-instrumentation-wiring.test.ts` established.
//
// ALREADY COVERED WITHOUT THIS FILE, and deliberately not re-asserted:
//   - The dispatch/cooldown LOGIC (independent cooldown keys, fail-cooldown on a thrown fetch,
//     per-config cooldown values) is unit-tested against `maybeDispatchWorkflow` directly in
//     `deepseek-dispatch.test.ts`. What that function is CALLED WITH from the actual cron handler is
//     not — see the source scan below.
//
// WHY THE SOURCE SCAN: this is a cron-only side effect with no return value and no observable
// synchronous behavior change — deleting either `ctx.waitUntil(maybeDispatchWorkflow(env, ...))` call
// (with or without the import) still satisfies `tsc` (no `noUnusedLocals`) and stays green on every
// other worker test, since nothing else asserts the scheduled handler dispatches these workflows at
// all. The observable symptom of a silent removal is exactly the failure this issue exists to fix —
// the Mistral (or DeepSeek) feed's KV quietly expiring ~3h later, with no test catching it sooner.
const SRC = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')
// Strip comments so a mutation cannot hide behind a mention of the token it removed.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .map((l) => l.replace(/\s\/\/.*$/, ''))
  .join('\n')

// Scope to the `scheduled` handler only — a call site anywhere else in this large file would not
// actually run on the Worker's */5 cron, which is the whole point of #629/#1395.
const scheduledStart = CODE.indexOf('async scheduled(')
const scheduledEnd = CODE.indexOf('async fetch(', scheduledStart)
const SCHEDULED_BODY = CODE.slice(scheduledStart, scheduledEnd)

describe('#1395 dispatch call-site wiring (scheduled handler)', () => {
  it('the scheduled handler exists where expected (sanity check on the slice above)', () => {
    expect(scheduledStart, 'no async scheduled( found').toBeGreaterThan(-1)
    expect(scheduledEnd, 'no async fetch( found after scheduled(').toBeGreaterThan(scheduledStart)
  })

  it('dispatches DeepSeek from inside the scheduled handler', () => {
    expect(SCHEDULED_BODY).toContain('maybeDispatchWorkflow(env, DEEPSEEK_DISPATCH_CONFIG)')
  })

  it('dispatches Mistral from inside the scheduled handler (#1395 — this is the actual fix)', () => {
    expect(SCHEDULED_BODY).toContain('maybeDispatchWorkflow(env, MISTRAL_DISPATCH_CONFIG)')
  })

  it('both dispatch calls are wrapped in ctx.waitUntil — a bare (un-awaited, un-waited) call would be dropped on isolate teardown', () => {
    const deepseekIdx = SCHEDULED_BODY.indexOf('maybeDispatchWorkflow(env, DEEPSEEK_DISPATCH_CONFIG)')
    const mistralIdx = SCHEDULED_BODY.indexOf('maybeDispatchWorkflow(env, MISTRAL_DISPATCH_CONFIG)')
    const waitUntilBeforeDeepseek = SCHEDULED_BODY.lastIndexOf('ctx.waitUntil(', deepseekIdx)
    const waitUntilBeforeMistral = SCHEDULED_BODY.lastIndexOf('ctx.waitUntil(', mistralIdx)
    expect(waitUntilBeforeDeepseek, 'no ctx.waitUntil( before the DeepSeek dispatch').toBeGreaterThan(-1)
    expect(waitUntilBeforeMistral, 'no ctx.waitUntil( before the Mistral dispatch').toBeGreaterThan(-1)
    // Neither waitUntil should belong to some earlier, unrelated call — the gap should be small
    // (just the wrapping `ctx.waitUntil(\n  maybeDispatchWorkflow(...)` itself).
    expect(deepseekIdx - waitUntilBeforeDeepseek).toBeLessThan(80)
    expect(mistralIdx - waitUntilBeforeMistral).toBeLessThan(80)
  })

  it('the module-level import brings in both configs (a partial import would still let one config-name typo through as a ReferenceError only at runtime)', () => {
    const importLine = CODE.split('\n').find((l) => l.includes("from './deepseek-dispatch'"))
    expect(importLine, 'no import from deepseek-dispatch').toBeTruthy()
    expect(importLine).toContain('DEEPSEEK_DISPATCH_CONFIG')
    expect(importLine).toContain('MISTRAL_DISPATCH_CONFIG')
    expect(importLine).toContain('maybeDispatchWorkflow')
  })
})
