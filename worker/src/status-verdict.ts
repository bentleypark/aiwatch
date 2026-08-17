// #1233 — the ONE place a raw `ServiceStatus.status` is turned into the answers surfaces actually ask.
//
// Before this module the union was three values and every consumer asked its own question inline —
// almost always `svc.status !== 'operational'`, which silently means "affected". That was correct while
// the union had no fourth value; the moment `unknown` ("we could not read this source", #714/#1004)
// arrived, every one of those sites started publishing a false outage. `/is-claude-down` rendered
// "Degraded Performance" for all three Anthropic surfaces and the extension recommended switching to
// ChatGPT — off a status page we could not read (verified in production 2026-08-14).
//
// Widening the union does NOT surface those sites: TypeScript only errors when a member is REMOVED
// (`TS2367`, no-overlap) or assigned into something narrower, so adding `'unknown'` type-checks clean
// across the whole worker. Measured on this branch before the refactor, and the reason the whole design
// is shaped this way: `+ 'unknown'` → 0 errors, a nonsense `+ 'SENTINEL_MUTATION'` → 0 errors, while
// REMOVING `'degraded'` → 202 (30 in production source, 172 in test files). This is the one place that
// measurement is recorded; other files point here rather than restating a number that would rot.
//
// So the comparison sites had to be enumerated by hand once, and the durable guard has to be this
// switch: routing the question through `statusVerdict` puts a `never` check in the path, so the NEXT
// member added to the union fails compilation here. Note what that buys and what it does not — it
// announces that a member was added; it does not enumerate the consumers, which still need the same
// hand pass. The tests named in `worker/src/__tests__/unknown-not-an-outage.test.ts` are what actually
// hold the surfaces.
//
// The exhaustiveness only has teeth inside `worker/src/**` — the scope of the `typecheck:worker` gate
// (`worker/tsconfig.typecheck.json`); a few `api/_is-down/*` helpers enter transitively via worker
// imports, and `src/**` is plain JS. The Edge SSR pages do NOT import this module: `api/` and `worker/`
// are separate deploy targets and this repo imports only api → worker, never the reverse. They hand-copy
// the rule, and their guard is their own tests, not the compiler.

import type { ServiceStatus } from './types'

export type ServiceStatusValue = ServiceStatus['status']

/** The three questions every surface asks, answered together so they can never disagree.
 *  Exactly one of `affected` / `healthy` / `unreadable` is true. */
export interface StatusVerdict {
  /** An outage AIWatch can vouch for. Gates alerts, fallback recommendations, "N services affected"
   *  counts, the is-down "Yes" answer — anything that tells a user something is wrong. */
  affected: boolean
  /** AIWatch can vouch the service is UP. Gates "all systems operational" counts and the is-down "No". */
  healthy: boolean
  /** AIWatch could not read the source, so it can claim NEITHER. Renders as the neutral badge and is
   *  counted in neither tally — the state that has to be visible rather than defaulted away. */
  unreadable: boolean
}

const AFFECTED: StatusVerdict = { affected: true, healthy: false, unreadable: false }
const HEALTHY: StatusVerdict = { affected: false, healthy: true, unreadable: false }
const UNREADABLE: StatusVerdict = { affected: false, healthy: false, unreadable: true }

export function statusVerdict(status: ServiceStatusValue): StatusVerdict {
  switch (status) {
    case 'operational':
      return HEALTHY
    case 'degraded':
    case 'down':
      return AFFECTED
    case 'unknown':
      return UNREADABLE
    default: {
      // Compile time: a new union member lands here as a non-`never` and fails `typecheck:worker`,
      // which is the whole point of routing every consumer through this function.
      const exhaustive: never = status
      // Run time: NOT a throw. This also runs against KV payloads written by an older deploy (and, on
      // the Edge, by a worker version we do not control the rollout of), so an unrecognised value must
      // degrade to the honest neutral answer rather than crash a page. Failing to `unreadable` also
      // fails SAFE in both directions: it never invents an outage, and never claims health.
      console.warn('[status-verdict] unrecognised service status, treating as unreadable:', exhaustive)
      return UNREADABLE
    }
  }
}

/** Is this an outage AIWatch can vouch for? The replacement for `status !== 'operational'`. */
export function isAffectedStatus(status: ServiceStatusValue): boolean {
  return statusVerdict(status).affected
}

/** Can AIWatch vouch this service is up? NOT the negation of `isAffectedStatus` — `unknown` is false
 *  for both, which is the distinction the old two-valued reading collapsed. */
export function isHealthyStatus(status: ServiceStatusValue): boolean {
  return statusVerdict(status).healthy
}

/** Could AIWatch not read the source? */
export function isUnreadableStatus(status: ServiceStatusValue): boolean {
  return statusVerdict(status).unreadable
}

/** Boundary coercion for a call site whose status field is still typed as a bare `string`
 *  (`FallbackCandidate.status`; a value parsed from a KV payload). Deliberately the ONLY cast: routing
 *  them through here keeps the assertion in one auditable place instead of scattering `as` across
 *  callers, and it is safe because `statusVerdict`'s `default` branch handles an unrecognised value by
 *  answering `unreadable` rather than trusting the cast. Prefer narrowing the source type where the
 *  fixture cost allows — this exists for where it does not. */
export function asServiceStatus(value: string): ServiceStatusValue {
  return value as ServiceStatusValue
}

/** #1233 transitional — normalise a service record read back from a payload that may predate this
 *  refactor. Returns the record, not the status: an earlier cut returned a bare status the caller had
 *  to remember to re-attach, which is the same "every consumer must apply the correction" shape this
 *  refactor exists to delete.
 *
 *  A cached `/api/status` body written by the previous worker encodes an unreadable source as
 *  `degraded` + `sourceUnknown`, the very pair this refactor replaced. Without a decode, a legacy
 *  payload renders as a real outage for the life of those cache entries.
 *
 *  Apply it wherever a stored payload re-enters the worker and its `status` is then read.
 *
 *  No list of those places is kept here, deliberately. Two drafts of this docstring tried: the first
 *  named "the two points" and missed `cronAlertCheck`; the second said the direct `CACHE_KEY` readers
 *  each applied it themselves, and they did not. Both were wrong in the same way — an enumeration of
 *  call sites in prose that nothing checks, which then became the premise for believing a path was
 *  covered. `grep` answers the question accurately and this file cannot.
 *
 *  A payload written by the current worker already carries `unknown`, so this is a no-op on it, which is
 *  why it stays permanently rather than being a dated cleanup nobody removes. The `probeContradicted` guard is the same one the
 *  old display rule applied: a fetch-failure `degraded` that our own probe independently corroborates is
 *  a REAL outage and must stay `degraded`. */
export function normalizeCachedService<T extends Pick<ServiceStatus, 'status' | 'sourceUnknown' | 'probeContradicted'>>(svc: T): T {
  if (svc.status === 'degraded' && svc.sourceUnknown && !svc.probeContradicted) return { ...svc, status: 'unknown' }
  return svc
}

/** List form — the shape both call sites actually need. Returns the SAME array reference when nothing
 *  was legacy, so the common (post-rollout) path allocates nothing. */
export function normalizeCachedServices<T extends Pick<ServiceStatus, 'status' | 'sourceUnknown' | 'probeContradicted'>>(list: T[]): T[] {
  let changed = false
  const out = list.map((svc) => {
    const next = normalizeCachedService(svc)
    if (next !== svc) changed = true
    return next
  })
  return changed ? out : list
}
