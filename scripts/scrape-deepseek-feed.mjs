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
import { chromium } from 'playwright'

const PAGE_ID = '6410630422455' // status.deepseek.com Flashduty page id
const STATUS_HOME = 'https://status.deepseek.com/'
const API_BASE = `https://status.deepseek.com/api/status-page/${PAGE_ID}`

const WORKER_URL = process.env.WORKER_URL
const TOKEN = process.env.DEEPSEEK_FEED_TOKEN
if (!WORKER_URL || !TOKEN) {
  console.error('Missing WORKER_URL or DEEPSEEK_FEED_TOKEN env')
  process.exit(2)
}

const HISTORY_DAYS = 90 // change/list window — wide enough for the Score's 30d incident history + margin
const UPTIME_DAYS = 30 // summary/structure window — matches the 30-day uptime/impact the Score uses

async function main() {
  const browser = await chromium.launch()
  let data
  try {
    const page = await browser.newPage()
    // Establish a real browsing context on the host first (cookies / challenge cookies), then call
    // the JSON API from inside the page so requests carry the browser TLS + HTTP fingerprint.
    await page.goto(STATUS_HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    data = await page.evaluate(async ({ base, historyDays, uptimeDays }) => {
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
  } finally {
    await browser.close()
  }

  if (!data.active && !data.changeList && !data.structure) {
    // All three null → the bot wall changed or the API moved. Do NOT POST an empty payload (the
    // Worker rejects it anyway); exit non-zero so the Action surfaces a failure to investigate.
    console.error('All three Flashduty endpoints returned null — wall changed or API moved?')
    process.exit(1)
  }

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

main().catch((err) => {
  console.error('scrape-deepseek-feed failed:', err)
  process.exit(1)
})
