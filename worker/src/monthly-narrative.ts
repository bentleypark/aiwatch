// Monthly retrospective narrative — AI-generated draft for the report's
// Notable Incidents + Observations sections (aiwatch-reports#4 Phase 3, #426).
//
// Option C architecture: the narrative is generated at archive-build time and
// baked into the archive JSON, alongside the existing `security` and
// `degradation` summaries. The aiwatch-reports `generate-report.js` then
// renders it as an operator-reviewed auto-draft — it never calls an AI itself.
//
// Why not read `ai:analysis:*`: those per-incident keys have 1h/2h TTL and the
// archive builds on the 1st of the *next* month, so every live analysis from
// the month has long expired. The archive's `incidentList` (#375 — title,
// duration, dates, finalStatus) is the durable input instead.
//
// One AI call per month. Failure-isolated: any error returns null and the
// archive still builds (narrative: null → report falls back to the placeholder).

import { GEMMA_MODEL, AI_GATEWAY_ANTHROPIC_URL } from './ai-analysis'
import type { MonthlyArchive, MonthlyIncidentEntry } from './monthly-archive'

// ── Public types ─────────────────────────────────────────────────────

/** One AI-drafted Notable Incident entry. Mirrors the monthly-report.md
 *  "Notable Incidents" item shape (title / affected / duration / prose). */
export interface NotableIncidentDraft {
  service: string        // display name, e.g. "Gemini API"
  title: string          // incident title (verbatim from the status page)
  affected: string       // affected surface — service name, region-qualified when the title implies it
  durationLabel: string  // human duration, e.g. "10 days" / "2h 14m" / "ongoing"
  narrative: string      // 1-2 sentence retrospective prose: scope + remediation
}

export interface MonthlyNarrativeDraft {
  notableIncidents: NotableIncidentDraft[]
  observations: string[]            // prescriptive per-service bullets
  model: 'gemma' | 'sonnet'         // which model produced the draft
  generatedAt: string               // ISO timestamp
}

export interface NarrativeAiOptions {
  ai?: unknown                       // Workers AI binding (env.AI) — typed `unknown` to avoid the Ai import here
  apiKey?: string                    // ANTHROPIC_API_KEY for the Sonnet fallback
  serviceNames?: Record<string, string>  // service id → display name; falls back to id when absent
}

// Cap on incident candidates sent to the model. Archives can carry thousands of
// incidents (200/service × 34); the prompt only needs the most significant ones.
// 14 leaves the model room to pick the report's 5-6 notable entries with margin.
const MAX_INCIDENT_CANDIDATES = 14
// Cap on per-service summary rows in the Observations input — every service with
// any incident plus a few clean high-scorers is plenty of signal.
const MAX_OBSERVATION_SERVICES = 20
const GEMMA_MAX_TOKENS = 1400
const SONNET_MAX_TOKENS = 1400
const AI_TIMEOUT_MS = 20_000

// ── Duration formatting ──────────────────────────────────────────────

/** Format a minute count as a human label. >24h collapses to whole days
 *  (monthly retrospective scale — "10 days" reads better than "247h 30m"). */
export function formatDurationLabel(durationMin: number, finalStatus: string): string {
  if (finalStatus !== 'resolved' || durationMin <= 0) return 'ongoing'
  const days = Math.floor(durationMin / 1440)
  if (days >= 1) {
    const remHours = Math.round((durationMin - days * 1440) / 60)
    return remHours > 0 ? `${days}d ${remHours}h` : `${days} day${days > 1 ? 's' : ''}`
  }
  const h = Math.floor(durationMin / 60)
  const m = Math.round(durationMin % 60)
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

// ── Candidate selection ──────────────────────────────────────────────

interface FlatIncident extends MonthlyIncidentEntry {
  serviceId: string
  serviceName: string
}

/** Flatten every service's incidentList into one array, tagged with the
 *  service, ranked by significance (longest duration first; unresolved
 *  incidents float up since an open incident at month-end is itself notable). */
export function selectIncidentCandidates(
  archive: MonthlyArchive,
  serviceNames: Record<string, string>,
): FlatIncident[] {
  const flat: FlatIncident[] = []
  for (const [id, svc] of Object.entries(archive.services)) {
    for (const inc of svc.incidentList ?? []) {
      flat.push({ ...inc, serviceId: id, serviceName: serviceNames[id] ?? id })
    }
  }
  flat.sort((a, b) => {
    // Unresolved (still open at archive time) rank above resolved.
    const aOpen = a.finalStatus !== 'resolved' ? 1 : 0
    const bOpen = b.finalStatus !== 'resolved' ? 1 : 0
    if (aOpen !== bOpen) return bOpen - aOpen
    // Then longest duration.
    return b.durationMin - a.durationMin
  })
  return flat.slice(0, MAX_INCIDENT_CANDIDATES)
}

// ── Prompt construction ──────────────────────────────────────────────

export const MONTHLY_NARRATIVE_SYSTEM_PROMPT = `You are a reliability analyst writing the monthly AI-service reliability report for AIWatch.
You are given a month of incident + score data and must draft two sections. Respond in JSON format ONLY:
{
  "notableIncidents": [
    {
      "service": "service display name exactly as given",
      "title": "incident title exactly as given",
      "affected": "the affected surface — service name, add a region only if the title names one",
      "durationLabel": "duration label exactly as given",
      "narrative": "1-2 sentences: what was impacted and (if inferable) how it was remediated. Retrospective past-tense voice."
    }
  ],
  "observations": [
    "Prescriptive one-sentence operational guidance per noteworthy service. Tell the reader what to DO, not recap."
  ]
}

Rules:
- notableIncidents: pick the 5-6 MOST significant incidents from the candidates. Longest / unresolved / highest-impact first. Do not invent incidents — use only the candidates given.
- Copy service, title, durationLabel VERBATIM from the candidate data. Only narrative and affected are your prose.
- narrative: retrospective and factual. If the data doesn't say how it was fixed, describe scope only — never fabricate a remediation.
- observations: 3-5 bullets. Prescriptive ("Prefer X for latency-sensitive workloads", "Treat Y as fallback-only this month"). Base them on the score / incident-count / recovery data. Do not restate zero-incident services as a list.
- Professional, objective, data-driven. No text outside the JSON block.`

/** Build the user message: incident candidates + per-service summary table. */
export function buildMonthlyNarrativePrompt(
  archive: MonthlyArchive,
  serviceNames: Record<string, string>,
): string {
  const candidates = selectIncidentCandidates(archive, serviceNames)

  const incidentLines = candidates.map((c, i) => {
    const dur = formatDurationLabel(c.durationMin, c.finalStatus)
    return `${i + 1}. service="${c.serviceName}" | title="${c.title}" | duration="${dur}" | status=${c.finalStatus}`
  })

  // Per-service summary for Observations — services with incidents first, then
  // a few clean high-scorers, capped. Sorted by incident count desc then score desc.
  const summaryRows = Object.entries(archive.services)
    .map(([id, svc]) => ({
      name: serviceNames[id] ?? id,
      score: svc.score,
      grade: svc.grade,
      incidents: svc.incidents,
      avgResolutionMin: svc.avgResolutionMin,
    }))
    .sort((a, b) => {
      if (b.incidents !== a.incidents) return b.incidents - a.incidents
      return (b.score ?? 0) - (a.score ?? 0)
    })
    .slice(0, MAX_OBSERVATION_SERVICES)
    .map(s => {
      const rec = s.avgResolutionMin != null ? `${s.avgResolutionMin}m avg recovery` : 'no resolved incidents'
      return `- ${s.name}: score ${s.score ?? 'N/A'} (${s.grade ?? 'N/A'}), ${s.incidents} incidents, ${rec}`
    })

  return `Month: ${archive.period}
Days of data collected: ${archive.daysCollected}

INCIDENT CANDIDATES (most significant first — pick 5-6 for Notable Incidents):
${incidentLines.length > 0 ? incidentLines.join('\n') : '(no incidents recorded this month)'}

PER-SERVICE SUMMARY (for Observations):
${summaryRows.join('\n')}`
}

// ── Response parsing ─────────────────────────────────────────────────

/** Parse + validate the model's JSON response. Returns null on any structural
 *  problem so the caller degrades to "no narrative" rather than persisting junk. */
export function parseMonthlyNarrative(
  text: string,
  model: 'gemma' | 'sonnet',
): MonthlyNarrativeDraft | null {
  // Models occasionally wrap JSON in prose or fences — extract the first {...} block.
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) {
    console.warn('[monthly-narrative] no JSON object found in model response')
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch (err) {
    console.warn('[monthly-narrative] JSON parse failed:', err instanceof Error ? err.message : err)
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as { notableIncidents?: unknown; observations?: unknown }

  const rawIncidents = Array.isArray(obj.notableIncidents) ? obj.notableIncidents : []
  const notableIncidents: NotableIncidentDraft[] = []
  for (const r of rawIncidents) {
    if (!r || typeof r !== 'object') continue
    const e = r as Record<string, unknown>
    const service = typeof e.service === 'string' ? e.service.trim() : ''
    const title = typeof e.title === 'string' ? e.title.trim() : ''
    const narrative = typeof e.narrative === 'string' ? e.narrative.trim() : ''
    // service + title + narrative are the load-bearing fields — skip a row missing any.
    if (!service || !title || !narrative) continue
    notableIncidents.push({
      service,
      title,
      affected: typeof e.affected === 'string' && e.affected.trim() ? e.affected.trim() : service,
      durationLabel: typeof e.durationLabel === 'string' && e.durationLabel.trim() ? e.durationLabel.trim() : 'N/A',
      narrative,
    })
  }

  const observations = (Array.isArray(obj.observations) ? obj.observations : [])
    .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
    .map(o => o.trim())

  // A draft with neither section is worthless — treat as failure.
  if (notableIncidents.length === 0 && observations.length === 0) {
    console.warn('[monthly-narrative] parsed response had no usable incidents or observations')
    return null
  }

  return { notableIncidents, observations, model, generatedAt: new Date().toISOString() }
}

// ── Model calls ──────────────────────────────────────────────────────
//
// Self-contained Gemma + Sonnet calls (shared model id + gateway URL imported
// from ai-analysis.ts). The incident-analysis hybrid in ai-analysis.ts is
// prompt-coupled to a different response schema, so it can't be reused directly;
// the call mechanics are intentionally kept parallel to it for consistency.

async function callGemma(ai: unknown, systemPrompt: string, userPrompt: string): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- model id may not be in the Ai type union
  const res: any = await (ai as any).run(GEMMA_MODEL, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: GEMMA_MAX_TOKENS,
    chat_template_kwargs: { enable_thinking: false },
  })
  const text = typeof res === 'string'
    ? res
    : res?.response
      ?? res?.choices?.[0]?.message?.content
      ?? res?.choices?.[0]?.message?.reasoning
  if (!text) {
    console.warn('[monthly-narrative] Gemma: unexpected response shape', JSON.stringify(res).slice(0, 300))
    return null
  }
  return text
}

async function callSonnet(apiKey: string, systemPrompt: string, userPrompt: string): Promise<string | null> {
  const res = await fetch(AI_GATEWAY_ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: SONNET_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  })
  if (!res.ok) {
    console.error(`[monthly-narrative] Claude API returned ${res.status}: ${await res.text().catch(() => '')}`)
    return null
  }
  const data = await res.json() as { content: Array<{ type: string; text?: string }> }
  return data.content?.find(c => c.type === 'text')?.text ?? null
}

// ── Public entry point ───────────────────────────────────────────────

/**
 * Generate the monthly retrospective narrative. Hybrid: Gemma (Workers AI)
 * primary, Sonnet (AI Gateway) fallback. Returns null on total failure — the
 * caller treats null as "archive has no narrative draft" and the report falls
 * back to the hand-written placeholder. Never throws.
 */
export async function generateMonthlyNarrative(
  archive: MonthlyArchive,
  opts: NarrativeAiOptions,
): Promise<MonthlyNarrativeDraft | null> {
  const serviceNames = opts.serviceNames ?? {}
  const userPrompt = buildMonthlyNarrativePrompt(archive, serviceNames)

  // Primary: Gemma via Workers AI.
  if (opts.ai) {
    try {
      const text = await callGemma(opts.ai, MONTHLY_NARRATIVE_SYSTEM_PROMPT, userPrompt)
      if (text) {
        const draft = parseMonthlyNarrative(text, 'gemma')
        if (draft) {
          console.log(`[monthly-narrative] Gemma success for ${archive.period}: ${draft.notableIncidents.length} incidents, ${draft.observations.length} observations`)
          return draft
        }
      }
      console.warn(`[monthly-narrative] Gemma produced no usable draft for ${archive.period}, falling back to Sonnet`)
    } catch (err) {
      console.warn(`[monthly-narrative] Gemma failed for ${archive.period}: ${err instanceof Error ? err.message : err}, falling back to Sonnet`)
    }
  }

  // Fallback: Claude Sonnet via AI Gateway.
  if (!opts.apiKey) {
    console.warn(`[monthly-narrative] no ANTHROPIC_API_KEY — skipping Sonnet fallback for ${archive.period}`)
    return null
  }
  try {
    const text = await callSonnet(opts.apiKey, MONTHLY_NARRATIVE_SYSTEM_PROMPT, userPrompt)
    if (!text) return null
    return parseMonthlyNarrative(text, 'sonnet')
  } catch (err) {
    console.error(`[monthly-narrative] Sonnet fallback failed for ${archive.period}:`, err instanceof Error ? err.message : err)
    return null
  }
}
