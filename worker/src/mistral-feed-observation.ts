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
export const MISTRAL_PAGE_CONTRACT_CONSECUTIVE_KEY = 'mistral:page-contract:consecutive'
export const MISTRAL_PAGE_CONTRACT_ALERT_KEY = 'alerted:mistral-page-contract'
export const MISTRAL_PAGE_CONTRACT_ALERT_TTL_S = 7 * 24 * 60 * 60
const MISTRAL_PAGE_CONTRACT_CONSECUTIVE_TTL_S = 2 * 60 * 60

export type MistralFeedDelivery = 'stored' | 'rejected' | 'not-posted'
export type MistralFeedCoverage = 'complete' | 'partial' | 'unavailable'
export type MistralFeedFailure = 'page-contract'

export interface NormalizedMistralFeedObservation {
  delivery: MistralFeedDelivery
  coverage: MistralFeedCoverage
  listed: number
  fetched: number
  missing: number
  available: number
  uptimeLostTooltips: number
  /** Present only when the browser reached Rootly but its expected v3 structure did not. */
  failure?: MistralFeedFailure
}

const DELIVERIES = new Set<MistralFeedDelivery>(['stored', 'rejected', 'not-posted'])
const FAILURES = new Set<MistralFeedFailure>(['page-contract'])

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
  const failure = input.failure === undefined ? undefined
    : (typeof input.failure === 'string' && FAILURES.has(input.failure as MistralFeedFailure)
      ? input.failure as MistralFeedFailure : null)
  if (failure === null) return null
  const hasCoverage = input.listed !== undefined || input.fetched !== undefined || input.available !== undefined
  const uptimeLostTooltips = input.uptimeLostTooltips === undefined ? 0 : nonNegativeInteger(input.uptimeLostTooltips)
  if (uptimeLostTooltips === null) return null

  if (!hasCoverage) {
    return { delivery, coverage: 'unavailable', listed: 0, fetched: 0, missing: 0, available: 0, uptimeLostTooltips, ...(failure ? { failure } : {}) }
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
    ...(failure ? { failure } : {}),
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
      // blob1 source, blob2 delivery, blob3 incident coverage, blob4 failure class; all fixed vocabularies.
      blobs: [MISTRAL_FEED_OBSERVATION_SOURCE, observation.delivery, observation.coverage, observation.failure ?? 'none'],
      // count, listed, fetched, missing, page-available, lost uptime tooltips.
      doubles: [1, observation.listed, observation.fetched, observation.missing, observation.available, observation.uptimeLostTooltips],
      indexes: [MISTRAL_FEED_OBSERVATION_INDEX],
    })
  } catch (err) {
    console.warn('[wae] mistral-feed-observation write failed:', err instanceof Error ? err.message : err)
  }
}

interface PageContractKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * Count only adjacent, independently completed scraper runs. Any other terminal observation clears
 * the streak, so a Cloudflare challenge cannot be relabelled as a Rootly contract migration.
 */
export async function observeMistralPageContract(
  kv: PageContractKv,
  observation: NormalizedMistralFeedObservation,
  send: () => Promise<boolean>,
): Promise<{ consecutive: number; alerted: boolean }> {
  if (observation.failure !== 'page-contract') {
    await kv.delete(MISTRAL_PAGE_CONTRACT_CONSECUTIVE_KEY)
    if (observation.delivery === 'stored') await kv.delete(MISTRAL_PAGE_CONTRACT_ALERT_KEY)
    return { consecutive: 0, alerted: false }
  }

  let prior = 0
  try {
    const raw = await kv.get(MISTRAL_PAGE_CONTRACT_CONSECUTIVE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    prior = Number.isInteger(parsed?.count) && parsed.count >= 0 ? parsed.count : 0
  } catch {
    // A failed diagnostic read must not prevent recording the current confirmed run.
  }
  const consecutive = prior + 1
  await kv.put(MISTRAL_PAGE_CONTRACT_CONSECUTIVE_KEY, JSON.stringify({ count: consecutive }), {
    expirationTtl: MISTRAL_PAGE_CONTRACT_CONSECUTIVE_TTL_S,
  })
  if (consecutive < 2 || await kv.get(MISTRAL_PAGE_CONTRACT_ALERT_KEY)) return { consecutive, alerted: false }
  const sent = await send()
  if (sent) await kv.put(MISTRAL_PAGE_CONTRACT_ALERT_KEY, '1', { expirationTtl: MISTRAL_PAGE_CONTRACT_ALERT_TTL_S })
  return { consecutive, alerted: sent }
}
