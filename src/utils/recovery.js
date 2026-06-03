// #557 — recovery-time stats for the ServiceDetails "Recovery" card.
//
// The card used to show a plain MEAN of every resolved incident's duration over 7 days. On status
// pages that fragment one outage into many short component-level incidents (e.g. Mistral's Instatus
// feed), that mean is dragged to a meaningless middle: Mistral's 29h34m Audio outage averaged with
// six 4–7min blips read as "4h 23m" — neither the typical recovery nor the worst.
//
// Fix: report the MEDIAN (robust to the many short blips → the typical recovery a user actually
// experiences) and surface the MAX (the worst outage, so a long one is never hidden). The median uses
// the same lower-middle convention as the AIWatch Score's recovery component (worker/src/score.ts),
// so a single long outage no longer drags the headline the way the mean did. Note the two are NOT
// identical and can differ on the same service: this card is a 7-day window, while score.ts uses a
// 30-day window AND falls back to the mean for <3 incidents — they share the convention, not the result.

/** Parse a duration string like "29h 34m" / "43m" / "1h 20m" → minutes (0 if unparseable). */
export function parseDurationToMin(s) {
  if (!s) return 0
  const m = s.match(/(?:(\d+)h\s*)?(\d+)m/)
  return m ? (parseInt(m[1] || '0', 10) * 60 + parseInt(m[2], 10)) : 0
}

/** Format minutes → "29h 34m" / "43m". */
export function formatRecoveryMin(min) {
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`
}

/**
 * Median + worst recovery time from a service's resolved incidents within the window.
 * @param {Array<{status?: string, duration?: string, startedAt?: string}>} incidents
 * @param {number} now epoch ms (injectable for tests)
 * @param {number} windowDays default 7
 * @returns {{ medianMin: number, maxMin: number, count: number } | null} null when no qualifying incident
 */
export function computeRecoveryStats(incidents, now = Date.now(), windowDays = 7) {
  const cutoff = now - windowDays * 86_400_000
  const mins = (incidents ?? [])
    .filter((i) => i.status === 'resolved' && i.duration && i.duration !== '0m' && new Date(i.startedAt).getTime() >= cutoff)
    .map((i) => parseDurationToMin(i.duration))
    .filter((m) => m > 0)
    .sort((a, b) => a - b)
  if (mins.length === 0) return null
  // Lower-middle element for even counts — same convention as worker/src/score.ts
  // (durations[Math.floor(length / 2)]). Shared convention, not a guaranteed-equal result (see header:
  // the card is 7-day, score.ts is 30-day with a <3-incident mean fallback).
  const medianMin = mins[Math.floor(mins.length / 2)]
  const maxMin = mins[mins.length - 1]
  return { medianMin, maxMin, count: mins.length }
}
