// Health Check Probing — direct RTT measurement to API endpoints
// Pure functions extracted for testability. Integration in index.ts.

export interface ProbeResult { status: number; rtt: number }
export interface ProbeSnapshot { t: string; data: Record<string, ProbeResult> }
export interface ProbeTarget { id: string; url: string }

export const PROBE_TARGETS: ProbeTarget[] = [
  // API services — auth not required for RTT measurement (401/403/405 = server alive)
  { id: 'claude', url: 'https://api.anthropic.com/v1/messages' },
  { id: 'openai', url: 'https://api.openai.com/v1/models' },
  { id: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models' },
  { id: 'mistral', url: 'https://api.mistral.ai/v1/models' },
  { id: 'cohere', url: 'https://api.cohere.ai/v1/models' },
  { id: 'groq', url: 'https://api.groq.com/openai/v1/models' },
  { id: 'together', url: 'https://api.together.xyz/v1/models' },
  { id: 'perplexity', url: 'https://api.perplexity.ai/chat/completions' },
  { id: 'huggingface', url: 'https://huggingface.co/api/models?limit=1' },
  { id: 'replicate', url: 'https://api.replicate.com/v1/models' },
  { id: 'elevenlabs', url: 'https://api.elevenlabs.io/v1/voices' },
  { id: 'xai', url: 'https://api.x.ai/v1/models' },
  { id: 'deepseek', url: 'https://api.deepseek.com/v1/models' },
  { id: 'openrouter', url: 'https://openrouter.ai/api/v1/models' },
  { id: 'stability', url: 'https://api.stability.ai/v1/engines/list' },
  { id: 'assemblyai', url: 'https://api.assemblyai.com/v2/transcript' },
  { id: 'deepgram', url: 'https://api.deepgram.com/v1/models' },
  // Not feasible: bedrock (no public endpoint), azureopenai (tenant-specific), pinecone (index-specific)
]

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

/**
 * Check if a micro-incident is corroborated by probe data (RTT spike).
 * Returns true if the incident appears to be a real outage based on probe evidence.
 *
 * Logic: find probe snapshots within ±10 minutes of the incident window.
 * If any probe shows RTT > 3× median or a failed probe (rtt=-1), it's corroborated.
 * If no probes exist in the window, assume real (conservative — don't filter without evidence).
 */
export function isCorroboratedByProbe(
  snapshots: ProbeSnapshot[],
  serviceId: string,
  incidentStart: string,
  incidentEnd: string | null,
  medianRtt: number | null,
): boolean {
  if (medianRtt === null || medianRtt <= 0) {
    console.warn(`[isCorroboratedByProbe] no baseline RTT for ${serviceId}, assuming real`)
    return true
  }
  const WINDOW_MS = 600_000 // ±10 minutes
  const spikeThreshold = medianRtt * 3
  const startMs = new Date(incidentStart).getTime()
  if (Number.isNaN(startMs)) {
    console.error(`[isCorroboratedByProbe] invalid incidentStart: "${incidentStart}"`)
    return true
  }
  const endMs = incidentEnd ? new Date(incidentEnd).getTime() : NaN
  if (incidentEnd && Number.isNaN(endMs)) {
    console.error(`[isCorroboratedByProbe] invalid incidentEnd: "${incidentEnd}"`)
    return true
  }
  const windowStart = startMs - WINDOW_MS
  const windowEnd = (incidentEnd && !Number.isNaN(endMs) ? endMs : startMs) + WINDOW_MS

  const windowProbes = snapshots.filter((s) => {
    const t = new Date(s.t).getTime()
    return !Number.isNaN(t) && t >= windowStart && t <= windowEnd && serviceId in s.data
  })

  if (windowProbes.length === 0) {
    console.warn(`[isCorroboratedByProbe] no probes in window for ${serviceId} (${incidentStart}), assuming real`)
    return true
  }

  return windowProbes.some((s) => {
    const probe = s.data[serviceId]
    return probe.rtt === -1 || probe.rtt > spikeThreshold
  })
}
