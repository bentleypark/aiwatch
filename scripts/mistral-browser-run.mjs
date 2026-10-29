// #1851 — the Browser Run reader's run: read status.mistral.ai the same way the Action does, push the
// same payload through the same gate, and record what happened. The Worker that hosts it
// (mistral-reader/) only supplies the browser page, the push transport and the Analytics Engine sink.

import {
  readMistralFeed, deliverMistralFeed, runWithMistralFeedObservation, reportMistralFeedObservation,
  CloudflareChallengeError, RosterShortError, MistralPageContractError,
} from './scrape-mistral-status.mjs'

export const BROWSER_RUN_INDEX = 'mistral-browser-run'

/** One attempt → one outcome word. A push the Worker accepted is the only `pass`. */
export function classifyBrowserRun(delivery, err) {
  if (delivery === 'stored') return 'pass'
  if (delivery === 'rejected') return 'rejected'
  if (err instanceof CloudflareChallengeError) return 'challenged'
  if (err instanceof RosterShortError) return 'roster-short'
  if (err instanceof MistralPageContractError) return 'page-contract'
  return 'error'
}

/** The Analytics Engine row for one attempt. The counters are 0 when the read never produced a payload. */
export function browserRunDataPoint(outcome, durationMs, payload) {
  return {
    // blob1 index name, blob2 outcome.
    blobs: [BROWSER_RUN_INDEX, outcome],
    // count, duration, components, incidents listed, incidents read.
    doubles: [1, durationMs, payload?.components?.length ?? 0, payload?.coverage?.listed ?? 0, payload?.coverage?.fetched ?? 0],
    indexes: [BROWSER_RUN_INDEX],
  }
}

/**
 * One attempt. `withPage(fn)` opens a browser page, runs `fn(page)` and closes it; `transport` is the
 * fetch the push and the terminal observation go through. Never throws: the outcome is the result.
 */
export async function runBrowserRead({ withPage, workerUrl, token, transport, record, clock = Date.now }) {
  let state
  const started = clock()
  let error
  try {
    await runWithMistralFeedObservation(workerUrl, token, async (s) => {
      state = s
      await withPage(async (page) => deliverMistralFeed(workerUrl, token, s, await readMistralFeed(page), transport))
    }, (url, tok, observation) => reportMistralFeedObservation(url, tok, observation, transport))
  } catch (err) {
    error = err
  }
  const outcome = classifyBrowserRun(state?.delivery, error)
  const durationMs = clock() - started
  try {
    record(browserRunDataPoint(outcome, durationMs, state?.payload))
  } catch (err) {
    console.warn(`[browser-run] record failed: ${err?.message ?? err}`)
  }
  console.log(`[browser-run] outcome=${outcome} durationMs=${durationMs}${error ? ` error=${error?.message ?? error}` : ''}`)
  return outcome
}
