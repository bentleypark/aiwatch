// incident.io Parsers — uptime, component impacts, incident text enrichment

import type { TimelineEntry, Incident, DailyImpactLevel } from '../types'
import { fetchWithTimeout } from '../utils'
import { INCIDENT_IO_IMPACT_WEIGHTS } from './impact-weights'

export function parseIncidentIoUptime(html: string, componentId: string, groupId?: string): number | null {
  const chunks = html.match(/self\.__next_f\.push\(\[1,([\s\S]*?)\]\)\s*<\/script/g) ?? []
  for (const chunk of chunks) {
    if (!chunk.includes('component_uptimes')) continue
    // Search only within the component_uptimes section to avoid matching the same
    // componentId in component_impacts (incident data) which would then greedily
    // skip ahead to the wrong uptime value from a different component.
    const uptimesIdx = chunk.indexOf('component_uptimes')
    const uptimesSection = chunk.substring(uptimesIdx)

    // 1. Try group uptime first (e.g. "APIs 99.99%" aggregate)
    //    Group uptimes have component_id=$undefined with a status_page_component_group_id
    if (groupId) {
      const groupRe = new RegExp(
        `\\\\"component_id\\\\":\\\\"\\$undefined\\\\"[\\s\\S]*?\\\\"status_page_component_group_id\\\\":\\\\"${groupId}\\\\"[\\s\\S]*?\\\\"uptime\\\\":\\\\"([^\\\\"]*)\\\\"`
      )
      const groupMatch = uptimesSection.match(groupRe)
      if (groupMatch) {
        const pct = parseFloat(groupMatch[1])
        if (!isNaN(pct) && pct >= 0 && pct <= 100) return pct
      }
    }

    // 2. Fall back to individual component uptime
    const re = new RegExp(
      `\\\\"component_id\\\\":\\\\"${componentId}\\\\"[\\s\\S]*?\\\\"uptime\\\\":\\\\"([^\\\\"]*)\\\\"`
    )
    const match = uptimesSection.match(re)
    if (!match) continue
    const raw = match[1]
    if (raw === '$undefined' || raw === '') return null
    const pct = parseFloat(raw)
    if (isNaN(pct) || pct < 0 || pct > 100) {
      console.warn(`[parseIncidentIoUptime] unexpected uptime value "${raw}" for ${componentId}`)
      return null
    }
    return pct
  }
  return null
}

export function parseIncidentIoComponentImpacts(html: string, componentId: string): Record<string, DailyImpactLevel> {
  const result: Record<string, DailyImpactLevel> = {}
  const chunks = html.match(/self\.__next_f\.push\(\[1,([\s\S]*?)\]\)\s*<\/script/g) ?? []
  for (const chunk of chunks) {
    if (!chunk.includes('component_impacts')) continue
    // Extract array between component_impacts and component_uptimes
    const idx1 = chunk.indexOf('component_impacts')
    const idx2 = chunk.indexOf('component_uptimes')
    if (idx1 === -1 || idx2 === -1 || idx2 <= idx1) continue
    const segment = chunk.substring(idx1, idx2)
    const arrStart = segment.indexOf('[')
    const arrEnd = segment.lastIndexOf(']')
    if (arrStart === -1 || arrEnd === -1) continue
    let raw = segment.substring(arrStart, arrEnd + 1)
    // Unescape: \\" → "
    raw = raw.replace(/\\"/g, '"')
    raw = raw.replace(/"\$undefined"/g, 'null')

    try {
      const impacts = JSON.parse(raw) as Array<{
        component_id: string; start_at: string; end_at: string; status: string
      }>
      // Filter by target component for Phase 1 accuracy; Phase 2 (incidents) fills in other components
      const mine = impacts.filter((i) => i.component_id === componentId)
      for (const impact of mine) {
        const start = new Date(impact.start_at)
        const end = new Date(impact.end_at)
        if (isNaN(start.getTime()) || isNaN(end.getTime())) continue
        // Skip impacts shorter than 10 minutes (matches official calendar threshold)
        if (end.getTime() - start.getTime() < 600_000) continue

        // Map status to DailyImpactLevel
        const level: DailyImpactLevel =
          impact.status === 'full_outage' ? 'critical'
          : impact.status === 'partial_outage' ? 'major'
          : 'minor' // degraded_performance

        // Mark each UTC day the impact spans
        const dayMs = 86_400_000
        const startDay = new Date(start.toISOString().split('T')[0]).getTime()
        const endDay = new Date(end.toISOString().split('T')[0]).getTime()
        for (let d = startDay; d <= endDay; d += dayMs) {
          const dateStr = new Date(d).toISOString().split('T')[0]
          // Keep worst level per day: critical > major > minor
          const existing = result[dateStr]
          if (!existing || level === 'critical' || (level === 'major' && existing === 'minor')) {
            result[dateStr] = level
          }
        }
      }
    } catch (err) {
      console.warn('[parseIncidentIoComponentImpacts] parse failed:', err instanceof Error ? err.message : err)
    }
    break
  }
  return result
}

/** Resolve impact severity → weight. Returns null for informational/null impact;
 *  -1 sentinel for unknown levels (caller should warn + skip). */
function resolveImpactWeight(impact: Incident['impact']): number | null {
  if (impact === null) return null
  if (impact in INCIDENT_IO_IMPACT_WEIGHTS) return INCIDENT_IO_IMPACT_WEIGHTS[impact]
  return -1
}

export function computeUptimeFromIncidents(incidents: Incident[]): number | null {
  // No incidents at all → return null (no data) rather than asserting 100%
  if (incidents.length === 0) return null

  const now = Date.now()
  const windowMs = 90 * 86_400_000
  const windowStart = now - windowMs

  // Collect weighted intervals; track skip categories so we can return null (vs. 100)
  // when the entire impactful feed is unusable.
  //   parseErrorSkips: structural errors (unknown impact, bad date, future date)
  //   noEndSkips: incident.io data-quality cases (resolved status, no recoverable end)
  // Both categories indicate "we can't measure outage" and should suppress a misleading
  // 100% claim when no usable intervals remain.
  const intervals: Array<{ start: number; end: number; weight: number }> = []
  let parseErrorSkips = 0
  let noEndSkips = 0
  let noEndSampleId: string | null = null
  // Dedup per-call to prevent Logpush spam when upstream emits a new impact level
  // or many malformed entries across many incidents.
  const unknownImpacts = new Set<string>()
  for (const inc of incidents) {
    const weight = resolveImpactWeight(inc.impact)
    if (weight === null) continue // informational
    if (weight === -1) {
      unknownImpacts.add(String(inc.impact))
      parseErrorSkips++
      continue
    }
    const start = new Date(inc.startedAt).getTime()
    if (isNaN(start)) {
      console.warn(`[computeUptimeFromIncidents] invalid startedAt "${inc.startedAt}" for ${inc.id} — skipping`)
      parseErrorSkips++
      continue
    }
    if (start >= now) {
      console.warn(`[computeUptimeFromIncidents] future-dated startedAt for ${inc.id} (clock skew?) — skipping`)
      parseErrorSkips++
      continue
    }

    // Defensive: timeline is typed as required but parser contracts vary; optional
    // chaining prevents a single malformed incident from throwing and aborting the
    // whole batch (which would lose the post-loop dedup warns).
    let endMs: number | null = null
    if (inc.status === 'resolved' && inc.duration) {
      const hours = parseInt(inc.duration.match(/(\d+)h/)?.[1] ?? '0')
      const mins = parseInt(inc.duration.match(/(\d+)m/)?.[1] ?? '0')
      const parsed = start + (hours * 3600 + mins * 60) * 1000
      if (parsed > start) {
        endMs = parsed
      } else {
        // Duration parsed to 0 — try resolved timestamp from timeline
        const resolvedEntry = inc.timeline?.find((t) => t.stage === 'resolved')
        if (resolvedEntry) {
          const resolvedMs = new Date(resolvedEntry.at).getTime()
          if (!isNaN(resolvedMs) && resolvedMs > start) endMs = resolvedMs
        }
      }
    } else if (inc.status === 'resolved') {
      // No duration string — fall back to resolved timestamp
      const resolvedEntry = inc.timeline?.find((t) => t.stage === 'resolved')
      if (resolvedEntry) {
        const resolvedMs = new Date(resolvedEntry.at).getTime()
        if (!isNaN(resolvedMs) && resolvedMs > start) endMs = resolvedMs
      }
    } else {
      endMs = now // unresolved → ongoing outage
    }

    if (endMs === null || endMs <= start) {
      noEndSkips++
      if (noEndSampleId === null) noEndSampleId = inc.id
      continue
    }

    // Clamp to 90-day window; guard against zero-length intervals after clamping
    if (endMs > windowStart) {
      const clampedStart = Math.max(start, windowStart)
      const clampedEnd = Math.min(endMs, now)
      if (clampedEnd > clampedStart) {
        intervals.push({ start: clampedStart, end: clampedEnd, weight })
      }
    }
  }

  if (unknownImpacts.size > 0) {
    console.warn(`[computeUptimeFromIncidents] unknown impact level(s): ${[...unknownImpacts].join(', ')} — update INCIDENT_IO_IMPACT_WEIGHTS`)
  }
  if (noEndSkips > 0) {
    console.warn(`[computeUptimeFromIncidents] ${noEndSkips} resolved incident(s) had no recoverable end timestamp (first of ${noEndSkips}: ${noEndSampleId}) — likely upstream data-quality issue`)
  }

  if (intervals.length === 0) {
    // Distinguish informational-only feed (genuinely no outages → 100) from a feed
    // where every impactful entry was unusable (return null — claiming 100 would mislead).
    const totalSkips = parseErrorSkips + noEndSkips
    const impactfulCount = incidents.filter(i => i.impact !== null).length
    return totalSkips > 0 && totalSkips === impactfulCount ? null : 100
  }

  // Sweep events to compute weighted outage with max-weight-wins overlap handling.
  // E.g. minor (0.3) overlapping major (1.0) contributes 1.0 weight in the overlap window —
  // matches Atlassian's behavior where the more severe component status dominates.
  const events: Array<{ t: number; weight: number; type: 'start' | 'end' }> = []
  for (const iv of intervals) {
    events.push({ t: iv.start, weight: iv.weight, type: 'start' })
    events.push({ t: iv.end, weight: iv.weight, type: 'end' })
  }
  events.sort((a, b) => a.t - b.t || (a.type === 'end' ? -1 : 1))

  let weightedOutageMs = 0
  let lastT = events[0].t
  const active: number[] = []
  for (const ev of events) {
    if (ev.t > lastT && active.length > 0) {
      const maxWeight = Math.max(...active)
      weightedOutageMs += (ev.t - lastT) * maxWeight
    }
    if (ev.type === 'start') {
      active.push(ev.weight)
    } else {
      const idx = active.indexOf(ev.weight)
      if (idx >= 0) active.splice(idx, 1)
    }
    lastT = ev.t
  }

  // Use Math.floor (not round) to match statuspage.ts and avoid overstating uptime
  // (e.g. 99.998% must not appear as 100%).
  return Math.max(0, Math.floor((1 - weightedOutageMs / windowMs) * 10000) / 100)
}

interface IncidentIoUpdate {
  stage: TimelineEntry['stage']
  text: string
  at: string
}

export function parseIncidentIoUpdates(html: string): IncidentIoUpdate[] {
  const results: IncidentIoUpdate[] = []
  const chunks = html.match(/self\.__next_f\.push\(\[1,([\s\S]*?)\]\)\s*<\/script/g) ?? []
  for (const chunk of chunks) {
    // Quotes inside __next_f JS strings are escaped as \" so match \\"...\\"
    const re = /\\"message_string\\":\\"((?:[^\\"\\\\]|\\\\.)*)\\",\\"published_at\\":\\"([^\\"]+)\\",\\"to_status\\":\\"([^\\"]+)\\"/g
    let m
    while ((m = re.exec(chunk)) !== null) {
      const [, rawText, at, toStatus] = m
      if (!rawText) continue
      // Unescape JS-string double-encoding (\\n → \n, \\\\ → \\, etc.)
      let text: string
      try { text = JSON.parse(`"${rawText}"`) } catch { text = rawText }
      const stage: TimelineEntry['stage'] =
        toStatus === 'resolved' ? 'resolved'
        : toStatus === 'monitoring' ? 'monitoring'
        : toStatus === 'identified' ? 'identified'
        : 'investigating'
      results.push({ stage, text, at })
    }
  }
  return results
}

export interface IncidentTextCache {
  textByKey: Record<string, string | null>  // key = "stage:at" (matches parseIncidents dedup key)
  cachedAt: string
}

async function readIncidentTextCache(kv: KVNamespace, incidentIds: string[]): Promise<Map<string, IncidentTextCache>> {
  const results = await Promise.all(
    incidentIds.map((id) =>
      kv.get(`inctext:${id}`).catch((err) => {
        console.error(`[inctext cache] KV read failed for ${id}:`, err instanceof Error ? err.message : err)
        return null
      })
    )
  )
  const map = new Map<string, IncidentTextCache>()
  results.forEach((raw, i) => {
    if (!raw) return
    try {
      const parsed = JSON.parse(raw)
      // Runtime shape check — guards against schema changes or corrupt entries causing applyTextCache to throw
      if (parsed && typeof parsed === 'object' && typeof parsed.textByKey === 'object' && parsed.textByKey !== null) {
        map.set(incidentIds[i], parsed as IncidentTextCache)
      } else {
        console.warn(`[inctext cache] unexpected shape for incident ${incidentIds[i]} — discarding`)
      }
    } catch {
      console.warn(`[inctext cache] corrupt KV entry for incident ${incidentIds[i]} — discarding`)
    }
  })
  return map
}

export function applyTextCache(inc: Incident, cache: IncidentTextCache): Incident {
  return {
    ...inc,
    timeline: inc.timeline.map((entry) => {
      if (entry.text !== null) return entry
      const cached = cache.textByKey[`${entry.stage}:${entry.at}`]
      // cached===undefined means key absent (not yet scraped); null means scraped but no text found
      return cached !== undefined ? { ...entry, text: cached } : entry
    }),
  }
}

export function buildTextCache(inc: Incident): IncidentTextCache {
  const textByKey: Record<string, string | null> = {}
  for (const entry of inc.timeline) textByKey[`${entry.stage}:${entry.at}`] = entry.text
  return { textByKey, cachedAt: new Date().toISOString() }
}

// pageUrls: incidentId → direct detail page URL (from Atlassian API shortlink).
// Constructing URLs from inc.id is unreliable because incident.io Atlassian-compat IDs
// may differ from the native ULID used in detail page URLs.
export async function enrichIncidentIoText(incidents: Incident[], baseUrl: string, pageUrls: Map<string, string>, kv?: KVNamespace): Promise<Incident[]> {
  // Phase 1: Apply cached text from KV for all incidents that have null-text entries.
  // KV reads do not count toward the 50 subrequest limit, so we read for all candidates freely.
  let workingIncidents = incidents
  const needsText = incidents.filter((inc) => inc.timeline.some((t) => !t.text))
  if (kv && needsText.length > 0) {
    const cacheMap = await readIncidentTextCache(kv, needsText.map((i) => i.id))
    if (cacheMap.size > 0) {
      workingIncidents = incidents.map((inc) => {
        const cached = cacheMap.get(inc.id)
        return cached ? applyTextCache(inc, cached) : inc
      })
    }
  }

  // Phase 2: Scrape incidents still missing text after cache application (up to budget=1).
  // Budget = 1 per service: 44 base requests + 6 services × 1 = 50 (at Cloudflare free tier limit).
  // Prioritise: non-resolved first (may get new updates), then most recently started.
  const toEnrich = workingIncidents
    .filter((inc) => inc.timeline.some((t) => !t.text))
    .sort((a, b) => {
      const resolvedDiff = (a.status === 'resolved' ? 1 : 0) - (b.status === 'resolved' ? 1 : 0)
      if (resolvedDiff !== 0) return resolvedDiff
      return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    })
    .slice(0, 1)

  if (toEnrich.length === 0) return workingIncidents

  const enriched = new Map<string, Incident>()
  await Promise.all(toEnrich.map(async (inc) => {
    try {
      const url = pageUrls.get(inc.id) ?? `${baseUrl}/${inc.id}`
      const res = await fetchWithTimeout(url, 5000)
      if (!res.ok) {
        console.warn(`[enrichIncidentIoText] ${inc.id} returned HTTP ${res.status}`)
        res.body?.cancel()
        return
      }
      const html = await res.text()
      const allUpdates = parseIncidentIoUpdates(html)
      if (allUpdates.length === 0) {
        console.warn(`[enrichIncidentIoText] ${inc.id} — page fetched OK but no updates parsed (HTML structure may have changed)`)
        return
      }

      // The incident.io SSR payload may include updates from multiple incidents.
      // Scope to updates within the target incident's time window (±1h) to avoid
      // cross-incident pollution (e.g., Pinned chats entries appearing in SSO incident).
      const entryTimes = inc.timeline.map((t) => new Date(t.at).getTime())
      const windowStart = Math.min(...entryTimes) - 3_600_000
      const windowEnd   = Math.max(...entryTimes) + 3_600_000
      const updates = allUpdates.filter((u) => {
        const t = new Date(u.at).getTime()
        return t >= windowStart && t <= windowEnd
      })
      if (updates.length === 0) {
        console.warn(`[enrichIncidentIoText] ${inc.id} — ${allUpdates.length} updates found but all filtered by time window`)
        return
      }

      const STAGE_ORDER: Record<string, number> = { investigating: 0, identified: 1, monitoring: 2, resolved: 3 }
      const usedUpdateIndices = new Set<number>()

      const enrichedIncident: Incident = {
        ...inc,
        timeline: inc.timeline.map((entry) => {
          if (entry.text) return entry
          const entryMs = new Date(entry.at).getTime()
          // 1st: exact match — same stage + within 10 min (handles most cases)
          const exactIdx = updates.findIndex((u, i) =>
            !usedUpdateIndices.has(i) &&
            u.stage === entry.stage &&
            Math.abs(new Date(u.at).getTime() - entryMs) < 600_000
          )
          if (exactIdx !== -1) {
            usedUpdateIndices.add(exactIdx)
            return { ...entry, text: updates[exactIdx].text }
          }
          // 2nd: timestamp-only match within 10 min — handles stage label mismatch between
          // incident.io HTML and Atlassian-compat API (they use different status vocabularies).
          // Only allow adjacent stages (investigating↔identified, identified↔monitoring,
          // monitoring↔resolved) to avoid assigning clearly wrong text across distant stages.
          const candidates = updates
            .map((u, i) => ({ u, i }))
            .filter(({ u, i }) => {
              if (usedUpdateIndices.has(i)) return false
              const dist = Math.abs((STAGE_ORDER[entry.stage] ?? 0) - (STAGE_ORDER[u.stage] ?? 0))
              return dist <= 1 && Math.abs(new Date(u.at).getTime() - entryMs) < 600_000
            })
            .sort((a, b) => Math.abs(new Date(a.u.at).getTime() - entryMs) - Math.abs(new Date(b.u.at).getTime() - entryMs))
          if (candidates.length > 0) {
            usedUpdateIndices.add(candidates[0].i)
            return { ...entry, text: candidates[0].u.text }
          }
          return entry
        }),
      }
      enriched.set(inc.id, enrichedIncident)

      // Phase 3: Persist scraped text to KV. Must be awaited — unawaited KV writes are cancelled
      // when the Worker terminates after the response. Latency is negligible (~10-50ms) since
      // we already spent up to 5s on HTTP scraping. A single write failure is non-critical
      // (next invocation re-scrapes), but persistent failures exhaust the enrichment budget.
      // Resolved: 90-day TTL (rarely changes). Active: 30-min TTL (may receive new updates).
      if (kv) {
        const ttl = enrichedIncident.status === 'resolved' ? 90 * 86_400 : 30 * 60
        try {
          const payload = JSON.stringify(buildTextCache(enrichedIncident))
          await kv.put(`inctext:${inc.id}`, payload, { expirationTtl: ttl })
            .catch((err) => console.error(`[inctext cache] write failed for ${inc.id}:`, err))
        } catch (buildErr) {
          console.error(`[inctext cache] failed to serialize cache for ${inc.id}:`, buildErr instanceof Error ? buildErr.message : buildErr)
        }
      }
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'AbortError'
      if (isTimeout) {
        console.error(`[enrichIncidentIoText] timeout enriching ${inc.id}`)
      } else {
        console.warn(`[enrichIncidentIoText] failed to enrich ${inc.id}:`, err instanceof Error ? err.message : err)
      }
    }
  }))

  return workingIncidents.map((inc) => enriched.get(inc.id) ?? inc)
}
