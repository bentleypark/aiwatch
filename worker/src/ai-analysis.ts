// AI Analysis — Claude Sonnet API call for incident analysis
// Triggered only when incidents are detected (not on every cron cycle)

import type { Incident, ServiceStatus } from './types'
import { sanitize } from './utils'

export interface AIAnalysisResult {
  summary: string
  estimatedRecovery: string
  affectedScope: string[]
  analyzedAt: string
  incidentId: string
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
- Keep the tone professional, objective, and data-driven.
- Do not include any text outside the JSON block.`

/**
 * Build user message with incident data (untrusted — separated from system instructions).
 */
export function buildAnalysisPrompt(
  serviceName: string,
  currentIncident: { title: string; status: string; startedAt: string; impact: string | null },
  similarIncidents: Incident[],
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

  return `<incident_data>
Service: ${safeName}
Current Incident: "${safeTitle}"
Status: ${safeStatus}
Started: ${sanitize(currentIncident.startedAt).slice(0, 30)}
Impact: ${safeImpact}

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
  currentIncident: { id: string; title: string; status: string; startedAt: string; impact: string | null },
  allIncidents: Incident[],
): Promise<AIAnalysisResult | null> {
  const similar = findSimilarIncidents(currentIncident.title, allIncidents)
  const prompt = buildAnalysisPrompt(serviceName, currentIncident, similar)

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
    return {
      summary: sanitize(parsed.summary ?? 'Analysis unavailable'),
      estimatedRecovery: recovery,
      affectedScope: (parsed.affectedScope ?? []).map(s => sanitize(s)),
      analyzedAt: new Date().toISOString(),
      incidentId: currentIncident.id,
    }
  } catch (err) {
    console.error('[ai-analysis] Failed:', err instanceof Error ? err.message : err)
    return null
  }
}

// ── TTL Refresh + Re-analysis for active incidents ──

export interface KVLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

export interface RefreshResult {
  refreshed: string[]   // svcIds where TTL was refreshed
  reanalyzed: string[]  // svcIds where re-analysis was triggered
  skipped: string[]     // svcIds skipped due to cooldown or cap
}

/**
 * For each active service:
 * - If analysis exists in KV: refresh TTL (every ~30min)
 * - If analysis missing: re-analyze (max `cap` per call, 30min cooldown on failure)
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
    const key = `ai:analysis:${svc.id}`
    const raw = await kv.get(key).catch(() => null)

    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        // Check if analysis is for a currently active incident
        const isStale = parsed.incidentId &&
          !(svc.incidents ?? []).some(i => i.id === parsed.incidentId && i.status !== 'resolved')

        if (isStale) {
          // Analysis is for a resolved/missing incident — delete and fall through to re-analysis
          await kv.put(key, '', { expirationTtl: 1 }).catch(() => {}) // expire immediately
        } else {
          // Time-based re-analysis: if analysis content is 2h+ old, re-analyze to capture evolving situations
          const analysisAge = now - new Date(parsed.analyzedAt).getTime()
          if (analysisAge >= 7_200_000 && apiKey && reAnalysisCount < cap) {
            // Delete old analysis and fall through to re-analysis (skip sibling dedup)
            await kv.put(key, '', { expirationTtl: 1 }).catch(() => {})
          } else {
            // Valid analysis — register for sibling dedup
            if (parsed.incidentId) analyzedIncidents.set(parsed.incidentId, key)
            // Refresh TTL if last refresh was 30+ min ago
            const lastRefresh = parsed._lastRefresh ?? parsed.analyzedAt
            const elapsed = now - new Date(lastRefresh).getTime()
            if (elapsed >= 1_800_000) {
              parsed._lastRefresh = new Date(now).toISOString()
              await kv.put(key, JSON.stringify(parsed), { expirationTtl: 3600 }).catch(() => {})
              result.refreshed.push(svc.id)
            }
            continue
          }
        }
      } catch { /* ignore corrupt data */ }
    }

    // No analysis — attempt re-analysis or copy from sibling with same incidentId
    const activeInc = (svc.incidents ?? []).find(i => i.status !== 'resolved')
    if (!activeInc) continue

    // Dedup: check if another service already has analysis for the same incidentId
    const siblingKey = analyzedIncidents.get(activeInc.id)
    if (siblingKey) {
      const siblingRaw = await kv.get(siblingKey).catch(() => null)
      if (siblingRaw) {
        await kv.put(key, siblingRaw, { expirationTtl: 3600 }).catch(() => {})
        analyzedIncidents.set(activeInc.id, key)
        result.reanalyzed.push(svc.id)
        continue
      }
    }

    if (!apiKey || reAnalysisCount >= cap) {
      result.skipped.push(svc.id)
      continue
    }

    // 30min cooldown after failure
    const skipKey = `ai:reanalysis-skip:${svc.id}`
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
        { id: activeInc.id, title: activeInc.title, status: activeInc.status, startedAt: activeInc.startedAt, impact: activeInc.impact },
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
        await kv.put(key, JSON.stringify(analysis), { expirationTtl: 3600 }).catch(() => {})
        if (activeInc.id) analyzedIncidents.set(activeInc.id, key)
        result.reanalyzed.push(svc.id)
      } else {
        usage.failed++
        console.warn(`[ai] re-analysis returned null for ${svc.id}`)
        await kv.put(skipKey, '1', { expirationTtl: 1800 }).catch(() => {})
        result.skipped.push(svc.id)
      }
      await kv.put(usageKey, JSON.stringify(usage), { expirationTtl: 172800 }).catch(() => {})
    } catch (err) {
      console.warn(`[ai] re-analysis failed for ${svc.id}:`, err instanceof Error ? err.message : err)
      await kv.put(skipKey, '1', { expirationTtl: 1800 }).catch(() => {})
      result.skipped.push(svc.id)
    }
  }

  return result
}
