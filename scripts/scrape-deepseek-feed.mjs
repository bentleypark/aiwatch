#!/usr/bin/env node
// #618 — browser-render DeepSeek's Flashduty status feed and push it to the Worker.
//
// status.deepseek.com (Flashduty, #507) blocks non-browser TLS fingerprints — a plain fetch()/curl
// is reset at the TLS layer regardless of IP (verified 2026-06-12: a real Chromium from the same IP
// succeeds). So a Cloudflare Worker can't read it. This script (run by .github/workflows/
// deepseek-feed.yml on a schedule) launches headless Chromium, fetches the clean Flashduty JSON API
// FROM the browser context (browser fingerprint clears the wall), and POSTs the raw payload to
// /api/internal/deepseek-feed, which caches it in KV for fetchService('deepseek') to normalize.
//
// Env:
//   WORKER_URL           — Worker origin, e.g. https://aiwatch-worker.p2c2kbf.workers.dev
//   DEEPSEEK_FEED_TOKEN  — Bearer token; must equal the Worker's DEEPSEEK_FEED_TOKEN secret
// (playwright is imported lazily inside main() so the unit test can import withRetry without it.)

// #668 — retry a flaky async op with linear backoff. status.deepseek.com (bot-walled Flashduty SPA)
// intermittently exceeds the page.goto timeout; a single attempt fails the whole job. This retries the
// transient failure. Throws the last error once attempts are exhausted (caller then exits non-zero).
export async function withRetry(fn, { attempts = 3, delayMs = 3000, label = 'op', sleep } = {}) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < attempts) {
        console.warn(`[${label}] attempt ${i}/${attempts} failed: ${err?.message ?? err} — retrying in ${delayMs * i}ms`)
        await wait(delayMs * i)
      }
    }
  }
  throw lastErr
}

const PAGE_ID = '6410630422455' // status.deepseek.com Flashduty page id
const STATUS_HOME = 'https://status.deepseek.com/'
const API_BASE = `https://status.deepseek.com/api/status-page/${PAGE_ID}`

const HISTORY_DAYS = 90 // change/list window — wide enough for the Score's 30d incident history + margin
// summary/structure window — 90 days to MATCH what the official DeepSeek status page displays (it
// shows a 90-day uptime, e.g. Web Chat 99.48% / API 99.88%) and AIWatch's own convention: the
// Atlassian parseUptimeData path iterates the full ~90-day uptimeData window, so "Official Uptime"
// is effectively 90-day for every official-source service. A 30-day window here produced a higher,
// inconsistent number (99.92%) that didn't match the source page (#619).
const UPTIME_DAYS = 90

async function main() {
  // Env validated inside main (not at module load) so importing this module for the withRetry unit
  // test doesn't process.exit on missing secrets.
  const WORKER_URL = process.env.WORKER_URL
  const TOKEN = process.env.DEEPSEEK_FEED_TOKEN
  if (!WORKER_URL || !TOKEN) {
    console.error('Missing WORKER_URL or DEEPSEEK_FEED_TOKEN env')
    process.exit(2)
  }
  const { chromium } = await import('playwright') // lazy — keeps withRetry unit-testable without playwright
  const browser = await chromium.launch()
  let data
  try {
    const page = await browser.newPage()
    // Establish a real browsing context on the host first (cookies / challenge cookies), then call
    // the JSON API from inside the page so requests carry the browser TLS + HTTP fingerprint.
    // #668 — retry the goto: status.deepseek.com intermittently exceeds the domcontentloaded wait.
    await withRetry(
      () => page.goto(STATUS_HOME, { waitUntil: 'domcontentloaded', timeout: 45_000 }),
      { attempts: 3, delayMs: 3000, label: 'deepseek goto' },
    )
    // #668 — retry the in-page scrape too (not just the goto): `summary/active` is the load-bearing
    // live-incident endpoint, and it's the most likely to flake against the bot wall. If it comes back
    // null we MUST NOT ship a partial feed (active:null reads as "operational" → DeepSeek would look
    // healthy during a real outage), so re-run the evaluate and, on persistent null, throw → exit 1
    // (the prior 3h-TTL feed stays; the next */5 dispatch retries). changeList/structure may degrade
    // to null gracefully (history/uptime only).
    data = await withRetry(async () => {
      const d = await page.evaluate(async ({ base, historyDays, uptimeDays }) => {
        const now = Math.floor(Date.now() / 1000)
        // Per-request 15s timeout so one hung endpoint fails fast instead of burning the job budget.
        const j = (u) =>
          fetch(u, { signal: AbortSignal.timeout(15_000) })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
        const [active, changeList, structure] = await Promise.all([
          j(`${base}/summary/active`),
          j(`${base}/change/list?start_at_seconds=${now - historyDays * 86400}&end_at_seconds=${now}`),
          j(`${base}/summary/structure?start_at_from_seconds=${now - uptimeDays * 86400}&start_at_to_seconds=${now}`),
        ])
        return { active: active?.data ?? null, changeList: changeList?.data ?? null, structure: structure?.data ?? null }
      }, { base: API_BASE, historyDays: HISTORY_DAYS, uptimeDays: UPTIME_DAYS })
      if (!d.active) throw new Error('summary/active returned null (bot wall / transient) — refusing a partial feed')
      return d
    }, { attempts: 3, delayMs: 3000, label: 'deepseek scrape' })
  } finally {
    // Don't let a close failure mask the real scrape error (it would propagate instead of the throw).
    await browser.close().catch((e) => console.warn(`browser.close failed: ${e?.message ?? e}`))
  }

  // active is guaranteed non-null here (withRetry above throws otherwise). Warn on the non-critical
  // endpoints so a degraded-but-shipped scrape is visible in the Action log.
  if (!data.changeList) console.warn('changeList null — incident history will be missing this cycle')
  if (!data.structure) console.warn('structure null — uptime%% will be missing this cycle')

  const res = await fetch(`${WORKER_URL}/api/internal/deepseek-feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(data),
  })
  const text = await res.text()
  if (!res.ok) {
    console.error(`POST failed: ${res.status} ${text}`)
    process.exit(1)
  }
  console.log(`Pushed DeepSeek feed: ${text}`)
}

// Guard so importing this module (e.g. the unit test for withRetry) does NOT launch a browser.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('scrape-deepseek-feed failed:', err)
    process.exit(1)
  })
}
