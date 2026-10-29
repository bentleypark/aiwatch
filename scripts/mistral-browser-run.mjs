// #1851 — the Browser Run reader's run: read status.mistral.ai the same way the Action does, push the
// same payload through the same gate, and record what happened.

import {
  readMistralFeed, deliverMistralFeed, runWithMistralFeedObservation, reportMistralFeedObservation,
  CloudflareChallengeError, RosterShortError, MistralPageContractError,
} from './scrape-mistral-status.mjs'
import { MISTRAL_WAKE_KEY } from '../worker/src/mistral-email.ts'

export const BROWSER_RUN_INDEX = 'mistral-browser-run'
/** The minute of every hour the reader reads without being woken. */
const SCHEDULED_READ_MINUTE = 41

/** A wake counts only once the flag is both read and deleted; any KV failure is no wake. */
async function consumeWake(kv) {
  try {
    if ((await kv.get(MISTRAL_WAKE_KEY)) === null) return false
    await kv.delete(MISTRAL_WAKE_KEY)
    return true
  } catch (err) {
    console.warn(`[browser-run] wake flag unreadable: ${err?.message ?? err}`)
    return false
  }
}

/** One per-minute cron tick: read at `SCHEDULED_READ_MINUTE` regardless of KV, or on a consumed wake. */
export async function onReaderTick({ scheduledTime, env, read }) {
  const scheduled = new Date(scheduledTime).getUTCMinutes() === SCHEDULED_READ_MINUTE
  const woken = await consumeWake(env.STATUS_CACHE)
  if (!scheduled && !woken) return false
  await read()
  return true
}

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

/** The mistral-reader Worker. `launch(binding)` is Browser Run's `puppeteer.launch`. */
export function createReader(launch) {
  return {
    async scheduled(controller, env) {
      await onReaderTick({ scheduledTime: controller.scheduledTime, env, read: () => runBrowserRead({
        withPage: async (fn) => {
          const browser = await launch(env.BROWSER)
          try {
            return await fn(await browser.newPage())
          } finally {
            await browser.close()
          }
        },
        // The service binding delivers to aiwatch-worker whatever the host; its router reads only the path.
        workerUrl: 'https://aiwatch-worker',
        token: env.MISTRAL_FEED_TOKEN,
        transport: (url, init) => env.AIWATCH.fetch(url, init),
        record: (point) => env.ANALYTICS.writeDataPoint(point),
      }) })
    },
  }
}
