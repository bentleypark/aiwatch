// Instatus (Next.js SSR + Nuxt SSR) Parser — for status pages like Perplexity, Mistral

import type { TimelineEntry, Incident } from '../types'
import { formatDuration } from '../utils'
import { weightedDowntimeSeconds, type OutageInterval } from './uptime-interval'

// #556 — map an Instatus severity/impact string to AIWatch's impact scale. Instatus exposes it
// differently per SSR format, so this helper handles BOTH vocabularies:
//   • Next.js: component-status impact — OPERATIONAL / UNDERMAINTENANCE / DEGRADEDPERFORMANCE /
//     PARTIALOUTAGE / MAJOROUTAGE  (observed live on Perplexity: DEGRADEDPERFORMANCE)
//   • Nuxt: incident severity — MINOR / MEDIUM / MAJOR / CRITICAL (observed live on Mistral: MEDIUM)
// Both previously fell through to `null` (Next.js handled only MAJOR/PARTIAL; Nuxt hardcoded null),
// which made every Mistral/Perplexity incident invisible to the AIWatch Score's incident penalty and
// to "Affected Days" (score.ts excludes null-impact per #261). OPERATIONAL/maintenance → null, which
// excludes them from the incident SCORE (affected-days + weighted days) — note this is a scoring
// exclusion, not a display one (a null-impact entry still counts in the raw incident list/count); the
// `/incidents` feed these parsers read carries real incidents, not scheduled maintenance, so the
// maintenance entries here are a defensive belt. Unknown values default to 'minor' (an /incidents-feed
// entry is real) and warn-once so a new Instatus value is diagnosable, not silently dropped.
const warnedInstatusImpacts = new Set<string>()
export function mapInstatusImpact(raw: string | null | undefined): Incident['impact'] {
  const s = (raw ?? '').toUpperCase()
  if (!s || s === 'OPERATIONAL' || s === 'UNDERMAINTENANCE' || s === 'MAINTENANCE' || s === 'NONE') return null
  if (s === 'CRITICAL') return 'critical'
  if (s === 'MAJOROUTAGE' || s === 'MAJOR' || s === 'HIGH') return 'major'
  if (s === 'PARTIALOUTAGE' || s === 'DEGRADEDPERFORMANCE' || s === 'MINOR' || s === 'MEDIUM' || s === 'LOW') return 'minor'
  if (!warnedInstatusImpacts.has(s)) {
    warnedInstatusImpacts.add(s)
    console.warn(`[instatus] unknown severity/impact "${raw}" — defaulting to 'minor'; extend mapInstatusImpact`)
  }
  return 'minor'
}

// #623 — extract Instatus component definitions (id → display name) from the Next.js SSR payload so
// each notice's `components: [{id}]` can be resolved to names (set on Incident.componentNames). That
// lets a service like Perplexity scope its API badge with `incidentKeywords: ['api']` (matched
// against componentNames): a Website-only incident is dropped, a Website+API incident kept.
//
// #911 — three object shapes coexist in the payload and must be told apart to map ONLY top-level
// component id→name:
//   - top-level component: `"id":…,"name":{…"default":"X"},"nameHtml":…,"group":<null|…>,"children":[…]`
//   - CHILD sub-component (e.g. fal's "Model API" under the "API" parent): SAME shape but NO `"group"`
//   - incident notice: `"name":{"en":…,"default":…}` immediately followed by `"started"` (no `"nameHtml"`)
// The old `"name":{"default":` anchor worked only by ACCIDENT — top-level names were `default`-only
// while notices AND (in the observed payloads) children carried an `"en"` locale key first. Perplexity
// adding a *top-level* component with an `"en"` key ("Computer", #911) broke that, so the locale key is
// NOT a reliable discriminator. Instead: (1) tolerate any locale keys before `default` (`[^}]*?`),
// (2) require the trailing `,"nameHtml"` — excludes notices, and (3) require a `"group"` field reached
// without crossing into the next object (`(?:(?!"id":")…)*?` tempered scan) — top-level components
// carry `"group"` before their `"children"`; children have none, so they never match. This preserves
// fal's intended top-level granularity while picking up Perplexity's Computer.
// LOAD-BEARING ASSUMPTIONS on the current Instatus serialization (not guaranteed by the format): a
// top-level component (a) emits `"nameHtml"` right after its name AND (b) emits its `"group"` field
// BEFORE its `"children"` array. If either changes upstream, that component is silently dropped — so
// `parseInstatusComponents` warns-once on an all-dropped payload (#911) to make the drift diagnosable
// rather than mistaken for a code bug.
function buildInstatusComponentMap(html: string): Map<string, string> {
  const map = new Map<string, string>()
  const re = /\\"id\\":\\"([a-z0-9]+)\\",\\"name\\":\{[^}]*?\\"default\\":\\"([^\\"]+)\\"\},\\"nameHtml\\"(?:(?!\\"id\\":\\")[\s\S])*?\\"group\\":/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) map.set(m[1], m[2])
  return map
}

// #761 — map an Instatus component-status string to the Atlassian-Statuspage vocabulary that
// `normalizeStatus()` understands, so `parseInstatusComponents` output can flow through
// `resolveSvcComponents` (which calls normalizeStatus on each component) unchanged. Instatus
// component states: OPERATIONAL / UNDERMAINTENANCE / DEGRADEDPERFORMANCE / PARTIALOUTAGE /
// MAJOROUTAGE. Maintenance → operational (a scheduled-maintenance row shouldn't read as an outage).
function instatusComponentStatusToStatuspage(raw: string): string {
  switch ((raw ?? '').toUpperCase()) {
    case 'MAJOROUTAGE': return 'major_outage'
    case 'PARTIALOUTAGE': return 'partial_outage'
    case 'DEGRADEDPERFORMANCE': return 'degraded_performance'
    default: return 'operational' // OPERATIONAL / UNDERMAINTENANCE / unknown
  }
}

// #761 — map a Nuxt INCIDENT SEVERITY to the Atlassian-Statuspage component vocabulary, by routing
// through `mapInstatusImpact` so the severity words stay decoded in exactly ONE place (a second
// severity switch here would drift from it the first time Instatus adds a level).
// NOTE an UNKNOWN severity never reaches the default here: `mapInstatusImpact` maps unknown → 'minor'
// (+ a warn-once), so it lands on `degraded_performance`. Only a null impact — OPERATIONAL /
// UNDERMAINTENANCE / MAINTENANCE / NONE / empty — returns 'operational'. That asymmetry is deliberate
// for the incident list (never silently drop a real incident) and is inherited here; the consequence
// is that a new Instatus severity word paints components degraded rather than green, which fails safe.
function instatusSeverityToStatuspage(raw: string | null | undefined): string {
  switch (mapInstatusImpact(raw)) {
    case 'critical':
    case 'major': return 'major_outage'
    case 'minor': return 'degraded_performance'
    default: return 'operational' // null — maintenance / operational / none
  }
}

// Statuspage component states ordered BEST → WORST (higher index = more severe). Used to worst-of two
// ongoing incidents landing on the same component (Instatus lets several overlap), so the card shows
// the most severe, not the last one written. `partial_outage` is unreachable from the Nuxt severity
// mapping above (minor → degraded_performance) and is present only to keep this a complete ordering
// over the Statuspage vocabulary.
const STATUSPAGE_SEVERITY_ORDER = ['operational', 'degraded_performance', 'partial_outage', 'major_outage']

// #761 — per-component snapshot for Nuxt Instatus pages (Mistral). The Nuxt payload exposes no
// per-COMPONENT status field (unlike Next.js) — verified live 2026-07-20: none of the five Instatus
// component-state literals (OPERATIONAL / UNDERMAINTENANCE / DEGRADEDPERFORMANCE / PARTIALOUTAGE /
// MAJOROUTAGE) occurs anywhere in it. (Incidents DO carry a `lastUpdateStatus`, a different
// vocabulary, which step 2 below reads.) So component status is DERIVED from what the page publishes:
//   • the component tree — a group object `{id,name,order,services}` whose `services` deref to the
//     components (observed fields: id/name/createdAt/order, plus uptime/days on the uptime-section
//     copies; treat these as an observed superset, not an exhaustive schema), and
//   • each ONGOING incident's `services[]`, which names the affected components explicitly (e.g.
//     "Audio API Degraded" → `Audio API`) with ids that match the tree (verified live).
// A component named by an unresolved incident takes that incident's severity; every other component
// is `operational`. This is the same "which component is degraded" signal #1062 facet B needs, taken
// from the provider's own attribution rather than from parsing the incident TITLE — the fragile
// heuristic #1062 explicitly worried about.
//
// LOAD-BEARING ASSUMPTIONS on the current Instatus Nuxt serialization (not guaranteed by the format),
// stated explicitly because the fixture is authored to match them and therefore cannot falsify them:
//   (a) a GROUP is distinguishable by carrying `services` + `order` + `name` + `id` while a COMPONENT
//       carries `createdAt` and an INCIDENT carries `severity`/`lastUpdateStatus`. If a group ever
//       ships `createdAt` too, step 1 selects nothing.
//   (b) an ongoing incident is `lastUpdateStatus !== 'RESOLVED'` with an index-ref `services[]` array
//       whose entries deref to objects whose `id` matches a tree component.
// Step 1 failing degrades to `[]` (a visibly absent card) and IS diagnosed. Step 2 failing degrades to
// a confidently WRONG all-operational snapshot during a live outage, which also makes `routingTier`
// (#1062 facet B) see `degraded.size === 0` and silently fall back to generic LLM peers — the very bug
// #1062 was filed to fix, with every test still green. That is the malignant case, and it is diagnosed
// ONLY for the sub-case where an incident still carries a non-empty `services[]` whose refs no longer
// resolve to tree components (id scheme change, ref shape change).
//
// KNOWN UNDIAGNOSED (and, on this payload, undiagnosABLE): if the incident-side `services` KEY itself
// is renamed or restructured away, the loop skips those objects, nothing is counted, and no warn
// fires. There is no payload invariant to separate that from the benign "incident opened before
// components were attached" state — live, exactly 1 of 284 incident-shaped objects carries a
// `services` key at all, and 0 resolved ones do, so past incidents cannot witness the field's
// existence either. Any counter that fired on this would fire on that benign state too, which is the
// cry-wolf failure this warn was already narrowed once to avoid. Named here rather than papered over;
// the real backstop for a shape change of that size is the `mistral-config.test.ts` name/id pin plus
// the operator noticing a permanently-green breakdown.
//
// ACCEPTED LIMITATION (#761): because the status is derived from incidents, a component the provider
// marks degraded WITHOUT opening an incident reads `operational` here. That state is unrepresentable
// in the Nuxt payload — it publishes no component status at all — so this is an upper bound of the
// source, not a gap in the derivation. (Runtime-indistinguishable from a step-2 drift on its own,
// which is exactly why the drift gets its own warn.) Display-only: the badge never reads this (#606).
export function parseInstatusNuxtComponents(html: string): Array<{ id: string; name: string; status: string }> {
  const match = html.match(/__NUXT_DATA__[^>]*>([\s\S]*?)<\/script/)
  if (!match) return []
  let arr: unknown[]
  // Narrow the try to the parse itself, so a malformed payload is distinguishable from a traversal
  // bug below (the sibling parsers' single body-wide try conflates the two).
  try {
    arr = JSON.parse(match[1]) as unknown[]
  } catch (err) {
    console.warn('[parseInstatusNuxtComponents] __NUXT_DATA__ JSON parse failed:', err instanceof Error ? err.message : err)
    return []
  }
  try {
    // Nuxt serialises every scalar as an index into the flat array; a non-index value is already literal.
    const deref = (v: unknown): unknown =>
      typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < arr.length ? arr[v] : v
    const isObj = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v)
    const str = (v: unknown): string => (typeof deref(v) === 'string' ? (deref(v) as string) : '')

    // 1. Component tree from the group objects (assumption (a) above). Incidents are excluded three
    // times over (most carry no `services` key at all; all carry `severity`/`lastUpdateStatus`; none
    // carry `order`). What `order` UNIQUELY excludes is the second group-SHAPED object
    // `{id,name,services,uptime}` — the uptime rollup — which would otherwise re-add the same
    // components. The explicit field exclusion below is defence-in-depth.
    const tree = new Map<string, { name: string; status: string }>()
    for (const v of arr) {
      if (!isObj(v)) continue
      if (!('services' in v) || !('order' in v) || !('name' in v) || !('id' in v)) continue
      if ('severity' in v || 'lastUpdateStatus' in v || 'createdAt' in v) continue
      const services = deref(v.services)
      if (!Array.isArray(services)) continue
      for (const ref of services) {
        const comp = deref(ref)
        if (!isObj(comp)) continue
        const id = str(comp.id)
        const name = str(comp.name)
        if (id && name) tree.set(id, { name, status: 'operational' })
      }
    }
    if (tree.size === 0) {
      // Assumption (a) broke (or this simply isn't a status page). Mirrors the #911 warn-once on the
      // Next.js path — an empty breakdown should read as diagnosable drift, not as a code bug.
      warnEmptyNuxtTree()
      return []
    }

    // 2. Overlay the ongoing incidents' own component attribution (worst-of on overlap).
    // `incidentShaped` / `overlaid` exist ONLY to detect assumption (b) breaking: see below.
    let incidentShaped = 0
    let overlaid = 0
    for (const v of arr) {
      if (!isObj(v)) continue
      if (!('lastUpdateStatus' in v) || !('services' in v) || !('severity' in v)) continue
      if (str(v.lastUpdateStatus) === 'RESOLVED') continue
      const status = instatusSeverityToStatuspage(str(v.severity))
      if (status === 'operational') continue // in-progress MAINTENANCE lands here — not an outage
      const services = deref(v.services)
      if (!Array.isArray(services) || services.length === 0) continue
      // Counted only once the incident is ATTRIBUTABLE — impactful AND carrying components. An
      // in-progress maintenance window, or an incident opened before components are attached (a very
      // common real state), is a legitimate reason for a fully-operational snapshot, so counting it
      // here would make the drift warn below cry wolf on ordinary traffic — which is how a warn-once
      // gets learned as noise and stops being read. Assumption (b) breaking still counts: those
      // incidents carry a non-empty services[] and fail later, at `tree.get`.
      incidentShaped++
      for (const ref of services) {
        const svc = deref(ref)
        if (!isObj(svc)) continue
        const entry = tree.get(str(svc.id))
        if (!entry) continue // named a component outside the tree (e.g. ungrouped) — drop, don't invent
        overlaid++
        if (STATUSPAGE_SEVERITY_ORDER.indexOf(status) > STATUSPAGE_SEVERITY_ORDER.indexOf(entry.status)) {
          entry.status = status
        }
      }
    }
    // THE malignant failure: the tree parsed, incidents that DO name components are unresolved, yet not
    // one of them landed on a component. Every row then reads `operational` during a live outage — an
    // affirmatively wrong "verified healthy" card, strictly worse than an empty one, and it silently
    // defeats #1062 routing. Deliberately NOT fired when there are no ongoing incidents (the healthy
    // steady state), nor when the only unresolved ones are maintenance or not-yet-attributed — those
    // are legitimate reasons for an all-operational snapshot.
    if (incidentShaped > 0 && overlaid === 0) warnNuxtOverlayNoop()

    return [...tree].map(([id, { name, status }]) => ({ id, name, status }))
  } catch (err) {
    // Traversal (not parse) failure — a shape change that throws mid-walk. Logged distinguishably from
    // the JSON.parse guard above so the two aren't conflated in the operator log.
    console.warn('[parseInstatusNuxtComponents] traversal failed:', err instanceof Error ? err.message : err)
    return []
  }
}

let warnedEmptyNuxtTree = false
function warnEmptyNuxtTree(): void {
  if (warnedEmptyNuxtTree) return
  warnedEmptyNuxtTree = true
  console.warn('[parseInstatusNuxtComponents] __NUXT_DATA__ present but NO component group matched — Instatus Nuxt group shape may have changed (#761); the breakdown card will be absent')
}

let warnedNuxtOverlayNoop = false
function warnNuxtOverlayNoop(): void {
  if (warnedNuxtOverlayNoop) return
  warnedNuxtOverlayNoop = true
  console.warn('[parseInstatusNuxtComponents] component-attributed unresolved incidents exist but NONE overlaid onto a tree component — Instatus Nuxt component ids may have changed (#761); EVERY component will read operational and #1062 fallback routing will silently fall back to default peers')
}

// #761 — per-component snapshot for the ServiceDetails / is-down breakdown card. The two Instatus SSR
// formats expose it differently, so this is the single entry point and dispatches (mirroring
// `parseInstatusIncidents` / `parseInstatusUptime`): Next.js reads a real per-component `status`
// field below; Nuxt has none and derives it from incident attribution in `parseInstatusNuxtComponents`.
// Reuses `buildInstatusComponentMap` — which isolates the TOP-LEVEL components (their children,
// e.g. fal's "Model API"/"Serverless API" under the "API" group, are excluded via the `"group"`-field
// discriminator, #911), giving a uniform top-level granularity across services — then reads each
// component's `status` from the unescaped payload. Returns the Atlassian-shaped {id,name,status} so it
// feeds `resolveSvcComponents()` (with the service's `displayComponentIds`) exactly like a summary.json
// component list.
export function parseInstatusComponents(html: string): Array<{ id: string; name: string; status: string }> {
  if (html.includes('__NUXT_DATA__')) return parseInstatusNuxtComponents(html)
  if (!html.includes('__next_f')) return []
  // Blanket `\"`→`"` unescape (safe — same rationale as parseInstatusNextUptime): component objects
  // carry no embedded quotes in the fields we read (id, name.default, status enum).
  const u = html.replace(/\\"/g, '"')
  const out: Array<{ id: string; name: string; status: string }> = []
  for (const [id, name] of buildInstatusComponentMap(html)) {
    // Locale-agnostic anchor (#911) — the name object may be `{"default":…}` or `{"en":…,"default":…}`,
    // so anchor at the name-object open brace, not at `"default":`.
    const anchor = `"id":"${id}","name":{`
    const at = u.indexOf(anchor)
    if (at < 0) continue
    // The component's own `status` is the first one after the anchor (it precedes any `children`
    // array), so a bounded forward search reads the parent's status, not a child's.
    const m = u.slice(at, at + 600).match(/"status":"([A-Z_]+)"/)
    out.push({ id, name, status: instatusComponentStatusToStatuspage(m ? m[1] : 'OPERATIONAL') })
  }
  // #911 diagnostic — the top-level discriminator (`group`-gated) is load-bearing: a real top-level
  // component that ever ships WITHOUT a `group` field (or without `nameHtml`) is silently dropped, the
  // exact silent-miss class #911 fixed. If the payload clearly HAS component-shaped objects (a permissive
  // `nameHtml`-anchored match) yet the strict top-level pass matched none, warn once so an upstream shape
  // change surfaces as a diagnosable signal instead of an empty breakdown mistaken for a code bug.
  if (out.length === 0 && /\\"id\\":\\"[a-z0-9]+\\",\\"name\\":\{[^}]*?\\"default\\":\\"[^\\"]+\\"\},\\"nameHtml\\"/.test(html)) {
    warnEmptyInstatusComponents()
  }
  return out
}

let warnedEmptyInstatusComponents = false
function warnEmptyInstatusComponents(): void {
  if (warnedEmptyInstatusComponents) return
  warnedEmptyInstatusComponents = true
  console.warn('[parseInstatusComponents] payload has component-shaped objects but none matched the top-level (`group`-gated) discriminator — Instatus Next.js shape may have changed (#911)')
}

/**
 * #1089 — would this Next notice survive `parseInstatusNextIncidents`' per-notice skips?
 *
 * Mirrors the two documented filters (unparseable `started`; a RESOLVED incident under 60s) so the
 * result-wrapper can tell "the filters dropped everything" from "the list was lost". Deliberately
 * conservative: anything it cannot read is treated as SHOULD-have-yielded, so an unrecognised shape
 * biases toward reporting drift rather than toward a silent green badge.
 */
function wouldYieldIncident(notice: unknown): boolean {
  if (!notice || typeof notice !== 'object') return true
  const n = notice as { started?: unknown; resolved?: unknown; status?: unknown }
  const started = typeof n.started === 'string' ? new Date(n.started) : null
  if (!started || isNaN(started.getTime())) return false          // bad start date → skipped
  if (n.status !== 'RESOLVED') return true                        // ongoing → always yields
  if (typeof n.resolved !== 'string') return true
  const ms = new Date(n.resolved).getTime() - started.getTime()
  return !(ms >= 0 && ms < 60_000)                                // <60s micro-incident → skipped
}

/**
 * #1089 — Next.js counterpart of `parseInstatusIncidentsResult`. Kept in the same shape so the fix
 * covers `perplexity` / `fal` (Next format) and not just `mistral` (Nuxt) — a status-source guard that
 * protects one of three Instatus services would read as protection while two stayed exposed.
 */
function parseInstatusNextIncidentsResult(html: string): InstatusIncidentsResult {
  const incidents = parseInstatusNextIncidents(html)
  if (incidents.length > 0) return { ok: true, incidents }

  // Empty result — decide WHICH empty it is. A bare "is the substring present?" check was too weak:
  // it only caught the envelope vanishing, so every INNER shape change (the `,\"metrics` anchor
  // moving, ids no longer `[a-z0-9]`-initial, corrupt inner JSON) still read as a healthy quiet page —
  // and inner-shape drift is exactly the failure Mistral actually hit on the Nuxt side. So mirror the
  // Nuxt path's rigour: gate on the parse's OWN pattern, and accept only a literally-empty envelope
  // (`notices\":{}`) as a genuine "no incidents".
  // EXTRACT the envelope rather than pattern-match around it. An earlier cut asked "does the raw HTML
  // literally contain `notices\":{},`?" and called everything else drift — which fabricated an outage
  // in two legitimate cases the parser handles by design: a page whose notices are ALL filtered out
  // (the <60s micro-incident filter, i.e. exactly the automated noise it exists for) and one with an
  // unparseable `started` date. Both yield zero incidents from a populated envelope, and both would
  // have gone `sourceUnknown` → `degraded` after three cycles. The Nuxt path has always treated that
  // case as healthy (its per-item skips are invisible); this makes the two agree.
  // UNESCAPE FIRST, then extract. `matchBrace` is quote-aware but assumes ordinary JSON: on the raw
  // Next payload (`{\"n1\":{...`) the backslash before each quote sits OUTSIDE a string as far as it is
  // concerned, so the first `\"` opens a string that never closes and the scan runs to the end. Found
  // by probing a realistically-escaped fixture rather than trusting the fixture was at fault.
  const unescaped = html.replace(/\\"/g, '"')
  const at = unescaped.indexOf('"notices":{')
  if (at === -1) return { ok: false, reason: 'no-next-notices' }
  const open = unescaped.indexOf('{', at)
  const close = matchBrace(unescaped, open)
  if (close === -1) return { ok: false, reason: 'next-shape-changed' }
  try {
    const parsed = JSON.parse(unescaped.slice(open, close + 1)) as Record<string, unknown>
    // Envelope readable and empty = a genuinely quiet page.
    if (Object.keys(parsed).length === 0) return { ok: true, incidents: [] }
    // Entries present. Two ways that yields zero incidents, and they are NOT the same:
    //   • the parser's own per-notice filters dropped them all (<60s micro-incident, bad start date)
    //     — legitimate, and the Nuxt path treats its equivalents as invisible;
    //   • `parseInstatusNextIncidents`'s single regex mis-anchored — key order changed, an extra key
    //     between `notices` and `metrics` (its lazy `[\s\S]*?` spans right across, matches, then the
    //     JSON.parse of the over-wide slice throws), or ids no longer `[a-z0-9]`-initial. That drops
    //     the WHOLE list, open incidents included: exactly the #1089 class.
    //
    // Nuxt cannot conflate these — its skips are genuinely per-entry — while Next has one regex
    // covering the entire list. Testing whether the regex MATCHED is not enough (the extra-key case
    // matches and still loses everything), so decide from the envelope we already parsed: ask how many
    // of these notices SHOULD have survived the documented filters. Zero expected ⇒ the filters did
    // their job. Some expected but none produced ⇒ the list was lost, whatever the mechanism.
    const expected = Object.values(parsed).filter((n) => wouldYieldIncident(n)).length
    if (expected > 0 && incidents.length === 0) return { ok: false, reason: 'next-shape-changed' }
    return { ok: true, incidents }
  } catch {
    // The envelope is there but its contents no longer parse — the shape genuinely moved.
    return { ok: false, reason: 'next-shape-changed' }
  }
}

function parseInstatusNextIncidents(html: string): Incident[] {
  try {
    // Next.js SSR payload has escaped quotes: notices\":{\"id\":{...}}
    // Find the notices section and unescape
    const match = html.match(/notices\\":\{(\\"[a-z0-9][\s\S]*?)\},\\"metrics/)
    if (!match) return []
    // Unescape the JSON: \" → "
    const raw = '{' + match[1].replace(/\\"/g, '"') + '}'
    const notices = JSON.parse(raw) as Record<string, {
      id: string; name: { default: string }; impact: string
      started: string; resolved: string | null; status: string
      components?: Array<{ id: string }> // #623 — affected component ids (resolved → componentNames)
    }>
    const componentNameById = buildInstatusComponentMap(html)

    const incidents: Incident[] = []
    for (const notice of Object.values(notices)) {
      if (incidents.length >= 20) break
      const startDate = new Date(notice.started)
      if (isNaN(startDate.getTime())) continue
      const resolvedDate = notice.resolved ? new Date(notice.resolved) : null
      const isResolved = notice.status === 'RESOLVED'

      // Filter out micro-incidents (resolved in < 60s) — automated monitoring noise
      const durationMs = resolvedDate ? resolvedDate.getTime() - startDate.getTime() : -1
      if (isResolved && durationMs >= 0 && durationMs < 60_000) {
        console.debug(`[parseInstatusNext] filtered micro-incident ${notice.id} (${durationMs}ms)`)
        continue
      }

      const timeline: TimelineEntry[] = [
        { stage: 'investigating' as const, text: notice.name.default, at: startDate.toISOString() },
      ]
      if (isResolved && resolvedDate && !isNaN(resolvedDate.getTime())) {
        timeline.push({ stage: 'resolved' as const, text: 'Resolved', at: resolvedDate.toISOString() })
      }

      // #623 — resolve affected component ids → names for component-aware filtering (e.g. Perplexity
      // incidentKeywords:['api'] keeps a Website+API incident but drops a Website-only one).
      const componentRefs = notice.components ?? []
      const componentNames = componentRefs
        .map((c) => componentNameById.get(c.id))
        .filter((n): n is string => !!n)
      // Resolution depends on the Instatus `"id":"…","name":{"default":…}` serialization (key order):
      // if a notice references components but NONE resolve, the component map likely changed shape —
      // log it so a future Instatus format change is diagnosable instead of silently scoping wrong.
      if (componentRefs.length > 0 && componentNames.length === 0) {
        console.debug(`[parseInstatusNext] notice ${notice.id} references ${componentRefs.length} component id(s) but none resolved — Instatus component serialization may have changed`)
      }

      incidents.push({
        id: notice.id,
        title: notice.name.default,
        status: isResolved ? 'resolved' : 'investigating',
        impact: mapInstatusImpact(notice.impact), // #556 — was MAJOR/PARTIAL-only; DEGRADEDPERFORMANCE fell to null
        componentNames: componentNames.length > 0 ? componentNames : undefined,
        startedAt: startDate.toISOString(),
        resolvedAt: (resolvedDate && !isNaN(resolvedDate.getTime())) ? resolvedDate.toISOString() : null,
        duration: (isResolved && resolvedDate && !isNaN(resolvedDate.getTime()))
          ? formatDuration(startDate, resolvedDate)
          : null,
        timeline,
      })
    }
    return incidents
  } catch (err) {
    console.warn('[parseInstatusNext] failed:', err instanceof Error ? err.message : err)
    return []
  }
}

// Quote-aware brace matcher: given the index of an opening `{`, return the index of its matching
// `}` (or -1). Used to extract a JSON object embedded in a larger string when the object nests
// arrays/objects (so a naive non-greedy regex can't bound it).
function matchBrace(s: string, open: number): number {
  let depth = 0
  let inStr = false
  for (let i = open; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === '"') inStr = false
    } else if (c === '"') {
      inStr = true
    } else if (c === '{') {
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

// #627/#635 — uptime % for a named component from an Instatus page. Instatus exposes uptime per
// component (no Atlassian summary.json), so AIWatch otherwise shows "Not provided". The two SSR
// formats encode it differently:
//   • Nuxt (Mistral): a flat-array index ref to a direct float (e.g. the "API" group component on
//     status.mistral.ai → 99.599).
//   • Next.js (Perplexity, #635): a `componentsUptime` object keyed by component id, each entry
//     carrying a precomputed aggregate `"uptime":"99.82"` string. The parser reads only the % — not
//     the page's window (observed ~90d on status.perplexity.com via `maxUptimeDays:90`; per #654 the
//     window isn't surfaced since it varies by source).
//     (The #627 "Next.js has no inline uptime" note was outdated — Instatus now serializes it.)
// Returns null when the component isn't found or the value is out of range, so the caller falls back
// to estimate/null.
/** #1006 — the period the Instatus page says its uptime % covers. We cannot recompute these services on
 *  our common 30-day window (they publish an aggregate, never per-day records), so the honest thing is to
 *  name the period their number DOES cover rather than hand-wave "the provider's own window".
 *  Both SSR shapes state it: Next.js serialises `maxUptimeDays` (Perplexity, fal → 90); Nuxt renders the
 *  range as a label (Mistral → "90 days ago"). Verified on all three pages, 2026-07-14. null when neither
 *  is present — the caller then falls back to the unqualified wording. */
/** #1006 — the aggregate uptime % the Instatus page DISPLAYS for a component/group (its `uptime` field),
 *  over the page's own period (these pages declare `maxUptimeDays: 90`). Not the metric — we compute a
 *  30-day figure from the outage records — but shown beside ours on the detail page when they differ, so
 *  the reader can check us against the provider (the same disclosure Atlassian + incident.io get). */
export function parseInstatusReportedUptime(html: string, componentName: string | undefined): number | null {
  if (!componentName) return null
  if (html.includes('__NUXT_DATA__')) {
    const m = html.match(/__NUXT_DATA__[^>]*>([\s\S]*?)<\/script/)
    if (!m) return null
    try {
      const arr: unknown[] = JSON.parse(m[1])
      const deref = (v: unknown) => (typeof v === 'number' ? arr[v] : v)
      for (const item of arr) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const o = item as Record<string, unknown>
        if (!('uptime' in o) || deref(o.name) !== componentName) continue
        const up = deref(o.uptime)
        return typeof up === 'number' && up >= 0 && up <= 100 ? up : null
      }
    } catch { return null }
    return null
  }
  if (html.includes('__next_f')) {
    let id: string | undefined
    for (const [cid, name] of buildInstatusComponentMap(html)) {
      if (name === componentName) { id = cid; break }
    }
    if (!id) return null
    const u = html.replace(/\\"/g, '"')
    const ki = u.indexOf('"componentsUptime":')
    if (ki < 0) return null
    const objStart = u.indexOf('{', ki + '"componentsUptime":'.length)
    const objEnd = objStart < 0 ? -1 : matchBrace(u, objStart)
    if (objEnd < 0) return null
    try {
      const cu = JSON.parse(u.slice(objStart, objEnd + 1)) as Record<string, { uptime?: string | number }>
      const raw = cu[id]?.uptime
      const up = typeof raw === 'string' ? parseFloat(raw) : raw
      return typeof up === 'number' && !isNaN(up) && up >= 0 && up <= 100 ? up : null
    } catch { return null }
  }
  return null
}

export function parseInstatusUptimeDays(html: string): number | null {
  const explicit = html.match(/maxUptimeDays\\?"?\s*:\s*\\?"?(\d{1,3})/)
  const label = html.match(/(\d{1,3})\s*days? ago/)
  const raw = explicit?.[1] ?? label?.[1]
  if (!raw) return null
  const days = parseInt(raw, 10)
  return Number.isFinite(days) && days > 0 && days <= 400 ? days : null
}

export function parseInstatusUptime(
  html: string,
  componentName: string | undefined,
  nowMs: number = Date.now(),
  windowDays = 30,
): number | null {
  if (!componentName) return null
  if (html.includes('__NUXT_DATA__')) return parseInstatusNuxtUptime(html, componentName, nowMs, windowDays)
  if (html.includes('__next_f')) return parseInstatusNextUptime(html, componentName, nowMs, windowDays)
  return null
}

function parseInstatusNuxtUptime(html: string, componentName: string, nowMs: number, windowDays: number): number | null {
  const match = html.match(/__NUXT_DATA__[^>]*>([\s\S]*?)<\/script/)
  if (!match) return null
  try {
    const arr: unknown[] = JSON.parse(match[1])
    const deref = (v: unknown) => (typeof v === 'number' ? arr[v] : v) // Nuxt scalars are index refs
    const windowStart = nowMs - windowDays * 86_400_000

    /** Weighted outage seconds inside the window for ONE component node (the node that carries `days`). */
    const componentUptime = (node: Record<string, unknown>): number | null => {
      const days = deref(node.days)
      if (!Array.isArray(days)) return null
      // Nuxt events carry a resolved `duration` (seconds), not an end timestamp, so an in-progress event
      // (duration 0/absent) has no interval to place and is skipped. Collect the resolved ones and let
      // the shared accumulator merge overlaps (worst-weight-wins) so concurrent events on one component
      // aren't double-counted.
      const intervals: OutageInterval[] = []
      for (const dayRef of days) {
        const day = deref(dayRef) as Record<string, unknown> | undefined
        const events = day && deref(day.events)
        if (!Array.isArray(events)) continue
        for (const evRef of events) {
          const ev = deref(evRef) as Record<string, unknown> | undefined
          if (!ev) continue
          const startedAt = Date.parse(String(deref(ev.created_at) ?? ''))
          const duration = Number(deref(ev.duration) ?? 0) // seconds
          if (Number.isNaN(startedAt) || !(duration > 0)) continue
          const weight = instatusSeverityWeight(String(deref(ev.severity) ?? ''))
          if (weight === 0) continue
          intervals.push({ start: startedAt, end: startedAt + duration * 1000, weight })
        }
      }
      const weightedSec = weightedDowntimeSeconds(intervals, windowStart, nowMs)
      // Floor, like every other source — never round 99.998% up to a clean 100%.
      return Math.max(0, Math.floor((1 - weightedSec / (windowDays * 86_400)) * 10000) / 100)
    }

    for (const item of arr) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const o = item as Record<string, unknown>
      if (!('uptime' in o) || !('name' in o)) continue
      if (deref(o.name) !== componentName) continue

      // #1006 — compute, don't copy. `o.uptime` is the page's own aggregate over ITS period (90 days on
      // status.mistral.ai), which is not comparable with the 30-day figures every other source now
      // produces. The raw material sits beside it: a COMPONENT carries `days` (90 × {date, events[]}),
      // each event with `created_at` + `duration` (seconds) + `severity`.
      if ('days' in o) return componentUptime(o)

      // …but a configured name can also address a GROUP — mistral's `statusComponent: 'API'` is the API
      // group, not a component. A group node carries `services` and the page's aggregate `uptime`, but no
      // `days` of its own; its members do. Worst-of across the members, matching the badge convention for
      // a multi-component service (#379). An earlier cut of this parser required `days` and so skipped
      // the group entirely, silently dropping Mistral's uptime to "Not provided".
      const services = deref(o.services)
      if (!Array.isArray(services)) continue
      let worst: number | null = null
      for (const ref of services) {
        const member = deref(ref) as Record<string, unknown> | undefined
        if (!member || !('days' in member)) continue
        const pct = componentUptime(member)
        if (pct === null) continue
        if (worst === null || pct < worst) worst = pct
      }
      return worst
    }
    return null
  } catch (err) {
    console.warn('[parseInstatusUptime] failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/** #1006 — Instatus severity → the weights on /methodology (full outage 1.0, partial/degraded 0.3).
 *  An unknown severity is warned about and weighted as a partial rather than silently scored as zero
 *  downtime: a new Instatus level must not quietly inflate every affected service to 100%. */
function instatusSeverityWeight(severity: string): number {
  const s = severity.toUpperCase()
  if (s === 'CRITICAL' || s === 'HIGH' || s === 'MAJOR' || s === 'MAJOROUTAGE') return 1.0
  if (s === 'MEDIUM' || s === 'MINOR' || s === 'LOW' || s === 'PARTIALOUTAGE' || s === 'DEGRADEDPERFORMANCE') return 0.3
  if (s === 'MAINTENANCE' || s === 'UNDERMAINTENANCE' || s === 'OPERATIONAL' || s === 'NONE' || s === '') return 0
  console.warn(`[instatusSeverityWeight] unknown severity "${severity}" — counted as a partial outage`)
  return 0.3
}

// Warn-once (per component) on a Next.js payload-SHAPE change — the component map or the
// componentsUptime block we depend on went missing — so a parser that used to work silently
// reverting to "Not provided" is diagnosable, matching the warn-once convention of mapInstatusImpact /
// parseInstatusNextIncidents. A component that simply has no aggregate uptime is a legitimate null and
// stays silent (not a shape change).
const warnedInstatusNextUptime = new Set<string>()
function warnNextUptimeShape(componentName: string, reason: string): null {
  if (!warnedInstatusNextUptime.has(componentName)) {
    warnedInstatusNextUptime.add(componentName)
    console.warn(`[parseInstatusNextUptime] no uptime for "${componentName}": ${reason} — Instatus Next.js shape may have changed`)
  }
  return null
}

function parseInstatusNextUptime(html: string, componentName: string, nowMs: number, windowDays: number): number | null {
  // Resolve component name → id from the escaped payload (buildInstatusComponentMap reads the `\"`
  // form), then read componentsUptime[id] from the unescaped JSON.
  let id: string | undefined
  for (const [cid, name] of buildInstatusComponentMap(html)) {
    if (name === componentName) { id = cid; break }
  }
  if (!id) return warnNextUptimeShape(componentName, 'component not found in the Next.js component map')
  // Blanket `\"`→`"` unescape is safe here: componentsUptime values are all quote-free (uptime %,
  // ISO dates, status enums, numeric day-keys). A value with an embedded quote would corrupt the
  // slice and fail JSON.parse below → null (caught) — acceptable, since the data doesn't carry them.
  const u = html.replace(/\\"/g, '"')
  const key = '"componentsUptime":'
  const ki = u.indexOf(key)
  if (ki < 0) return warnNextUptimeShape(componentName, 'componentsUptime block absent')
  const objStart = u.indexOf('{', ki + key.length)
  const objEnd = objStart < 0 ? -1 : matchBrace(u, objStart)
  if (objEnd < 0) return warnNextUptimeShape(componentName, 'componentsUptime object could not be bounded')
  try {
    const cu = JSON.parse(u.slice(objStart, objEnd + 1)) as Record<string, InstatusNextUptimeEntry>
    const entry = cu[id]
    if (!entry) return null

    // #1006 — compute over the trailing 30 days from `outages` instead of copying `entry.uptime`, which
    // is the page's own aggregate over ITS period (these pages declare `maxUptimeDays: 90`). Every source
    // now produces a 30-day figure with the same weighting, which is what makes the ranking a ranking.
    if (!Array.isArray(entry.outages)) {
      return warnNextUptimeShape(componentName, 'componentsUptime entry carries no outages array')
    }
    const windowStart = nowMs - windowDays * 86_400_000
    // Collect (from, to, weight); the shared accumulator clamps an OPEN outage (`to` null → NaN) to now
    // and merges overlaps (worst-weight-wins) so an escalation isn't summed on top of itself.
    const intervals: OutageInterval[] = []
    for (const outage of entry.outages) {
      // Instatus states the impact fraction itself on a partial outage (`customImpactPercentage: 50`) —
      // use the provider's own number when they give it, and fall back to our documented weights when
      // they don't. Their figure is strictly better evidence than our 0.3 default.
      const weight = outage.isCustomPercentage && typeof outage.customImpactPercentage === 'number'
        ? outage.customImpactPercentage / 100
        : instatusSeverityWeight(String(outage.status ?? ''))
      if (weight === 0) continue
      intervals.push({ start: Date.parse(outage.from ?? ''), end: Date.parse(outage.to ?? ''), weight })
    }
    const weightedSec = weightedDowntimeSeconds(intervals, windowStart, nowMs)
    return Math.max(0, Math.floor((1 - weightedSec / (windowDays * 86_400)) * 10000) / 100)
  } catch (err) {
    console.warn('[parseInstatusNextUptime] failed:', err instanceof Error ? err.message : err)
    return null
  }
}

interface InstatusNextUptimeEntry {
  uptime?: string | number
  outages?: Array<{
    from?: string
    to?: string
    status?: string
    customImpactPercentage?: number | null
    isCustomPercentage?: boolean
  }>
}

/**
 * #1089 — why the incident parse reports a REASON instead of just `[]`.
 *
 * On the Instatus branch the badge is `hasOngoing ? 'degraded' : httpStatus` (`services.ts`), so an
 * empty incident list is what makes a service read as operational. That means "the payload changed
 * shape and we parsed nothing" and "this page genuinely has no incidents" had the same return value
 * and opposite meanings — a silent parse miss published a **false recovery** while an incident was
 * still open upstream. #761 removed one trigger (a 301'ing scrape URL); this distinguishes the class.
 *
 * NOT every `return []` inside the parse is a failure: the per-incident skips (a malformed entry, the
 * deliberate <60s micro-incident filter) are correct behavior on a healthy payload and must stay
 * invisible here. Only the STRUCTURAL exits — the payload envelope missing or unreadable — are
 * failures, because only those mean "we could not see the incident list at all".
 */
export type InstatusParseFailure =
  | 'no-nuxt-payload'   // the __NUXT_DATA__ script tag is absent / unterminated
  | 'no-incident-refs'  // payload parsed, but carries no `incidents-by-date` ref
  | 'no-incident-index' // the ref exists but points at nothing usable
  | 'bad-json'          // the payload is not valid JSON
  | 'no-next-notices'   // Next.js format: the `notices` envelope is absent
  | 'next-shape-changed' // Next.js format: the envelope is there but the payload no longer matches
  | 'scrape-unreadable' // set by the CALLER: the scrape fetch failed or returned non-ok

export type InstatusIncidentsResult =
  | { ok: true; incidents: Incident[] }
  | { ok: false; reason: InstatusParseFailure }

/**
 * Structural-failure-aware incident parse. `ok: true` with an empty array is a REAL "no incidents";
 * `ok: false` means we could not read the list and the caller must not treat that as recovery.
 */
export function parseInstatusIncidentsResult(html: string): InstatusIncidentsResult {
  // Instatus has two SSR formats: Nuxt (__NUXT_DATA__) and Next.js (__next_f)
  if (!html.includes('__NUXT_DATA__') && html.includes('__next_f')) {
    return parseInstatusNextIncidentsResult(html)
  }
  // Extract Nuxt SSR payload — match everything between the script tags, let JSON.parse validate
  const match = html.match(/__NUXT_DATA__[^>]*>([\s\S]*?)<\/script/)
  if (!match) return { ok: false, reason: 'no-nuxt-payload' }
  try {
    const arr: unknown[] = JSON.parse(match[1])

    // Find the data refs object containing an 'incidents-by-date' key (avoid hardcoded index)
    const dataRefs = arr.find(
      (item): item is Record<string, number> =>
        typeof item === 'object' && item !== null && !Array.isArray(item) &&
        Object.keys(item).some((k) => k.startsWith('incidents-by-date'))
    )
    if (!dataRefs) return { ok: false, reason: 'no-incident-refs' }
    const incKey = Object.keys(dataRefs).find((k) => k.startsWith('incidents-by-date'))!
    const incObj = arr[dataRefs[incKey]] as { incidents?: number } | undefined
    // `== null`, not `!`: a legitimate array index of 0 is falsy. Pre-existing, but #1089 escalated
    // the cost — it used to mean a silent `[]`, now it would mean sourceUnknown → a fabricated outage.
    if (incObj?.incidents == null) return { ok: false, reason: 'no-incident-index' }
    const incIndices = arr[incObj.incidents] as number[]
    if (!Array.isArray(incIndices)) return { ok: false, reason: 'no-incident-index' }
    // Deliberately inside the outer try, with no handler of its own: every entry maps within its own
    // try/catch (and so does the nested timeline flatMap), so nothing can escape here. An earlier cut
    // added an `entry-mapping-threw` reason for this — a diagnostic value that could never appear,
    // which is worse than no value, so it is gone.
    return { ok: true, incidents: parseNuxtIncidentEntries(arr, incIndices) }
  } catch {
    return { ok: false, reason: 'bad-json' }
  }
}

/**
 * Back-compat wrapper: collapses a structural failure back to `[]`. Callers that must distinguish the
 * two (i.e. anything deriving a STATUS) have to use `parseInstatusIncidentsResult` instead — that is
 * the whole point of #1089, so this stays for read-only consumers (tests, display paths).
 */
export function parseInstatusIncidents(html: string): Incident[] {
  const res = parseInstatusIncidentsResult(html)
  return res.ok ? res.incidents : []
}

/** The per-entry mapping, extracted so the structural exits above stay readable. */
function parseNuxtIncidentEntries(arr: unknown[], incIndices: number[]): Incident[] {
    // Parse all incidents, then limit to 20
    return incIndices.flatMap((idx) => {
      try {
        const inc = arr[idx] as Record<string, number>
        if (!inc || typeof inc !== 'object') return []
        const name = arr[inc.name] as string
        const status = (arr[inc.lastUpdateStatus] as string) ?? ''
        const createdAt = arr[inc.created_at] as string
        const durationSec = arr[inc.duration] as number | null
        const severity = arr[inc.severity] as string | undefined // #556 — Nuxt incident severity (e.g. 'MEDIUM')

        // Extract affected service name from services array (e.g. "Chat Completions API")
        const servicesArr = arr[inc.services] as number[] | undefined
        let affectedService = ''
        if (Array.isArray(servicesArr) && servicesArr.length > 0) {
          try {
            const svc = arr[servicesArr[0]] as Record<string, number>
            if (svc && typeof svc === 'object') affectedService = (arr[svc.name] as string) ?? ''
          } catch { /* ignore */ }
        }

        // Filter out micro-incidents (resolved in < 60s) — automated monitoring noise
        // Nuxt payload provides pre-computed duration (seconds), unlike Next.js which computes from timestamps
        if (status === 'RESOLVED' && durationSec != null && durationSec >= 0 && durationSec < 60) return []

        // Build descriptive title: "Completion API Degraded · Chat Completions API"
        const displayTitle = affectedService && !name.toLowerCase().includes(affectedService.toLowerCase())
          ? `${name} · ${affectedService}`
          : name

        // Parse incident updates
        const updatesArr = arr[inc.incidentUpdates] as number[] | undefined
        const timeline: TimelineEntry[] = (updatesArr ?? []).flatMap((ui) => {
          try {
            const u = arr[ui] as Record<string, number>
            if (!u || typeof u !== 'object') return []
            const uStatus = (arr[u.status] as string) ?? ''
            return [{
              stage: uStatus === 'RESOLVED' ? 'resolved' as const
                : uStatus === 'MONITORING' ? 'monitoring' as const
                : uStatus === 'IDENTIFIED' ? 'identified' as const
                : 'investigating' as const,
              text: (arr[u.description] as string) || null,
              at: arr[u.created_at] as string,
            }]
          } catch { return [] }
        }).reverse() // chronological: oldest → newest

        // #626 — Instatus's `duration` field is authoritative on the active-impact WINDOW: the
        // incident ran [createdAt, createdAt+duration]. The RESOLVED update's created_at is only when
        // the "resolved" MESSAGE was posted, which can be much later (a delayed status-page close —
        // e.g. a 2h40m Mistral incident whose resolved note was posted ~2 days later). Mistral's OWN UI
        // displays the resolution at createdAt+duration ("Jun 10 10:48", not the post time), so:
        //   • resolvedAt = createdAt + durationSec (the real resolution), and
        //   • the resolved TIMELINE entry is pinned to that time too (else it shows the late post time,
        //     a "resolved days later" entry that doesn't exist on the source page).
        // Fall back to the last resolved update's created_at only when Instatus omits durationSec.
        const resolvedIso = status === 'RESOLVED'
          ? (durationSec != null
              ? new Date(new Date(createdAt).getTime() + durationSec * 1000).toISOString()
              : ([...timeline].reverse().find((t) => t.stage === 'resolved')?.at ?? null))
          : null
        if (resolvedIso) {
          for (let i = timeline.length - 1; i >= 0; i--) {
            if (timeline[i].stage === 'resolved') { timeline[i] = { ...timeline[i], at: resolvedIso }; break }
          }
        }
        // duration = the `duration` field (active impact, what Mistral's badge shows + what the Score
        // MTTR / Recovery card read), NOT resolvedAt−startedAt. Fall back to the span only without it.
        // Only a RESOLVED incident has a final duration: Nuxt's `duration` field on an ACTIVE incident
        // is 0 (not yet resolved) → formatDuration floors it to "1m", which the Overview would render
        // as the recovery time on an ongoing incident. Leave null so the UI shows "Investigating"/
        // ongoing (mirrors the Next.js Instatus path + statuspage, which gate duration on resolution).
        const durationStr = status !== 'RESOLVED'
          ? null
          : durationSec != null
            ? formatDuration(new Date(createdAt), new Date(new Date(createdAt).getTime() + durationSec * 1000))
            : (resolvedIso ? formatDuration(new Date(createdAt), new Date(resolvedIso)) : null)

        return [{
          id: arr[inc.id] as string,
          title: displayTitle,
          status: status === 'RESOLVED' ? 'resolved' as const
            : status === 'MONITORING' ? 'monitoring' as const
            : status === 'IDENTIFIED' ? 'identified' as const
            : 'investigating' as const,
          impact: mapInstatusImpact(severity), // #556 — was hardcoded null; now maps the Nuxt `severity` field
          startedAt: createdAt,
          resolvedAt: resolvedIso,
          duration: durationStr,
          timeline,
        }]
      } catch { return [] }
    }).slice(0, 20)
}
