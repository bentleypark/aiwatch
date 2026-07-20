// #1053 — the per-service cross-provider upstream note on an is-down page.
//
// Extracted from is-down.ts (the #574 `supply-chain-note.ts` precedent) so the judgements here are
// unit-testable. The governing one: WHOSE claim are we printing? Always the dependent's own. The page
// says "Cursor's status page attributes this to Claude API", never "Cursor is down because of Claude
// API" — we report what the provider wrote, we do not assert a cause. The worker's gate already
// refuses to emit a link the dependent didn't itself make (`upstream-link.ts`); this keeps the WORDING
// honest to that same standard.

import { SERVICE_ID_TO_SLUG } from './slug-map'

/** The shape is-down reads off `/api/status`'s `upstreamLinks` — a structural subset of the worker's
 *  `UpstreamLink`, only the fields this note needs.
 *
 *  DEPLOY SKEW (the #574 lesson, `supply-chain-note.ts`): Vercel ships this Edge function on merge to
 *  main while the worker deploy is manual and batched (CLAUDE.md), so for hours-to-days a worker that
 *  predates #1053 serves NO `upstreamLinks` key at all. That is why the whole list is optional here and
 *  `buildUpstreamNote` returns null on absence — the page renders no section, which is correct rather
 *  than merely tolerable: with no worker-side gate result there is nothing we could honestly say.
 *
 *  THE RULE, not just this instance: every FIELD here is required precisely because the whole key is
 *  new — an old worker sends nothing at all rather than a partial shape, so a half-populated
 *  `UpstreamLinkLike` cannot exist and modelling one would be superstition. A field ADDED to the
 *  worker's `UpstreamLink` LATER must be optional here, because by then a deployed worker will be
 *  serving the shape without it. That asymmetry is exactly why `supply-chain-note.ts` has
 *  `regions?: string[]` — `affectedNow` shipped in #574 and `regions` was retrofitted in #1000. */
export interface UpstreamLinkLike {
  id: string
  // NOTE the worker's `UpstreamLink` also carries the dependent's `name` and both `incidentId`s; none
  // are declared here, because this page reads none of them (it uses `seo.displayName`, and links by
  // slug, not incident id). Declaring a field the Edge never reads makes the copy look more
  // synchronized than it is — and invites a lockstep test to "pin" a field whose rename could never
  // break anything.
  incidentTitle: string
  startedAt: string
  upstream: Array<{
    id: string; name: string; status: string; incidentTitle: string; startedAt: string
    /** #1072 — the upstream's own public status page, for a NON-CARDED upstream (a GitHub-style feed)
     *  that has no is-down page to link to.
     *
     *  OPTIONAL, and that is the rule stated in this file's header being applied rather than a
     *  judgement call: `statusUrl` was ADDED to the worker's `UpstreamLink` after #1053 shipped, so a
     *  deployed worker serves the shape WITHOUT it — for hours-to-days, since the worker deploy is
     *  manual and batched while Vercel ships this file on merge. Same asymmetry, same reason, as
     *  `supply-chain-note.ts`'s `regions?: string[]` (`affectedNow` shipped in #574 and was required;
     *  `regions` was retrofitted in #1000 and is optional). Absence means "no official link known",
     *  which for a service upstream is the normal, permanent state. */
    statusUrl?: string
  }>
}

export interface UpstreamNoteUpstream {
  id: string
  name: string
  /** the worker emits 'degraded' | 'down' today (its `isImpacted` gate). Typed `string`, not that
   *  union: this is unvalidated wire data behind a structural `as` cast, so a narrow union would be a
   *  guarantee nothing checks — and `statusColor`/`statusLabel` are total over `string` anyway. */
  status: string
  incidentTitle: string
  startedAt: string
  /** Where the reader goes to check this upstream. In priority order:
   *    1. the upstream's AIWatch is-down page (`/is-<slug>-down`) — keeps the reader on the site
   *    2. #1072: the upstream's OWN status page, when it has no is-down page (a non-carded feed)
   *    3. null — no destination at all
   *  Case 3 still occurs: bedrock/azureopenai are services with no is-down page (#263) and no
   *  `statusUrl` on the wire (that field lives on `ServiceConfig`, which never reaches the payload),
   *  so they keep rendering a linkless row. Giving THEM an official link is a separate change. */
  href: string | null
  /** True when `href` leaves AIWatch. Drives `target`/`rel` and splits the GA event's destination —
   *  see `upstreamRow`, whose "this link stays on AIWatch" rationale stops holding once case 2 exists. */
  external: boolean
  /** whole minutes this upstream incident PRECEDED the dependent's claim. Null when either timestamp
   *  is unparseable, OR when the gap is negative — gate 5 emits only an upstream that started first or
   *  simultaneously (it compares with `<=`, so a 0 lead is legal and renders as "less than a minute"),
   *  so a negative means the payload contradicts the gate. Withheld rather than printing a nonsense
   *  "-12m before"; `minutesBetween` warns so the breach is not silent. */
  leadMinutes: number | null
}

export interface UpstreamNote {
  /** the dependent's service id — GA `from_service` on the link */
  fromId: string
  /** the dependent's OWN incident that carries the blame */
  incidentTitle: string
  upstream: UpstreamNoteUpstream[]
}

/**
 * Whole minutes between two ISO stamps, or null.
 *
 * The two null causes look identical to the renderer (the clause is omitted either way) — one
 * representation is right, and a discriminated union would buy the caller nothing. But they are
 * categorically different in KIND, and only one is benign:
 *   - unparseable → missing provider data. Expected, nothing to do, stay quiet.
 *   - negative    → the worker's gate 5 guarantees the upstream started first, so this is a BREACHED
 *                   CONTRACT: a gate-5 regression, a sort inversion, or drifted `startedAt` semantics.
 * Folding a proven bug into the benign path makes it permanently invisible. Log it. Precedent: the
 * caller (api/is-down.ts) tracks `fallbackReason` for exactly this reason — several causes, one
 * render, still distinguished for observability.
 */
function minutesBetween(earlier: string, later: string): number | null {
  const a = Date.parse(earlier)
  const b = Date.parse(later)
  if (Number.isNaN(a) || Number.isNaN(b)) return null // bad provider data → fail closed, expected
  const m = Math.round((b - a) / 60_000)
  if (m < 0) {
    console.warn(`[is-down/upstream-note] negative lead (${m}m) — #1053 gate 5 contract violated:`, earlier, later)
    return null
  }
  return m
}

/**
 * Is this a URL we are willing to put in an `href`?
 *
 * Not ceremony. `statusUrl` arrives across a network boundary behind a structural `as` cast (the same
 * reason this file types `status` as `string` rather than a union), and the template's `esc()` only
 * neutralizes markup characters — it does nothing to a `javascript:alert(1)` payload, which contains
 * none. So an unvalidated value here is a stored-XSS sink reachable by anything that can influence the
 * worker's response. Allowing exactly http/https closes it, and rejects the protocol-relative `//evil`
 * form too (`new URL` needs a base for those, so they throw and fail closed).
 *
 * Today the only producer is our own hard-coded `UPSTREAM_FEEDS` config, so nothing hostile can reach
 * it — which is precisely why the check belongs here rather than in a comment: the guarantee lives in
 * a different repo layer that a future edit can change without ever reading this file.
 */
export function isSafeExternalUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * The note for THIS service, or null when the worker made no upstream claim about it.
 *
 * Null covers three distinct cases that all mean the same thing on the page — say nothing:
 *   - the worker predates #1053 (deploy skew) → `links` undefined
 *   - the worker ran the gate and it did not fire → this id is absent from `links`
 *   - a link exists but names no upstream → defensive; the worker never emits it (`upstream.length === 0`
 *     is filtered there), but this crosses a network boundary, so it is not an invariant we can assume.
 */
export function buildUpstreamNote(links: UpstreamLinkLike[] | undefined, serviceId: string): UpstreamNote | null {
  const link = links?.find((l) => l.id === serviceId)
  if (!link || link.upstream.length === 0) return null

  return {
    fromId: link.id,
    incidentTitle: link.incidentTitle,
    upstream: link.upstream.map((u) => {
      const slug = SERVICE_ID_TO_SLUG[u.id]
      // Internal FIRST, always. An upstream that has both (none today, but a feed could later gain a
      // page) must keep the reader on AIWatch — the external link exists to fill a hole, not to
      // compete with the is-down page.
      const external = !slug && isSafeExternalUrl(u.statusUrl)
      // Absent vs REJECTED are the same outcome (a linkless row) but are not the same event. Absent is
      // expected — it is the permanent state of every service upstream, and the guaranteed state of a
      // feed upstream for the hours-to-days between this file shipping on merge and the worker deploy
      // catching up. Rejected is a config defect. Folding a defect into a path that is normal on every
      // deploy is how it stays invisible: nobody seeing a linkless GitHub row would suspect it.
      if (!slug && u.statusUrl && !external) {
        console.warn(`[is-down/upstream-note] ${u.id}: statusUrl rejected as unsafe — row renders with no destination:`, u.statusUrl)
      }
      return {
        id: u.id,
        name: u.name,
        status: u.status,
        incidentTitle: u.incidentTitle,
        startedAt: u.startedAt,
        href: slug ? `/is-${slug}-down` : (external ? u.statusUrl! : null),
        external,
        leadMinutes: minutesBetween(u.startedAt, link.startedAt),
      }
    }),
  }
}
