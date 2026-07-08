// Health Check Probing — direct RTT measurement to API endpoints
// Pure functions extracted for testability. Integration in index.ts.

export interface ProbeResult { status: number; rtt: number }
export interface ProbeSnapshot { t: string; data: Record<string, ProbeResult> }
export interface ProbeTarget { id: string; url: string }

export const PROBE_TARGETS: ProbeTarget[] = [
  // API services — auth not required for RTT measurement (401/403/405 = server alive)
  { id: 'claude', url: 'https://api.anthropic.com/v1/models' },
  { id: 'openai', url: 'https://api.openai.com/v1/models' },
  { id: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models' },
  { id: 'mistral', url: 'https://api.mistral.ai/v1/models' },
  { id: 'cohere', url: 'https://api.cohere.ai/v1/models' },
  { id: 'groq', url: 'https://api.groq.com/openai/v1/models' },
  { id: 'together', url: 'https://api.together.xyz/v1/models' },
  { id: 'fireworks', url: 'https://api.fireworks.ai/inference/v1/models' },
  { id: 'cerebras', url: 'https://api.cerebras.ai/v1/models' }, // #391 — GET returns 403 (auth not required for RTT)
  { id: 'perplexity', url: 'https://api.perplexity.ai/chat/completions' },
  { id: 'huggingface', url: 'https://huggingface.co/api/models?limit=1' },
  { id: 'replicate', url: 'https://api.replicate.com/v1/models' },
  { id: 'fal', url: 'https://fal.run/fal-ai/flux/dev' },                            // #758 — real inference gateway model path, 401 (auth not required for RTT)
  { id: 'elevenlabs', url: 'https://api.elevenlabs.io/v1/voices' },
  { id: 'xai', url: 'https://api.x.ai/v1/models' },
  { id: 'deepseek', url: 'https://api.deepseek.com/v1/models' },
  { id: 'openrouter', url: 'https://openrouter.ai/api/v1/models' },
  { id: 'stability', url: 'https://api.stability.ai/v1/engines/list' },
  { id: 'bfl', url: 'https://api.bfl.ai/v1/get_result' },                            // #756 — real API handler, 422 (missing id), no auth for RTT
  { id: 'assemblyai', url: 'https://api.assemblyai.com/v2/transcript' },
  { id: 'deepgram', url: 'https://api.deepgram.com/v1/models' },
  { id: 'voyageai', url: 'https://api.voyageai.com/v1/embeddings' },
  { id: 'twelvelabs', url: 'https://api.twelvelabs.io/v1.3/indexes' },             // control-plane, 401
  // #678 — added after a live cross-check showed these have a stable, representative API path that
  // returns a fast status without auth (the probe measures RTT and treats ANY HTTP response as
  // "server alive", so the old "requires auth" exclusions were invalid):
  { id: 'pinecone', url: 'https://api.pinecone.io/indexes' },                       // control-plane, 401
  { id: 'langsmith', url: 'https://api.smith.langchain.com/info' },                 // public /info, 200
  { id: 'runway', url: 'https://api.runwayml.com/v1/tasks' },                       // 401
  { id: 'luma', url: 'https://api.lumalabs.ai/dream-machine/v1/generations' },      // 403
  // #601 — LLM observability siblings; both expose a public, no-auth health endpoint (verified 2026-06-23)
  { id: 'helicone', url: 'https://api.helicone.ai/healthcheck' },                   // public 200 {"status":"healthy :)"}
  { id: 'langfuse', url: 'https://cloud.langfuse.com/api/public/health' },          // public 200 {"status":"OK"}
  // #857 — turbopuffer has no official uptime (no statusComponentId → parseUptimeData never runs; region-only
  // page), so the probe is its sole substantial measured signal → confidence `medium` once ≥7d of samples accrue
  // (`low`/null Score during the initial ramp). Public no-auth health endpoint, verified 2026-07-01.
  { id: 'turbopuffer', url: 'https://api.turbopuffer.com' },                        // public 200 {"status":"🐡"}
  // #883 — cursor (coding agent) runs on its OWN API infra, independent of any other probed target.
  // Live cross-check 2026-07-03: api2.cursor.sh routes real paths (200, body "Welcome to Cursor. From
  // <build>…") but 404s garbage → representative gateway, NOT a CDN catch-all (unlike windsurf.com).
  { id: 'cursor', url: 'https://api2.cursor.sh/' },                                 // 200, real API gateway
  // #921 — Character.AI's official Statuspage was deactivated (401 "page inactive") since ~2026-06-18
  // (#689/#800, statusSourceDeactivated) with no first-party replacement, leaving the card a dead
  // surface. neo.character.ai (its backend API host) exposes a plain-fetch, non-bot-walled health
  // endpoint — verified 2026-07-06: 200 {"redis":"UP"}, x-envoy-upstream-service-time header (real
  // backend, not a CDN edge), RTT ~0.2s, no browser UA needed (the main character.ai root is CF-403
  // bot-walled). This is a `probeConfirmed` case (services.ts): a healthy probe keeps the badge
  // operational (probe-backed) despite the dead source. CAVEAT: it's a BACKEND health proxy — the
  // user-facing app could be down while /health is UP; it does NOT restore incidents/uptime.
  { id: 'characterai', url: 'https://neo.character.ai/health' },                    // 200 {"redis":"UP"}, app-category detail-card only (not Latency-ranked)
  // Not probed (#678): bedrock (region-specific runtime endpoint, estimate-only — incident-derived
  // reliability is enough), azureopenai (tenant-specific {resource}.openai.azure.com — no generic
  // endpoint), modal (api.modal.com returns a catch-all 200 on every path — not a representative
  // API-path RTT)
]

// #883 — Parent-probe inheritance for the Score's Responsiveness component. Some ranked services run
// on an endpoint another service ALREADY probes: Claude Code uses api.anthropic.com (probed as
// `claude`), Codex uses api.openai.com (probed as `openai`). Adding a separate PROBE_TARGETS entry
// would fire a redundant network probe to the identical host, so instead these inherit the parent's
// ProbeSummary at scoring time (score-only — they get NO Latency-page probe entry of their own). Keep
// this to true endpoint-sharing pairs; a service with its own infra (e.g. cursor) is probed directly.
export const PROBE_INHERIT: Record<string, string> = {
  claudecode: 'claude',
  codex: 'openai',
}

/** Resolve the probe id whose RTT represents a service — itself, unless it inherits a parent's
 *  probe (#883). Used by the score's probe classification so an inheriting service is measured on
 *  the parent's endpoint instead of falling through to the probe-less rescale. */
export function resolveProbeId(serviceId: string): string {
  return PROBE_INHERIT[serviceId] ?? serviceId
}

/** Compute 5-minute aligned slot string from a Date */
export function computeProbeSlot(date: Date): string {
  const mins = date.getUTCMinutes()
  const slot5 = mins - (mins % 5)
  return `${date.toISOString().slice(0, 14)}${String(slot5).padStart(2, '0')}`
}

/** Convert slot to ISO timestamp */
export function slotToTimestamp(slot: string): string {
  return `${slot}:00Z`
}

/** Trim snapshots to max count, keeping most recent */
export function trimSnapshots(snapshots: ProbeSnapshot[], max: number): ProbeSnapshot[] {
  return snapshots.slice(-max)
}

/** Check if a slot already exists in snapshots */
export function hasSlot(snapshots: ProbeSnapshot[], slotTs: string): boolean {
  return snapshots.some((s) => s.t === slotTs)
}

/** Build ProbeResult for a timeout/network failure */
export function failedProbe(): ProbeResult {
  return { status: 0, rtt: -1 }
}

export interface ProbeSpike {
  serviceId: string
  consecutiveCount: number
  avgRtt: number
  medianRtt: number
  threshold: number
  since: string // ISO timestamp of first spike in the streak
}

/**
 * Detect services with consecutive RTT spikes in the most recent probes.
 * Returns a ProbeSpike for each service that has >= minConsecutive spikes.
 * A spike is defined as RTT > 3× median or a failed probe (rtt=-1).
 */
export function detectConsecutiveSpikes(
  snapshots: ProbeSnapshot[],
  serviceIds: string[],
  minConsecutive: number = 3,
): ProbeSpike[] {
  const results: ProbeSpike[] = []
  for (const serviceId of serviceIds) {
    const median = computeMedianRtt(snapshots, serviceId)
    if (median === null) continue
    const threshold = median * 3

    // Walk backwards from the most recent snapshot
    let count = 0
    let rttSum = 0
    let rttCount = 0
    let since = ''
    for (let i = snapshots.length - 1; i >= 0; i--) {
      const probe = snapshots[i].data[serviceId]
      if (!probe) break // no data for this service → stop
      const isSpike = probe.rtt === -1 || probe.rtt > threshold
      if (!isSpike) break // streak broken
      count++
      if (probe.rtt > 0) { rttSum += probe.rtt; rttCount++ }
      since = snapshots[i].t
    }

    if (count >= minConsecutive) {
      results.push({
        serviceId,
        consecutiveCount: count,
        avgRtt: rttCount > 0 ? Math.round(rttSum / rttCount) : 0,
        medianRtt: median,
        threshold: Math.round(threshold),
        since,
      })
    }
  }
  return results
}

/** Compute median RTT from probe snapshots for a given service.
 *  Uses floor-index median (no averaging for even-length arrays).
 *  Returns null when no valid probe data exists. */
export function computeMedianRtt(snapshots: ProbeSnapshot[], serviceId: string): number | null {
  const rtts = snapshots
    .map((s) => s.data[serviceId]?.rtt)
    .filter((r): r is number => typeof r === 'number' && r > 0)
  if (rtts.length === 0) return null
  const sorted = [...rtts].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

// Mistral-only probe corroboration filter (#91 Phase 2 → #372 retune) was removed in #373.
// The asymmetry it created — Mistral incidents filtered by RTT cross-validation, all other
// services shown raw — was epistemically weak (probe `/v1/models` couldn't measure the
// `/v1/chat/completions` endpoint the incidents were actually on) and not generalizable to
// other auto-monitoring sources (BetterStack/Together AI, Instatus/Perplexity). Replaced by
// same-title incident grouping in `src/utils/incidentGrouping.js`, which consolidates noise
// uniformly across all services without overriding what status pages report.
//
// `computeMedianRtt` is still exported below — it's used by the probe-spike degradation logic
// in alerts.ts, independently of the removed corroboration path.

/**
 * Check if a service's recent probe data indicates it is healthy.
 * Used to cross-validate status page fetch failures — if the API responds normally
 * but the status page is down, the service is likely operational (false positive).
 *
 * Returns true if recent probes show normal RTT (service is healthy).
 * Returns false if probes show spikes/failures or no recent data exists.
 * Conservative: returns false (don't override) when data is insufficient.
 */
export function isProbeHealthy(
  snapshots: ProbeSnapshot[],
  serviceId: string,
  maxAgeMs = 900_000, // 15 minutes — probes run every 5min, so 3 cycles
): boolean {
  if (snapshots.length === 0) return false

  const now = Date.now()
  // Get recent snapshots with data for this service
  const recent = snapshots.filter(s => {
    const age = now - new Date(s.t).getTime()
    return age >= 0 && age < maxAgeMs && serviceId in s.data
  })

  // Need at least 2 recent probes for confidence
  if (recent.length < 2) return false

  const median = computeMedianRtt(snapshots, serviceId)
  if (median === null || median <= 0) return false

  const threshold = median * 3
  // Majority rule: ≥ ⌈2/3⌉ of recent probes must be healthy.
  // Previously required ALL probes healthy, which caused false-positive degraded alerts
  // when a single transient RTT blip coincided with a structural status-page fetch failure
  // (e.g. DeepSeek — status.deepseek.com blocks Workers IPs, so degradedFromFetch fires
  // every cron cycle; one probe blip prevented cross-validation from overriding to operational).
  // A single outlier probe in 3 cycles is network noise; a genuine degradation spikes
  // multiple consecutive probes, which majority correctly identifies as unhealthy.
  const healthyCount = recent.filter(s => {
    const probe = s.data[serviceId]
    return probe.rtt > 0 && probe.rtt <= threshold
  }).length
  return healthyCount >= Math.ceil(recent.length * 2 / 3)
}
