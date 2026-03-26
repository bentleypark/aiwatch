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
