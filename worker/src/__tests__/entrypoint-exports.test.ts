import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as entrypoint from '../index'

// #1264 — a NAMED export of the Worker entry module must not be a plain value. Export one and
// `wrangler dev`'s local runtime refuses to start the module at all:
//
//   service core:user:aiwatch-worker: Uncaught TypeError: Incorrect type for map entry
//   'HISTORY_RETENTION_DAYS': the provided value is not of type 'function or ExportedHandler'.
//
// **This is the second time.** #416 hit it, fixed it, and wrote the rule down in
// `worker/src/edge-fallback-alert-keys.ts` — including the part not re-verified here, that
// `wrangler deploy` tolerates a value export while `dev` does not. That comment sits in the same
// directory and still says "if you add another shared constant for index.ts, put it in a module like
// this rather than exporting it from index.ts". It was written, and #1259 re-broke it anyway on
// 2026-08-20. A rule that lives only in prose gets probabilistic compliance (#415); this file is the
// deterministic version.
//
// It went in green because no worker gate started the runtime: vitest imports the module directly,
// `tsc` finds `export const N = 90` perfectly well-typed, and `wrangler deploy --dry-run` only
// bundles with esbuild. This test closes the inspection-checkable half of that gap — it still starts
// no runtime, so it can only catch shapes the predicate below knows about.
//
// The fix for a new constant is to give it a home outside the entrypoint and import it — NOT to
// widen this guard.

/**
 * Handler methods that make a plain object handler-shaped rather than a bare value.
 *
 * HEURISTIC, and deliberately labelled as one. #1264 observed only what workerd REJECTS (a bare
 * number); nothing here establishes what it ACCEPTS. This is a hand-written mirror of an external,
 * rotating Cloudflare surface as of 2026-08, so a named export that satisfies it has still never
 * been runtime-tested. Erring toward accepting is the safe direction for a guard whose purpose is
 * catching bare values.
 */
const HANDLER_METHODS = ['fetch', 'scheduled', 'queue', 'email', 'tail', 'trace'] as const

function isLegalEntrypointExport(value: unknown): boolean {
  if (typeof value === 'function') return true
  if (typeof value !== 'object' || value === null) return false
  return HANDLER_METHODS.some((m) => typeof (value as Record<string, unknown>)[m] === 'function')
}

describe('Worker entrypoint exports (#1264)', () => {
  it('every NAMED export of index.ts is a function or an ExportedHandler', () => {
    const offenders = Object.entries(entrypoint)
      // `default` IS the ExportedHandler and is exempt from the named-export rule; it gets its own
      // assertion below. Widening this filter is how the guard would be silently defeated, which is
      // why the next test re-derives the same answer without sharing this chain.
      .filter(([name]) => name !== 'default')
      .filter(([, value]) => !isLegalEntrypointExport(value))
      .map(([name, value]) => `${name} (${typeof value})`)

    expect(
      offenders,
      'Non-function named exports from worker/src/index.ts stop the entry module starting (#1264). '
      + 'Move the value to another module and import it — do not widen this guard.',
    ).toEqual([])
  })

  it('re-derives the same verdict independently, so exempting a name cannot hide a real offender', () => {
    // NOT redundant with the test above, and removing it has been tried: with only that one check,
    // appending `&& name !== 'HISTORY_RETENTION_DAYS'` to its filter chain makes the whole suite pass
    // with the real #1264 defect sitting in index.ts. Two checks that share no filter mean silencing
    // the guard takes two deliberate edits in two places, not one.
    //
    // The length floor is the other half: without it, an import resolving to `{}` would satisfy both
    // offender checks vacuously. The entrypoint has carried 9+ named exports since #533 (9 at
    // 974628c, 14 today); 5 is a floor, not a pin on the current count.
    const named = Object.keys(entrypoint).filter((n) => n !== 'default')
    expect(named.length, 'export map looks empty — is the import resolving?').toBeGreaterThan(5)

    const illegal = named.filter((n) => !isLegalEntrypointExport((entrypoint as Record<string, unknown>)[n]))
    expect(illegal, 'named exports of index.ts that are not function-or-handler (#1264)').toEqual([])
  })

  it('guards the module wrangler.toml actually declares as `main`', () => {
    // The import above hardcodes `../index`. Nothing else ties it to the real entrypoint, so moving
    // or renaming `main` would leave this suite green while inspecting a module workerd never treats
    // as an entry — the same green-while-broken shape #1264 itself had. Read from disk, like the
    // other wiring pins in this directory.
    const wrangler = readFileSync(join(__dirname, '..', '..', 'wrangler.toml'), 'utf8')
    expect(wrangler, 'this suite inspects ../index; keep it in step with wrangler.toml `main`')
      .toMatch(/^main\s*=\s*"src\/index\.ts"/m)
  })

  it('the default export is the ExportedHandler the runtime actually dispatches on', () => {
    expect(isLegalEntrypointExport(entrypoint.default)).toBe(true)
    expect(typeof entrypoint.default.fetch).toBe('function')
    expect(typeof entrypoint.default.scheduled).toBe('function')
  })

  it('the predicate rejects bare values and passes function/handler shapes', () => {
    // The two tests above already run this predicate over the REAL index.ts namespace; this adds a
    // both-directions check on the predicate itself, so widening it (`typeof value === 'number'` →
    // true) fails here even while the entrypoint happens to be clean. The reject
    // cases are the observed ones; the accept cases state OUR rule, not a measured workerd contract
    // (see HANDLER_METHODS above) — erring toward accepting keeps a false CI red off shapes nobody
    // has tested, while still catching the bare value that actually broke startup.
    expect(isLegalEntrypointExport(90), 'a bare number is what broke #1264').toBe(false)
    expect(isLegalEntrypointExport('90')).toBe(false)
    expect(isLegalEntrypointExport({ days: 90 }), 'we refuse an object with no handler method').toBe(false)
    expect(isLegalEntrypointExport(['a', 'b']), 'an exported roster array is a likelier future slip').toBe(false)
    expect(isLegalEntrypointExport(new Map()), 'and so is a lookup table').toBe(false)
    expect(isLegalEntrypointExport(null)).toBe(false)
    expect(isLegalEntrypointExport(undefined)).toBe(false)
    expect(isLegalEntrypointExport(() => {}), 'a function is legal').toBe(true)
    expect(isLegalEntrypointExport(class Durable {}), 'a class is a function').toBe(true)
    expect(isLegalEntrypointExport({ fetch: () => {} }), 'a handler-shaped object passes').toBe(true)
  })
})
