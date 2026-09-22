/**
 * #1383 — one terminal observation for each Mistral Rootly scraper run.
 *
 * The feed cache holds only the latest accepted scrape, which makes a historical
 * `listed > fetched` run unrecoverable. This is deliberately diagnostic-only:
 * it neither reads nor writes `mistral:feed`, and it carries bounded counters
 * rather than incident ids, URLs, titles, or raw errors.
 */

export const MISTRAL_FEED_OBSERVATION_INDEX = 'mistral-feed-observation'
export const MISTRAL_FEED_OBSERVATION_SOURCE = 'mistral-rootly'

export type MistralFeedDelivery = 'stored' | 'rejected' | 'not-posted'
export type MistralFeedCoverage = 'complete' | 'partial' | 'unavailable'

export interface NormalizedMistralFeedObservation {
  delivery: MistralFeedDelivery
  coverage: MistralFeedCoverage
  listed: number
  fetched: number
  missing: number
  available: number
  uptimeLostTooltips: number
}

const DELIVERIES = new Set<MistralFeedDelivery>(['stored', 'rejected', 'not-posted'])

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** Parse the Action's intentionally small, authenticated terminal observation.
 *
 * A no-payload run is a real observation too: the page/browser failed before
 * coverage was knowable. Once any coverage counter is supplied, all three page
 * counters must be present so a malformed client cannot turn a loss into an
 * apparently complete scrape.
 */
export function parseMistralFeedObservation(value: unknown): NormalizedMistralFeedObservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (typeof input.delivery !== 'string' || !DELIVERIES.has(input.delivery as MistralFeedDelivery)) return null
  const delivery = input.delivery as MistralFeedDelivery
  const hasCoverage = input.listed !== undefined || input.fetched !== undefined || input.available !== undefined
  const uptimeLostTooltips = input.uptimeLostTooltips === undefined ? 0 : nonNegativeInteger(input.uptimeLostTooltips)
  if (uptimeLostTooltips === null) return null

  if (!hasCoverage) {
    return { delivery, coverage: 'unavailable', listed: 0, fetched: 0, missing: 0, available: 0, uptimeLostTooltips }
  }

  const listed = nonNegativeInteger(input.listed)
  const fetched = nonNegativeInteger(input.fetched)
  const available = nonNegativeInteger(input.available)
  if (listed === null || fetched === null || available === null || fetched > listed || listed > available) return null
  return {
    delivery,
    coverage: fetched < listed ? 'partial' : 'complete',
    listed,
    fetched,
    missing: listed - fetched,
    available,
    uptimeLostTooltips,
  }
}

/** Best-effort only: an Analytics Engine failure must never affect source data. */
export function recordMistralFeedObservation(
  analytics: AnalyticsEngineDataset | undefined,
  observation: NormalizedMistralFeedObservation,
): void {
  if (!analytics) return
  try {
    analytics.writeDataPoint({
      // blob1 source, blob2 delivery, blob3 incident coverage; all fixed vocabularies.
      blobs: [MISTRAL_FEED_OBSERVATION_SOURCE, observation.delivery, observation.coverage],
      // count, listed, fetched, missing, page-available, lost uptime tooltips.
      doubles: [1, observation.listed, observation.fetched, observation.missing, observation.available, observation.uptimeLostTooltips],
      indexes: [MISTRAL_FEED_OBSERVATION_INDEX],
    })
  } catch (err) {
    console.warn('[wae] mistral-feed-observation write failed:', err instanceof Error ? err.message : err)
  }
}
