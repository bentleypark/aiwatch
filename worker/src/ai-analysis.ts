// AI Analysis — Claude Sonnet API call for incident analysis
// Triggered only when incidents are detected (not on every cron cycle)

import type { Incident } from './types'
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
  "estimatedRecovery": "A range based on the average duration of similar past incidents. If no similar patterns exist, return 'No historical data for estimation'.",
  "affectedScope": ["1-3 specific features or related sub-services likely impacted"]
}

Rules:
- If the incident title contains specific environment keywords (e.g., 'Chrome', 'Cowork', 'API'), prioritize them in the summary.
- Recovery estimate must be a realistic range (e.g., '30-60 min') based on the Historical Data provided.
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

    return {
      summary: sanitize(parsed.summary ?? 'Analysis unavailable'),
      estimatedRecovery: sanitize(parsed.estimatedRecovery ?? 'Unknown'),
      affectedScope: (parsed.affectedScope ?? []).map(s => sanitize(s)),
      analyzedAt: new Date().toISOString(),
      incidentId: currentIncident.id,
    }
  } catch (err) {
    console.error('[ai-analysis] Failed:', err instanceof Error ? err.message : err)
    return null
  }
}
