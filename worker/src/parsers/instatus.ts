// Instatus (Next.js SSR + Nuxt SSR) Parser — for status pages like Perplexity, Mistral

import type { TimelineEntry, Incident } from '../types'
import { formatDuration } from '../utils'

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
    }>

    const incidents: Incident[] = []
    for (const notice of Object.values(notices)) {
      if (incidents.length >= 5) break
      const startDate = new Date(notice.started)
      if (isNaN(startDate.getTime())) continue
      const resolvedDate = notice.resolved ? new Date(notice.resolved) : null
      const isResolved = notice.status === 'RESOLVED'

      const timeline: TimelineEntry[] = [
        { stage: 'investigating' as const, text: notice.name.default, at: startDate.toISOString() },
      ]
      if (isResolved && resolvedDate && !isNaN(resolvedDate.getTime())) {
        timeline.push({ stage: 'resolved' as const, text: 'Resolved', at: resolvedDate.toISOString() })
      }

      incidents.push({
        id: notice.id,
        title: notice.name.default,
        status: isResolved ? 'resolved' : 'investigating',
        impact: notice.impact === 'MAJOROUTAGE' ? 'major' : notice.impact === 'PARTIALOUTAGE' ? 'minor' : null,
        startedAt: startDate.toISOString(),
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

    // Parse each incident with per-item error isolation
    return incIndices.slice(0, 5).flatMap((idx) => {
      try {
        const inc = arr[idx] as Record<string, number>
        if (!inc || typeof inc !== 'object') return []
        const name = arr[inc.name] as string
        const status = (arr[inc.lastUpdateStatus] as string) ?? ''
        const createdAt = arr[inc.created_at] as string
        const durationSec = arr[inc.duration] as number | null

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
          title: name,
          status: status === 'RESOLVED' ? 'resolved' as const
            : status === 'MONITORING' ? 'monitoring' as const
            : status === 'IDENTIFIED' ? 'identified' as const
            : 'investigating' as const,
          impact: null,
          startedAt: createdAt,
          duration: durationSec ? formatDuration(new Date(createdAt), new Date(new Date(createdAt).getTime() + durationSec * 1000)) : null,
          timeline,
        }]
      } catch { return [] }
    })
  } catch {
    return []
  }
}
