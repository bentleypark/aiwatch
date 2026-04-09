// Detection Lead — helpers for tracking earliest detection timestamps
// Extracted from index.ts for testability (#189)

export interface DetectionEntry {
  t: string       // ISO timestamp of earliest detection
  incId: string | null  // incident ID associated with this detection (null for probe-only)
}

/** Parse a detected: KV value (JSON or legacy plain ISO string) */
export function parseDetectionEntry(raw: string | null): DetectionEntry | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.t === 'string') {
      return { t: parsed.t, incId: parsed.incId ?? null }
    }
    // Unexpected JSON shape — treat as corrupt
    return null
  } catch {
    // Legacy plain ISO string format — migrate
    return { t: raw, incId: null }
  }
}

/** Determine if detection should be reset due to incident ID change.
 *  Returns new entry to write, or null if no change needed. */
export function resolveDetectionUpdate(
  existing: DetectionEntry | null,
  activeIncId: string | null,
  now: string,
): { entry: DetectionEntry; reason: 'new' | 'incident-changed' | 'backfill' } | null {
  if (!existing) {
    // No existing detection — create new
    return { entry: { t: now, incId: activeIncId }, reason: 'new' }
  }

  // Incident ID changed (both non-null, different) — reset detection
  if (existing.incId && activeIncId && existing.incId !== activeIncId) {
    return { entry: { t: now, incId: activeIncId }, reason: 'incident-changed' }
  }

  // Backfill: probe-only detection (incId null) → real incident arrived
  if (!existing.incId && activeIncId) {
    return { entry: { t: existing.t, incId: activeIncId }, reason: 'backfill' }
  }

  // No change needed
  return null
}

/** Serialize detection entry for KV storage */
export function serializeDetectionEntry(entry: DetectionEntry): string {
  return JSON.stringify(entry)
}

/** Extract timestamp from detection entry for Detection Lead calculation */
export function getDetectionTimestamp(raw: string | null): string | null {
  const entry = parseDetectionEntry(raw)
  return entry?.t ?? null
}

/** Compare probe spike time against existing detection, return true if spike is earlier */
export function isProbeEarlier(existingRaw: string | null, spikeTime: string): boolean {
  if (!existingRaw) return true
  const existing = parseDetectionEntry(existingRaw)
  if (!existing) return true
  const existingMs = new Date(existing.t).getTime()
  const spikeMs = new Date(spikeTime).getTime()
  if (isNaN(existingMs)) return true
  if (isNaN(spikeMs)) return false
  return spikeMs < existingMs
}
