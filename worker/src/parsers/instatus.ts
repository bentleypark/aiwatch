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
        }).reverse()

        return [{
          id: arr[inc.id] as string,
          title: displayTitle,
          status: status === 'RESOLVED' ? 'resolved' as const
            : status === 'MONITORING' ? 'monitoring' as const
            : status === 'IDENTIFIED' ? 'identified' as const
            : 'investigating' as const,
          impact: mapInstatusImpact(severity), // #556 — was hardcoded null; now maps the Nuxt `severity` field
          startedAt: createdAt,
          resolvedAt: (status === 'RESOLVED' && durationSec != null) ? new Date(new Date(createdAt).getTime() + durationSec * 1000).toISOString() : null,
          duration: durationSec ? formatDuration(new Date(createdAt), new Date(new Date(createdAt).getTime() + durationSec * 1000)) : null,
          timeline,
        }]
      } catch { return [] }
    }).slice(0, 20)
  } catch {
    return []
  }
}
