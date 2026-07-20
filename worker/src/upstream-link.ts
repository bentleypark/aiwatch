// #1053 — Cross-provider upstream link. Surface "this service's own status page blames an upstream
// AI provider, and that provider is indeed down right now" — the case AIWatch showed as two unrelated
// cards. Sibling surfaces of ONE status page already group by `inc.id` (claude/claudeai/claudecode all
// read status.claude.com, and the SPA dedupes on it); this layer is only for the CROSS-PROVIDER case,
// where the dependent files its own incident on its own page and no id can ever join them.
//
// Why not an extension of `supply-chain.ts` (#574): that layer's headline is REGION-scoped, so it
// deliberately drops any incident naming no region (see its `awsRegionsNamedByService` doc). Both
// evidenced cases here name an upstream but no region — exactly what that gate drops. Loosening the
// region premise to fit them is what #1000 had to undo. Structure differs too — supply-chain needs a
// dedicated health feed (`bedrock.awsRegionHealth`); our upstream is an ordinary `services[]` entry.
//
// Worker-side by design (the #574 precedent): the cross-service claim is computed once, clients render text.

import type { ServiceStatus } from './types'
import type { UpstreamCandidate } from './upstream-feed'
import { causalIncidents } from './incident-text'

/** A declared dependency. CURATED, never inferred — the curation is the moat and the safety gate. */
export interface UpstreamDep {
  /** the dependent service's id */
  id: string
  /** upstream service ids to check. A provider spans several of our ids (Anthropic → claude /
   *  claudeai / claudecode); list only the surface the dependent actually consumes. */
  upstreamIds: string[]
  /** tokens the dependent's OWN status text may use to name this upstream. Compared after
   *  `normalizeForMatch`, so spacing/case/punctuation variants collapse — one entry covers
   *  "HuggingFace", "Hugging Face" and "hugging-face". */
  aliases: string[]
}

/**
 * The dependency map. Every entry needs PRIMARY EVIDENCE — a real observed incident where the
 * dependent's own status text named this upstream, the upstream was impacted, and the upstream's
 * incident STARTED FIRST. All three, because that is what the gate below actually requires: evidence
 * of mere concurrency would not show the entry can ever fire. A blunt copy of a competitor's
 * dependency list is exactly what `supply-chain.ts` had to remove `together` for.
 *
 * Evidenced — read off the wire, not inferred:
 * - replicate → Hugging Face. 2026-07-16 (via GET /api/report?month=2026-07):
 *     huggingface `Huggingface Hub — down`        07:55:33.000Z
 *     replicate   `HuggingFace download issues`   08:31:53Z      — a +36m lead.
 * - cursor → Anthropic. 2026-07-17 (via GET /api/status/cached, during the live outage):
 *     claude `Elevated errors on Sonnet 5 and Haiku 4.5` 06:47:54.909Z
 *            (claudeai / claudecode carried that same incident — sibling surfaces of one Anthropic page)
 *     cursor `Investigating Anthropic degradation`      07:17:15.075Z  — a +29m lead.
 *
 * Titles, timestamps and ordering only — deliberately NO incident ids here. Ids justify nothing about
 * a map entry (the naming and the ordering do), and restating them in prose is how they drift: they
 * live in exactly ONE place, the fixtures in `__tests__/upstream-link.test.ts`, which assert them.
 * That file's header records why.
 *
 * `upstreamIds` for cursor is `['claude']` alone — the API is what Cursor consumes. claude.ai and
 * Claude Code are sibling SURFACES of the same Anthropic page; pointing a Cursor user at claude.ai
 * would be noise, not the cause.
 *
 * `aliases` stays tight for the same reason. Cursor is only evidenced saying "Anthropic", so that is
 * the only token. "claude" is deliberately absent: Cursor has a Claude model picker, so an incident
 * like "Claude 3.5 Sonnet unavailable in Cursor" can be Cursor's OWN routing bug — a token that names
 * a model the dependent merely resells is not the dependent blaming an upstream. Add an alias when a
 * real incident shows it, not in anticipation.
 *
 * - chatgpt / codex → GitHub platform (#1072). 2026-07-20, read off githubstatus.com/api/v2/summary.json
 *   and GET /api/status/cached during the live outage:
 *     github  `Incident with GitHub Actions`  (components Actions + API Requests, partial_outage)
 *                                                              2026-07-19T23:34:03.457Z
 *     chatgpt/codex `Elevated errors for GitHub-dependent ChatGPT and Codex workflows`
 *                                                              2026-07-20T00:34:34Z  — a 60m30s lead
 *                                                              (renders as "1h 1m": minutesBetween rounds).
 *   Both OpenAI surfaces carry that one incident (siblings of the same status.openai.com page), so both
 *   are declared: they are separate AIWatch services with separate is-down pages, and gate 2 is
 *   per-dependent, so omitting one would leave that page silent during the very outage that motivated
 *   this. The upstream is a NON-CARDED feed (`upstream-feed.ts`), not a service — GitHub is not an AI
 *   service, and the GitHub components we DO monitor (`copilot`) stayed operational throughout.
 *
 * `aliases: ['github']` is the token OpenAI actually used ("GitHub-dependent"). It carries a known
 * false-positive shape — a dependent's OWN integration bug ("GitHub integration broken in Codex")
 * names the same token without blaming an upstream, which is exactly why Cursor's entry omits
 * `claude`. It is admitted here, unlike there, because gate 4 requires GitHub to be CONCURRENTLY
 * impacted, and an internal integration bug does not come with a live githubstatus outage. That is a
 * containment argument, not an absence of risk: if a false link is ever observed, the fix is to drop
 * the alias, not to widen the gates.
 */
export const UPSTREAM_DEPS: UpstreamDep[] = [
  { id: 'cursor', upstreamIds: ['claude'], aliases: ['anthropic'] },
  { id: 'replicate', upstreamIds: ['huggingface'], aliases: ['huggingface'] },
  { id: 'chatgpt', upstreamIds: ['github-platform'], aliases: ['github'] },
  { id: 'codex', upstreamIds: ['github-platform'], aliases: ['github'] },
]

export interface UpstreamLink {
  /** the dependent service — the one the user is looking at */
  id: string
  name: string
  /** the incident of the DEPENDENT that carries the blame (the claim is theirs, not ours) */
  incidentId: string
  incidentTitle: string
  /** when the dependent opened that incident. Serialized so a client can show the LEAD TIME — how
   *  long the upstream had been broken before the dependent noticed. That gap is the most legible
   *  evidence the link is real (Replicate filed 36m after Hugging Face went down), and it is gate 5's
   *  observable consequence — deriving it client-side from two payload fields keeps the arithmetic
   *  next to the claim it supports. */
  startedAt: string
  /** the named upstream(s), each with the live incident that plausibly started the chain */
  upstream: Array<{
    id: string
    name: string
    status: 'degraded' | 'down'
    incidentId: string
    incidentTitle: string
    startedAt: string
    /** #1072 — the upstream's OWN status page, present only for a non-carded FEED upstream. A service
     *  upstream omits it and is linked to its AIWatch is-down page instead. Optional on the wire, so
     *  the Edge must treat absence as "link internally" — see `upstream-note.ts`. */
    statusUrl?: string
  }>
}

/** Case/spacing/punctuation-insensitive form. Replicate writes `HuggingFace`, our config says
 *  `Hugging Face` — the same name, so the match must not care. */
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[\s._-]+/g, '')
}

/** Does this incident text name any of the upstream's aliases? */
export function namesUpstream(text: string, aliases: string[]): boolean {
  const n = normalizeForMatch(text)
  return aliases.some((a) => n.includes(normalizeForMatch(a)))
}

/** ms since epoch, or null when the provider gave us something unparseable (→ fail closed).
 *
 *  `Incident.startedAt` is a REQUIRED string in types.ts, so an unparseable value is a parser defect,
 *  not normal input — and the resulting `continue` is byte-identical to a healthy gate. Log it, so a
 *  regressed parser is greppable instead of invisible. Mirrors `alerts.ts`'s #983 warn on this exact
 *  field. */
function startedMs(iso: string | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) {
    console.warn('[upstream-link] unparseable startedAt — dropping candidate:', iso)
    return null
  }
  return t
}

const isImpacted = <T extends { status: string }>(s?: T): s is T & { status: 'degraded' | 'down' } =>
  s != null && (s.status === 'degraded' || s.status === 'down')

/**
 * The freshness bound, used TWICE — see `buildUpstreamLinks` gates 3 and 5.
 *
 * The evidence bounds this to a RANGE, not a value: it must exceed the observed leads (36m
 * replicate→HF, 29m cursor→Anthropic) and fall short of the stale case it exists to reject (an open
 * `minor` that a provider carries for days — only `impact: null` is filtered, so those stay
 * "active"). 24h sits in that gap. It is not derived to a point: 6h would satisfy both constraints
 * equally, and a claim like "clears the signal ~40x" is a consequence of the pick, not a reason for
 * it. Widen it only against a real incident that needed the room, not in anticipation.
 */
const CAUSE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Build the cross-provider upstream links, or `[]` when nothing passes the gate.
 *
 * FIVE gates, all required. The AND is the whole design — each one alone produces false links:
 *   1. the pair is DECLARED in `UPSTREAM_DEPS` (never inferred from text alone)
 *   2. the dependent is currently degraded/down (the correlation gate — no static "X depends on Y"
 *      banner; mirrors `supply-chain.ts`'s separation from AIDown.io's static dependency map)
 *   3. the dependent's OWN active incident names the upstream (we report THEIR claim, not our theory),
 *      and that incident is itself fresh (within `CAUSE_WINDOW_MS` of `now`)
 *   4. the upstream is itself degraded/down with an active incident
 *   5. the upstream's incident STARTED FIRST, within `CAUSE_WINDOW_MS` — causality runs one way, and
 *      a trigger from last week is not a trigger for today
 *
 * Specificity, verified on real data: Replicate's other July incidents (`High contention on H100
 * hardware`, `H100 GPU shortage resulting in high queue times`) are self-inflicted and name no
 * upstream, so gate 3 keeps them silent. A static dependency banner would have decorated them all.
 *
 * Accepted cost: a dependent that says only "model provider issues" names nothing and is missed.
 * Fail-closed — the same trade `supply-chain.ts` makes. Under-claim rather than assert a cause we
 * cannot show the user in the provider's own words.
 *
 * `now` is a REQUIRED param, not an internal `Date.now()` and not an optional one with a default:
 * required means the type-checker makes every call site state its clock, and it keeps this function
 * pure so the freshness gates are testable without fake timers. #970 is the counter-lesson — an
 * OPTIONAL param there silently re-emptied a derived set at the call site that forgot it.
 *
 * `feeds` (#1072) is REQUIRED for the same kind of reason, scoped to what THIS function controls. Its
 * two call sites are the two response paths (`/api/status` and `/api/status/cached`), and they source
 * their feeds differently: the live path from `fetchAllServices`, the cached path from the snapshot
 * via `cached.upstreamFeeds ?? []`. Requiring the argument forces each to state which — a default
 * would silently give the cached path `[]` and leave is-down, the surface that reads it, permanently
 * linkless while the dashboard worked.
 *
 * NOT the argument for the cache WRITERS. This function writes nothing; the guarantee that the three
 * snapshot writers cannot drop the feeds comes from the required params on `writeStatusCache` and
 * `cacheWrite`, and the reasoning lives there. Restating it here would be a second copy to keep in
 * sync, and would credit this function with a protection it does not provide.
 *
 * Pass `[]` to mean "no feeds", explicitly. Dependents are resolved from `services` ONLY — a feed can
 * be an upstream, never a dependent: it has no card to annotate, and `UPSTREAM_DEPS` ids are services.
 */
export function buildUpstreamLinks(
  services: ServiceStatus[],
  feeds: UpstreamCandidate[],
  now: number,
): UpstreamLink[] {
  const byId = new Map<string, ServiceStatus>(services.map((s) => [s.id, s]))
  // Upstream lookup spans services ∪ feeds. Services win a collision: a real monitored service is
  // always the better answer (it has a card, an is-down page and a Score behind it), and a feed id
  // that shadows one is a config mistake we should not let silently take precedence.
  const upstreamById = new Map<string, ServiceStatus | UpstreamCandidate>([
    ...feeds.map((f) => [f.id, f] as const),
    ...services.map((s) => [s.id, s] as const),
  ])
  const links: UpstreamLink[] = []

  for (const dep of UPSTREAM_DEPS) {
    const svc = byId.get(dep.id)
    if (!isImpacted(svc)) continue // gate 2

    // gate 3 — the dependent's own active incidents that name this upstream. The MOST RECENT is the
    // claim, symmetric with gate 5's pick below and for the same reason: only `impact: null` is
    // filtered, so a long-running open `minor` naming the upstream stays "active" for weeks.
    //
    // Taking the earliest here was worse than the gate-5 version of the same bug, because `claim.at`
    // is gate 5's upper bound — a stale claim drags the whole window backwards and fails BOTH ways:
    //   - false card:    a 7d-old Replicate minor naming HF sets claim.at to 7d ago, so gate 5 admits
    //                    only HF incidents older than THAT — quoting an 8d-old minor while HF is
    //                    genuinely down today for an unrelated reason.
    //   - false negative: same stale claim, but HF's real incident started today → after claim.at →
    //                    rejected → no card during the actual outage.
    // "An earlier claim keeps gate 5 strict" was the reasoning for the old pick, and it is wrong:
    // causality is a per-PAIR property. If the dependent opens a new incident at T naming the upstream
    // and the upstream's incident predates T, the chain is sound for that pair — the FIRST blame is
    // not privileged.
    const naming = causalIncidents(svc)
      .filter(({ text }) => namesUpstream(text, dep.aliases))
      .map(({ inc }) => ({ inc, at: startedMs(inc.startedAt) }))
      .filter((c): c is { inc: typeof c.inc; at: number } => c.at != null)
      .sort((a, b) => b.at - a.at)
    const claim = naming[0]
    if (!claim) continue

    // The claim must itself be FRESH. `CAUSE_WINDOW_MS` below bounds `claim.at - cause.at` — a
    // RELATIVE gap — so it cannot reject two mutually-close STALE incidents: a 7d-old Replicate minor
    // naming HF, beside an HF minor from 1h before it, sits inside that window and renders
    // `Hugging Face — Down · "Minor: docs search slow" · Started 7d ago` while HF is genuinely down
    // today for an unrelated reason (and today's real incident is excluded, because it started after
    // claim.at). Anchoring the claim to now is what actually closes that; the relative window alone
    // only rescued the case where a fresher claim existed to out-sort the stale one.
    //
    // The two picks are NOT symmetric without this: `cause` is doubly anchored (to claim.at AND the
    // window), `claim` was anchored to nothing at all.
    if (now - claim.at > CAUSE_WINDOW_MS) continue

    const upstream: UpstreamLink['upstream'] = []
    for (const upId of dep.upstreamIds) {
      const up = upstreamById.get(upId)
      if (!isImpacted(up)) continue // gate 4

      // gate 5 — only upstream incidents that started at or before the dependent's claim. Of those,
      // take the MOST RECENT.
      //
      // We cannot know which upstream incident caused the dependent's: the dependent named the
      // provider, not the incident. So this picks the best available answer, and the card's wording is
      // scoped to match — "which is reporting its own incident", not "which caused it".
      //
      // Earliest is the wrong pick and was the first implementation's bug: only `impact: null` is
      // filtered, so a long-running `minor` advisory stays "active" for weeks, and ascending sort makes
      // THAT the quoted chain-starter whenever one exists. The card would then read `Hugging Face —
      // Down · "Minor: docs search slow" · Started 7d ago`, quoting an unrelated incident as the cause —
      // the exact misattribution this module exists to prevent. The evidenced fixtures hid it: both
      // Hugging Face incidents were same-outage siblings 88s apart, so earliest and latest agree.
      //
      // Most-recent-before is not airtight — an unrelated minor opened a minute before the claim would
      // win. That residual is accepted: gates 2/3/4 already require a live cross-provider co-outage, so
      // it takes a narrow coincidence, and the card's wording survives it ("which is reporting its own
      // incident", not "which caused it"). The STALE case is different in kind and is NOT left to the
      // wording — "Started 8d ago" beside a fresh outage is false whatever the verb — so it is rejected
      // outright, by `CAUSE_WINDOW_MS` here AND by the now-anchor on the claim above. Both are needed:
      // this one alone is relative, and two mutually-close stale incidents satisfy it.
      const cause = causalIncidents(up)
        .map(({ inc }) => ({ inc, at: startedMs(inc.startedAt) }))
        .filter((c): c is { inc: typeof c.inc; at: number } =>
          c.at != null && c.at <= claim.at && claim.at - c.at <= CAUSE_WINDOW_MS)
        .sort((a, b) => b.at - a.at)[0]
      if (!cause) continue

      upstream.push({
        id: up.id,
        name: up.name,
        status: up.status,
        incidentId: cause.inc.id,
        incidentTitle: cause.inc.title,
        startedAt: cause.inc.startedAt,
        // Spread-omitted rather than set to undefined: the payload is JSON, and an explicit
        // `statusUrl: undefined` serializes to nothing anyway — but omitting it keeps the emitted
        // object shape identical to the pre-#1072 one for every service upstream, so a snapshot
        // diff shows the new key ONLY where it means something.
        ...('statusUrl' in up && up.statusUrl ? { statusUrl: up.statusUrl } : {}),
      })
    }

    if (upstream.length === 0) continue
    links.push({
      id: svc.id,
      name: svc.name,
      incidentId: claim.inc.id,
      incidentTitle: claim.inc.title,
      startedAt: claim.inc.startedAt,
      upstream,
    })
  }

  return links
}
