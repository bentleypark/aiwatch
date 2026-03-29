// Web Vitals collection — sends LCP, FCP, TTFB, CLS, INP to Worker for aggregation
// Uses fetch+keepalive for reliable cross-origin delivery on page unload
// 10% sampling to stay within KV write budget (~30 writes/day)

import { onLCP, onFCP, onTTFB, onCLS, onINP } from 'web-vitals'

const SAMPLE_RATE = 0.1 // 10% of page loads
const WORKER_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:8788').replace(/\/api\/status$/, '')
const ENDPOINT = `${WORKER_BASE}/api/vitals`

// Deterministic per-session: decide once whether this pageload is sampled
const isSampled = Math.random() < SAMPLE_RATE

let pending = {}
let flushed = false

function flush() {
  const keys = Object.keys(pending)
  if (keys.length === 0 || flushed) return
  flushed = true // prevent duplicate sends from visibilitychange + beforeunload
  const payload = JSON.stringify({ metrics: { ...pending }, ts: Date.now() })
  pending = {}
  fetch(ENDPOINT, {
    method: 'POST',
    body: payload,
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,
    mode: 'cors',
    credentials: 'omit',
  }).catch(() => {}) // best-effort telemetry — silent on failure
}

function collect({ name, value }) {
  pending[name] = Math.round(name === 'CLS' ? value * 1000 : value) // CLS: unitless → ×1000 for integer storage
}

export function initVitals() {
  if (!isSampled) return

  onLCP(collect)
  onFCP(collect)
  onTTFB(collect)
  onCLS(collect)
  onINP(collect)

  // Flush on visibilitychange (most reliable) + beforeunload (fallback)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
  window.addEventListener('beforeunload', flush)
}
