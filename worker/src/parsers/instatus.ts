// Instatus (Next.js SSR + Nuxt SSR) Parser — for status pages like Perplexity, Mistral

import type { TimelineEntry, Incident } from '../types'
import { formatDuration } from '../utils'

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
// Component entries serialize as `"id":"…","name":{"default":"Website"}` (name has ONLY a `default`
// key); incident notices use `"name":{"en":…,"default":…}` (an `en` key first), so the
// `"name":{"default":` anchor matches component definitions but not notice names.
function buildInstatusComponentMap(html: string): Map<string, string> {
  const map = new Map<string, string>()
  const re = /\\"id\\":\\"([a-z0-9]+)\\",\\"name\\":\{\\"default\\":\\"([^\\"]+)\\"\}/g
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

// #761 — per-component snapshot for the ServiceDetails / is-down breakdown card. ONLY the Next.js
// Instatus SSR exposes a per-component `status` field; the Nuxt payload carries name/uptime/days but
// NO component status, so Nuxt services (e.g. Mistral) return [] here (status snapshot deferred for
// them). Reuses `buildInstatusComponentMap` — which isolates the TOP-LEVEL components (their children,
// e.g. fal's "Model API"/"Serverless API" under the "API" group, serialize differently and aren't
// matched), giving a uniform top-level granularity across services — then reads each component's
// `status` from the unescaped payload. Returns the Atlassian-shaped {id,name,status} so it feeds
// `resolveSvcComponents()` (with the service's `displayComponentIds`) exactly like a summary.json
// component list.
export function parseInstatusComponents(html: string): Array<{ id: string; name: string; status: string }> {
  if (!html.includes('__next_f') || html.includes('__NUXT_DATA__')) return []
  // Blanket `\"`→`"` unescape (safe — same rationale as parseInstatusNextUptime): component objects
  // carry no embedded quotes in the fields we read (id, name.default, status enum).
  const u = html.replace(/\\"/g, '"')
  const out: Array<{ id: string; name: string; status: string }> = []
  for (const [id, name] of buildInstatusComponentMap(html)) {
    const anchor = `"id":"${id}","name":{"default":`
    const at = u.indexOf(anchor)
    if (at < 0) continue
    // The component's own `status` is the first one after the anchor (it precedes any `children`
    // array), so a bounded forward search reads the parent's status, not a child's.
    const m = u.slice(at, at + 600).match(/"status":"([A-Z_]+)"/)
    out.push({ id, name, status: instatusComponentStatusToStatuspage(m ? m[1] : 'OPERATIONAL') })
  }
  return out
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
export function parseInstatusUptime(html: string, componentName: string | undefined): number | null {
  if (!componentName) return null
  if (html.includes('__NUXT_DATA__')) return parseInstatusNuxtUptime(html, componentName)
  if (html.includes('__next_f')) return parseInstatusNextUptime(html, componentName)
  return null
}

function parseInstatusNuxtUptime(html: string, componentName: string): number | null {
  const match = html.match(/__NUXT_DATA__[^>]*>([\s\S]*?)<\/script/)
  if (!match) return null
  try {
    const arr: unknown[] = JSON.parse(match[1])
    const deref = (v: unknown) => (typeof v === 'number' ? arr[v] : v) // Nuxt scalars are index refs
    for (const item of arr) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const o = item as Record<string, unknown>
      if (!('uptime' in o) || !('name' in o)) continue
      if (deref(o.name) !== componentName) continue
      const up = deref(o.uptime)
      if (typeof up === 'number' && up >= 0 && up <= 100) return up
    }
    return null
  } catch (err) {
    console.warn('[parseInstatusUptime] failed:', err instanceof Error ? err.message : err)
    return null
  }
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

function parseInstatusNextUptime(html: string, componentName: string): number | null {
  // Resolve component name → id from the escaped payload (buildInstatusComponentMap reads the `\"`
  // form), then read componentsUptime[id].uptime from the unescaped JSON.
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
    const cu = JSON.parse(u.slice(objStart, objEnd + 1)) as Record<string, { uptime?: string | number }>
    const raw = cu[id]?.uptime
    const up = typeof raw === 'string' ? parseFloat(raw) : raw
    if (typeof up === 'number' && !isNaN(up) && up >= 0 && up <= 100) return up
    return null // component legitimately has no aggregate uptime (or out of range) — not a shape change
  } catch (err) {
    console.warn('[parseInstatusNextUptime] failed:', err instanceof Error ? err.message : err)
    return null
  }
}

export function parseInstatusIncidents(html: string): Incident[] {
  // Instatus has two SSR formats: Nuxt (__NUXT_DATA__) and Next.js (__next_f)
  if (!html.includes('__NUXT_DATA__') && html.includes('__next_f')) {
    return parseInstatusNextIncidents(html)
  }
  // Extract Nuxt SSR payload — match everything between the script tags, let JSON.parse validate
  const match = html.match(/__NUXT_DATA__[^>]*>([\s\S]*?)<\/script/)
  if (!match) return []
  try {
    const arr: unknown[] = JSON.parse(match[1])

    // Find the data refs object containing an 'incidents-by-date' key (avoid hardcoded index)
    const dataRefs = arr.find(
      (item): item is Record<string, number> =>
        typeof item === 'object' && item !== null && !Array.isArray(item) &&
        Object.keys(item).some((k) => k.startsWith('incidents-by-date'))
    )
    if (!dataRefs) return []
    const incKey = Object.keys(dataRefs).find((k) => k.startsWith('incidents-by-date'))!
    const incObj = arr[dataRefs[incKey]] as { incidents?: number } | undefined
    if (!incObj?.incidents) return []
    const incIndices = arr[incObj.incidents] as number[]
    if (!Array.isArray(incIndices)) return []

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
  } catch {
    return []
  }
}
