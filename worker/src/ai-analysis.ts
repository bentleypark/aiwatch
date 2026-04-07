// AI Analysis — Claude Sonnet API call for incident analysis
// Triggered only when incidents are detected (not on every cron cycle)

import type { Incident, ServiceStatus } from './types'
import { sanitize, kvPut, kvDel, type KVLike } from './utils'

/**
 * Detect boilerplate timeline entries that contain no actionable technical detail.
 * Returns true if the text is generic/templated (e.g., "We are investigating this issue").
 */
const BOILERPLATE_PATTERNS = [
  /^we are (currently )?(investigating|looking into|aware of)/i,
  /^(this |the )?(incident |issue )?(has been |is being |is )?(resolved|fixed)/i,
  /^a fix has been (implemented|deployed|applied)(.* (monitor|result|status).*)?/i,
  /^we (are|have been) (continuing to )?(monitor|investigate)/i,
  /^(monitoring|investigating|identified|resolved)\.?$/i,
  /^the (issue|incident|problem) (has been )?(identified|resolved)/i,
  /^we('re| are) (still )?(working on|looking into)/i,
  /^(this|the) (incident|issue) is (being )?(monitored|investigated)/i,
]

export function isBoilerplate(text: string | null | undefined): boolean {
  if (!text) return true
  const trimmed = text.trim()
  if (trimmed.length < 15) return true  // too short to be meaningful
  // Only boilerplate if the pattern covers most of the text (no appended technical detail)
  return BOILERPLATE_PATTERNS.some(p => {
    const m = trimmed.match(p)
    if (!m) return false
    const remaining = trimmed.slice(m[0].length).replace(/[.\s,;:!]+/g, '')
    return remaining.length < 20
  })
}

export interface AIAnalysisResult {
  summary: string
  estimatedRecovery: string
  estimatedRecoveryHours?: number  // upper bound parsed from estimatedRecovery (e.g., "4–6h" → 6)
  affectedScope: string[]
  analyzedAt: string
  incidentId: string
  resolvedAt?: string
  timelineHash?: string  // latest timeline entry timestamp — used to skip re-analysis when unchanged
}

/**
 * Parse estimated recovery string to hours (upper bound).
 * "4–6h" → 6, "30m–1h" → 1, "2h" → 2, "15–45m" → 0.75, "N/A" → null
 */
export function parseRecoveryHours(recovery: string): number | null {
  if (!recovery || recovery === 'N/A') return null
  // Split on range separator (–, -, ~) and take the last (upper bound) part
  const parts = recovery.split(/[–\-~]/).map(s => s.trim()).filter(Boolean)
  const upper = parts[parts.length - 1]
  if (!upper) return null
  const hMatch = upper.match(/(\d+(?:\.\d+)?)\s*h/i)
  const mMatch = upper.match(/(\d+(?:\.\d+)?)\s*m/i)
  let hours = 0
  if (hMatch) hours += parseFloat(hMatch[1])
  if (mMatch) hours += parseFloat(mMatch[1]) / 60
  if (hours <= 0) {
    console.warn(`[ai-analysis] Could not parse recovery hours from: "${recovery}"`)
  }
  return hours > 0 ? Math.round(hours * 100) / 100 : null
}

/** Centralized KV key for per-incident analysis */
export function analysisKey(svcId: string, incId: string): string {
  return `ai:analysis:${svcId}:${incId}`
}

/**
 * Find similar past incidents by keyword overlap with current incident title.
 * Returns up to 5 most relevant recent incidents.
 */
export function findSimilarIncidents(
  currentTitle: string,
  allIncidents: Incident[],
  limit = 5,
): Incident[] {
  const keywords = currentTitle.toLowerCase().split(/[\s\-—·:,]+/).filter(w => w.length > 3)
  if (keywords.length === 0) return allIncidents.filter(i => i.status === 'resolved').slice(0, limit)

  return allIncidents
    .filter(i => i.status === 'resolved')
    .map(i => {
      const titleLower = i.title.toLowerCase()
      const score = keywords.filter(k => titleLower.includes(k)).length
      return { incident: i, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ incident }) => incident)
}

/**
 * Build prompt for Claude Sonnet analysis.
 */
// System prompt (trusted instructions) — separated from untrusted data
const SYSTEM_PROMPT = `You are an AI service reliability analyst for AIWatch.
Analyze the incident data provided by the user and respond in JSON format ONLY:
{
  "summary": "Concise analysis (max 2 sentences). Identify if this is a recurring pattern or a new type of failure (e.g., network vs model).",
  "estimatedRecovery": "Short range using abbreviations ONLY. Format: '30m–1h' or '1–3h'. Use m for minutes, h for hours. Never write 'minutes' or 'hours' in full. If no data, return 'N/A'.",
  "affectedScope": ["1-3 specific features or related sub-services likely impacted"]
}

Rules:
- If the incident title contains specific environment keywords (e.g., 'Chrome', 'Cowork', 'API'), prioritize them in the summary.
- Recovery estimate MUST use short format: '30m–1h', '1–3h', '15–45m'. Never write 'minutes' or 'hours' in full words.
- If Timeline Updates are provided, incorporate the LATEST status and progress into your analysis. Reflect whether the situation is improving, worsening, or unchanged.
- Keep the tone professional, objective, and data-driven.
- Do not include any text outside the JSON block.`

/**
 * Build user message with incident data (untrusted — separated from system instructions).
 */
export function buildAnalysisPrompt(
  serviceName: string,
  currentIncident: { title: string; status: string; startedAt: string; impact: string | null; timeline?: Array<{ stage: string; text: string | null; at: string }> },
  similarIncidents: Incident[],
  prevPrediction?: { estimatedRecoveryHours: number; elapsedHours: number },
): string {
  const historyText = similarIncidents.length > 0
    ? similarIncidents.map(i =>
        `- "${sanitize(i.title).slice(0, 100)}" (${sanitize(i.duration ?? 'unknown duration').slice(0, 30)}, impact: ${sanitize(i.impact ?? 'unknown').slice(0, 20)})`
      ).join('\n').slice(0, 1000)
    : 'No similar past incidents found.'

  const safeName = sanitize(serviceName).slice(0, 100)
  const safeTitle = sanitize(currentIncident.title).slice(0, 200)
  const safeStatus = sanitize(currentIncident.status).slice(0, 20)
  const safeImpact = sanitize(currentIncident.impact ?? 'unknown').slice(0, 20)

  // Include timeline updates for richer re-analysis context (most recent entries, line-safe truncation)
  const timelineLines = (currentIncident.timeline ?? [])
    .slice(-10)
    .map(t => `- [${sanitize(t.stage).slice(0, 20)}] ${sanitize(t.at).slice(0, 30)}: ${sanitize(t.text ?? '').slice(0, 200)}`)
  let timelineText = ''
  for (const line of timelineLines) {
    if (timelineText.length + line.length + 1 > 1500) break
    timelineText += (timelineText ? '\n' : '') + line
  }

  const prevPredictionText = prevPrediction
    ? `\nPrevious Prediction: Estimated recovery in ${prevPrediction.estimatedRecoveryHours}h, but ${Math.round(prevPrediction.elapsedHours)}h have elapsed and the incident remains unresolved. The previous prediction was incorrect — re-evaluate with updated context.\n`
    : ''

  return `<incident_data>
Service: ${safeName}
Current Incident: "${safeTitle}"
Status: ${safeStatus}
Started: ${sanitize(currentIncident.startedAt).slice(0, 30)}
Impact: ${safeImpact}
${prevPredictionText}${timelineText ? `\nTimeline Updates:\n${timelineText}\n` : ''}
Historical Data (last 30 days):
${historyText}
</incident_data>`
}

/**
 * Call Claude Sonnet API and parse the response.
 */
export async function analyzeIncident(
  apiKey: string,
  serviceName: string,
  currentIncident: { id: string; title: string; status: string; startedAt: string; impact: string | null; timeline?: Array<{ stage: string; text: string | null; at: string }> },
  allIncidents: Incident[],
  prevPrediction?: { estimatedRecoveryHours: number; elapsedHours: number },
): Promise<AIAnalysisResult | null> {
  const similar = findSimilarIncidents(currentIncident.title, allIncidents)
  const prompt = buildAnalysisPrompt(serviceName, currentIncident, similar, prevPrediction)

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {
      console.error(`[ai-analysis] Claude API returned ${res.status}: ${await res.text().catch(() => '')}`)
      return null
    }

    const data = await res.json() as { content: Array<{ type: string; text?: string }> }
    const text = data.content?.find(c => c.type === 'text')?.text
    if (!text) return null

    // Extract JSON from response (may be wrapped in markdown code block)
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[0]) as {
      summary?: string
      estimatedRecovery?: string
      affectedScope?: string[]
    }

    // Normalize recovery time format: "17 minutes to 9 hours" → "17m–9h"
    let recovery = sanitize(parsed.estimatedRecovery ?? 'N/A')
    recovery = recovery
      .replace(/(\d+)\s*minutes?/gi, '$1m')
      .replace(/(\d+)\s*hours?/gi, '$1h')
      .replace(/\s*to\s*/g, '–')
    // Store latest timeline entry timestamp to detect new updates on re-analysis
    const latestTimelineAt = currentIncident.timeline?.at(-1)?.at ?? ''
    const recoveryHours = parseRecoveryHours(recovery)
    return {
      summary: sanitize(parsed.summary ?? 'Analysis unavailable'),
      estimatedRecovery: recovery,
      ...(recoveryHours != null && { estimatedRecoveryHours: recoveryHours }),
      affectedScope: (parsed.affectedScope ?? []).map(s => sanitize(s)),
      analyzedAt: new Date().toISOString(),
      incidentId: currentIncident.id,
      timelineHash: latestTimelineAt,
    }
  } catch (err) {
    console.error('[ai-analysis] Failed:', err instanceof Error ? err.message : err)
    return null
  }
}

// ── TTL Refresh + Re-analysis for active incidents ──

export type { KVLike } from './utils'

export interface RefreshResult {
  refreshed: string[]   // svcIds where TTL was refreshed
  reanalyzed: string[]  // svcIds where re-analysis was triggered
  skipped: string[]     // svcIds skipped due to cooldown or cap
}

/**
 * For each active service and each of its active incidents:
 * - If analysis exists in KV: refresh TTL (every ~30min)
 * - If analysis missing: re-analyze (max `cap` per call, 30min cooldown on failure)
 *
 * KV key: ai:analysis:{svcId}:{incidentId} (per-incident)
 */
export async function refreshOrReanalyze(
  activeServices: ServiceStatus[],
  kv: KVLike,
  apiKey: string | undefined,
  analyzeFn: typeof analyzeIncident,
  cap = 2,
  now = Date.now(),
): Promise<RefreshResult> {
  const result: RefreshResult = { refreshed: [], reanalyzed: [], skipped: [] }
  let reAnalysisCount = 0
  // Track incidentId → KV key for dedup (same incident across multiple services)
  const analyzedIncidents = new Map<string, string>()

  for (const svc of activeServices) {
    const activeIncs = (svc.incidents ?? []).filter(i => i.status !== 'resolved')
    if (activeIncs.length === 0) continue

    for (const inc of activeIncs) {
      const key = analysisKey(svc.id, inc.id)
      const raw = await kv.get(key).catch(() => null)

      if (raw) {
        try {
          const parsed = JSON.parse(raw)
          // Time-based re-analysis: if 2h+ old, attempt update without deleting old analysis first
          const analysisAge = now - new Date(parsed.analyzedAt).getTime()
          if (analysisAge >= 7_200_000 && apiKey && reAnalysisCount < cap) {
            // Check if estimated recovery time has been exceeded (relative to incident start, not analysis time)
            // Fallback: if estimatedRecoveryHours not stored (pre-deployment data), parse from estimatedRecovery string
            const estHours = typeof parsed.estimatedRecoveryHours === 'number' && parsed.estimatedRecoveryHours > 0
              ? parsed.estimatedRecoveryHours
              : (parsed.estimatedRecovery ? parseRecoveryHours(parsed.estimatedRecovery) : null)
            const incidentAge = now - new Date(inc.startedAt).getTime()
            const recoveryExceeded = estHours != null && incidentAge > estHours * 3_600_000

            // Skip re-analysis if timeline hasn't changed since last analysis
            // UNLESS recovery time has been exceeded (stale prediction must be updated)
            const latestTimelineAt = inc.timeline?.at(-1)?.at ?? ''
            const hashTime = parsed.timelineHash ? new Date(parsed.timelineHash).getTime() : 0
            const latestTime = latestTimelineAt ? new Date(latestTimelineAt).getTime() : 0
            if (parsed.timelineHash && hashTime === latestTime && !recoveryExceeded) {
              // No new timeline updates — just refresh TTL, skip API call
              parsed._lastRefresh = new Date(now).toISOString()
              await kvPut(kv, key, JSON.stringify(parsed), { expirationTtl: 3600 })
              analyzedIncidents.set(inc.id, key)
              result.refreshed.push(svc.id)
              continue
            }
            // Skip if new timeline entries are all boilerplate (no technical detail)
            // UNLESS recovery time has been exceeded
            if (parsed.timelineHash && !recoveryExceeded) {
              const newEntries = (inc.timeline ?? []).filter(t => new Date(t.at).getTime() > hashTime)
              if (newEntries.length > 0 && newEntries.every(t => isBoilerplate(t.text))) {
                // Update timelineHash to avoid rechecking, but skip API call
                parsed.timelineHash = latestTimelineAt
                parsed._lastRefresh = new Date(now).toISOString()
                await kvPut(kv, key, JSON.stringify(parsed), { expirationTtl: 3600 })
                analyzedIncidents.set(inc.id, key)
                result.refreshed.push(svc.id)
                continue
              }
            }
            // Build previous prediction context for re-analysis prompt
            const prevPrediction = recoveryExceeded && estHours
              ? { estimatedRecoveryHours: estHours, elapsedHours: incidentAge / 3_600_000 }
              : undefined
            reAnalysisCount++
            try {
              const newAnalysis = await analyzeFn(
                apiKey, svc.name,
                { id: inc.id, title: inc.title, status: inc.status, startedAt: inc.startedAt, impact: inc.impact, timeline: inc.timeline },
                svc.incidents ?? [],
                prevPrediction,
              )
              // Track usage
              const today = new Date(now).toISOString().split('T')[0]
              const usageKey = `ai:usage:${today}`
              const usageRaw = await kv.get(usageKey).catch(() => null)
              const usage = usageRaw ? JSON.parse(usageRaw) : { calls: 0, success: 0, failed: 0 }
              usage.calls++
              if (newAnalysis) {
                usage.success++
                await kvPut(kv, key, JSON.stringify(newAnalysis), { expirationTtl: 3600 })
                analyzedIncidents.set(inc.id, key)
                result.reanalyzed.push(svc.id)
              } else {
                usage.failed++
                // Keep old analysis, just refresh TTL
                console.warn(`[ai] time-based re-analysis returned null for ${svc.id}:${inc.id}, keeping old`)
                parsed._lastRefresh = new Date(now).toISOString()
                await kvPut(kv, key, JSON.stringify(parsed), { expirationTtl: 3600 })
                result.refreshed.push(svc.id)
              }
              await kvPut(kv, usageKey, JSON.stringify(usage), { expirationTtl: 172800 })
            } catch (err) {
              console.warn(`[ai] time-based re-analysis failed for ${svc.id}:${inc.id}:`, err instanceof Error ? err.message : err)
              // Keep old analysis on failure
              parsed._lastRefresh = new Date(now).toISOString()
              await kvPut(kv, key, JSON.stringify(parsed), { expirationTtl: 3600 })
              result.refreshed.push(svc.id)
            }
            continue
          } else if (analysisAge >= 7_200_000) {
            // Cap exhausted or no API key — don't refresh TTL, let it expire for next cycle
            analyzedIncidents.set(inc.id, key)
            continue
          }
          // Valid analysis — register for sibling dedup
          analyzedIncidents.set(inc.id, key)
          // Refresh TTL if last refresh was 30+ min ago
          const lastRefresh = parsed._lastRefresh ?? parsed.analyzedAt
          const elapsed = now - new Date(lastRefresh).getTime()
          if (elapsed >= 1_800_000) {
            parsed._lastRefresh = new Date(now).toISOString()
            await kvPut(kv, key, JSON.stringify(parsed), { expirationTtl: 3600 })
            result.refreshed.push(svc.id)
          }
          continue
        } catch (err) {
          console.warn(`[ai] Failed to parse analysis for ${svc.id}:${inc.id}:`, err instanceof Error ? err.message : err)
        }
      }

      // No analysis — attempt re-analysis or copy from sibling with same incidentId
      // Dedup: check if another service already has analysis for the same incidentId
      const siblingKey = analyzedIncidents.get(inc.id)
      if (siblingKey) {
        const siblingRaw = await kv.get(siblingKey).catch(() => null)
        if (siblingRaw) {
          await kvPut(kv, key, siblingRaw, { expirationTtl: 3600 })
          analyzedIncidents.set(inc.id, key)
          result.reanalyzed.push(svc.id)
          continue
        }
      }

      if (!apiKey || reAnalysisCount >= cap) {
        result.skipped.push(svc.id)
        continue
      }

      // 30min cooldown after failure (per-incident)
      const skipKey = `ai:reanalysis-skip:${svc.id}:${inc.id}`
      const skipped = await kv.get(skipKey).catch(() => null)
      if (skipped) {
        result.skipped.push(svc.id)
        continue
      }

      reAnalysisCount++
      try {
        const analysis = await analyzeFn(
          apiKey,
          svc.name,
          { id: inc.id, title: inc.title, status: inc.status, startedAt: inc.startedAt, impact: inc.impact, timeline: inc.timeline },
          svc.incidents ?? [],
        )

        // Track in ai:usage daily counter
        const today = new Date(now).toISOString().split('T')[0]
        const usageKey = `ai:usage:${today}`
        const usageRaw = await kv.get(usageKey).catch(() => null)
        const usage = usageRaw ? JSON.parse(usageRaw) : { calls: 0, success: 0, failed: 0 }
        usage.calls++

        if (analysis) {
          usage.success++
          await kvPut(kv, key, JSON.stringify(analysis), { expirationTtl: 3600 })
          analyzedIncidents.set(inc.id, key)
          result.reanalyzed.push(svc.id)
        } else {
          usage.failed++
          console.warn(`[ai] re-analysis returned null for ${svc.id}:${inc.id}`)
          await kvPut(kv, skipKey, '1', { expirationTtl: 1800 })
          result.skipped.push(svc.id)
        }
        await kvPut(kv, usageKey, JSON.stringify(usage), { expirationTtl: 172800 })
      } catch (err) {
        console.warn(`[ai] re-analysis failed for ${svc.id}:${inc.id}:`, err instanceof Error ? err.message : err)
        await kvPut(kv, skipKey, '1', { expirationTtl: 1800 })
        result.skipped.push(svc.id)
      }
    }
  }

  return result
}
