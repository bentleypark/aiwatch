// #1686 — how long each /api/status poll took for this user, sent to the Worker in batches of five
// for the operator's slow-dashboard alert. Anonymous timing values only (the Worker adds the colo and
// country Cloudflare attaches to the beacon). Each batch also carries a random id minted once per page
// load and held only in this module's memory (no storage, no cookie). Sent without a consent check,
// like vitals.js.

const WORKER_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:8788').replace(/\/api\/status$/, '')
const ENDPOINT = `${WORKER_BASE}/api/rum`
export const BATCH_SIZE = 5

export function makeSessionId() {
  const c = globalThis.crypto
  if (typeof c?.getRandomValues !== 'function') return null
  const bytes = c.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const sessionId = makeSessionId()

let buffer = []
let inflight = null
let listening = false

/** The worker's own handling time from `Server-Timing: worker;dur=123`, or null. */
export function parseServerTiming(header) {
  const m = /(?:^|,)\s*worker\s*;\s*dur=(\d+(?:\.\d+)?)/.exec(header ?? '')
  return m ? Math.round(Number(m[1])) : null
}

function send(samples) {
  if (samples.length === 0) return
  fetch(ENDPOINT, {
    method: 'POST',
    body: JSON.stringify({ sessionId, samples }),
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,
    mode: 'cors',
    credentials: 'omit',
  }).catch(() => {}) // best-effort telemetry
}

function flush() {
  const samples = buffer
  buffer = []
  send(samples)
}

function onHidden() {
  if (document.visibilityState !== 'hidden') return
  // A poll still in flight when the user leaves is the slow case this exists for: send how long it
  // had taken so far, as a lower bound.
  if (inflight) {
    buffer.push({ totalMs: Math.round(performance.now() - inflight.t0), serverMs: null, outcome: 'pending' })
    inflight.done = true
  }
  inflight = null
  flush()
}

export function startApiTiming() {
  if (!listening && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onHidden)
    listening = true
  }
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
  inflight = { t0: performance.now(), hidden }
  return inflight
}

/** Called when a poll's response headers arrive. */
export function noteHeaders(timing, res) {
  timing.serverMs = parseServerTiming(res?.headers?.get?.('Server-Timing'))
}

/** outcome: 'ok' | 'timeout' | 'error' | 'pending'. Only the first call for a poll counts. */
export function finishApiTiming(timing, { outcome }) {
  if (inflight === timing) inflight = null
  if (!timing || timing.done) return
  timing.done = true
  if (timing.hidden) return
  buffer.push({
    totalMs: Math.round(performance.now() - timing.t0),
    serverMs: timing.serverMs ?? null,
    outcome,
  })
  if (buffer.length >= BATCH_SIZE) flush()
}

export const getSessionId = () => sessionId

/** Test seam. */
export function _resetApiTiming() {
  buffer = []
  inflight = null
}
