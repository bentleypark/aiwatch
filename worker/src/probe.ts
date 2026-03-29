// Health Check Probing — direct RTT measurement to API endpoints
// Pure functions extracted for testability. Integration in index.ts.

export interface ProbeResult { status: number; rtt: number }
export interface ProbeSnapshot { t: string; data: Record<string, ProbeResult> }
export interface ProbeTarget { id: string; url: string }

export const PROBE_TARGETS: ProbeTarget[] = [
  { id: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models' },
  { id: 'mistral', url: 'https://api.mistral.ai/v1/models' },
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

/** Compute median RTT from probe snapshots for a given service */
export function computeMedianRtt(snapshots: ProbeSnapshot[], serviceId: string): number {
  const rtts = snapshots
    .map((s) => s.data[serviceId]?.rtt)
    .filter((r): r is number => typeof r === 'number' && r > 0)
  if (rtts.length === 0) return -1
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
  medianRtt: number,
): boolean {
  if (medianRtt <= 0) return true // no baseline → can't validate, assume real
  const WINDOW_MS = 600_000 // ±10 minutes
  const spikeThreshold = medianRtt * 3
  const startMs = new Date(incidentStart).getTime() - WINDOW_MS
  const endMs = incidentEnd
    ? new Date(incidentEnd).getTime() + WINDOW_MS
    : new Date(incidentStart).getTime() + WINDOW_MS

  const windowProbes = snapshots.filter((s) => {
    const t = new Date(s.t).getTime()
    return t >= startMs && t <= endMs && serviceId in s.data
  })

  if (windowProbes.length === 0) return true // no probe data in window → assume real

  return windowProbes.some((s) => {
    const probe = s.data[serviceId]
    return probe.rtt === -1 || probe.rtt > spikeThreshold
  })
}
