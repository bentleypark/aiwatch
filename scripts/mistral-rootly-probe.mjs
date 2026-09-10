#!/usr/bin/env node
// TEMPORARY probe — delete with the chore/mistral-rootly-probe branch.
//
// Does a HEADED Chrome under a virtual display clear status.mistral.ai's Cloudflare *managed
// challenge*, when every headless variant is rejected?
//
// The DeepSeek precedent (#618, scripts/scrape-deepseek-feed.mjs) clears a DIFFERENT wall — a
// TLS-fingerprint block that ANY browser context passes — so a headless launch suffices there.
// Measured locally (one machine, one residential IP): Mistral rejects bundled-chromium headless,
// full-chromium new-headless AND real-Chrome-channel headless with 403, and serves a headed browser
// 200 with 14 uptime charts. The untested variant is headed-under-xvfb from a datacenter IP.
//
// Uses the runner's PREINSTALLED Chrome (`channel: 'chrome'`) rather than `playwright install`:
// that keeps this throwaway out of the #1253 Playwright-workflow invariant (which pins the count of
// browser-installing workflows and requires each to carry a browser cache), and it is the strongest
// fingerprint available — if real Chrome headed is refused, a bundled Chromium certainly is.
//
// ── Why all three probes live here, and why the outcome is tri-state ─────────────────────────────
// The thing this experiment must never do is report its own malfunction as a finding about
// Cloudflare. So:
//   * every probe resolves to `cleared` | `challenged` | `error` — never a bare boolean. A missing
//     Chrome and a genuinely walled IP are different answers and must not print the same line.
//   * the non-browser control is a plain `fetch` HERE rather than a `curl` step in the workflow.
//     Under GitHub's default `bash -e` a curl transport failure (timeout, reset — a realistic
//     Cloudflare response to a datacenter IP) killed the job before the question was ever asked,
//     and `curl` without `-f` exits 0 on any status, so the step was green on a 200 it was named to
//     reject. One classifier, one exit path, no shell.
//   * the verdict is decided by the OUTCOME MATRIX at the bottom. Anything that is not a clean
//     three-way read prints INCONCLUSIVE and exits non-zero, so a red job means "the instrument had
//     a problem" and a green job means "we learned something" — including the NOT-viable answer.
import { chromium } from 'playwright'

const URL = 'https://status.mistral.ai/'
const CHALLENGE = /just a moment|security verification|verify you are human|cf-mitigated/i
// The uptime charts ARE the data a scrape would read; a challenge interstitial carries none, so
// their presence — not a 200 — is what "cleared" means.
const CHARTS = 'turbo-frame[id^="uptime-chart-"]'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Poll instead of sampling once at a fixed delay. A managed challenge's JS solve can finish later on
// a shared runner under software rendering than it does on a local machine, and a single late sample
// would record `charts: 0` — textually identical to a permanent block. Reads are retried because the
// challenge's own navigation can destroy the execution context mid-read, which Playwright does not
// retry across.
async function settle(page, budgetMs = 40000) {
  const deadline = Date.now() + budgetMs
  let last = { charts: 0, title: '', body: '', reads: 0 }
  while (Date.now() < deadline) {
    try {
      const charts = await page.locator(CHARTS).count()
      const title = await page.title()
      const body = await page.evaluate(() => document.body.innerText.slice(0, 200))
      last = { charts, title, body, reads: last.reads + 1 }
      if (charts > 0) return last
    } catch {
      // navigation teardown mid-read — try again until the budget runs out
    }
    await sleep(2000)
  }
  return last
}

function classify({ charts, title, body, reads }, httpStatus) {
  if (charts > 0) return 'cleared'
  if (reads === 0) return 'error' // never got a single clean read of the page
  // A 403 is the wall's signature whatever words the interstitial happens to use — the same rule
  // `fetchProbe` applies. Without it, a challenge page phrased differently from today's ("Verifying
  // you are human", "Attention Required!", a 1015 rate-limit notice) classifies as instrument
  // malfunction, and the matrix's error branch would then suppress an otherwise decisive run.
  if (httpStatus === 403) return 'challenged'
  return CHALLENGE.test(`${title} ${body}`) ? 'challenged' : 'error'
}

async function browserProbe(label, launchOpts) {
  let browser
  try {
    browser = await chromium.launch(launchOpts)
    const page = await (await browser.newContext()).newPage()
    const resp = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
    const s = await settle(page)
    return {
      label,
      outcome: classify(s, resp?.status() ?? null),
      httpStatus: resp?.status() ?? null,
      title: s.title,
      uptimeCharts: s.charts,
      reads: s.reads,
      bodyHead: s.body.replace(/\s+/g, ' ').trim().slice(0, 100),
    }
  } catch (e) {
    return { label, outcome: 'error', error: String(e).split('\n')[0].slice(0, 200) }
  } finally {
    if (browser) await browser.close()
  }
}

// The non-browser control. A throw here is `error`, never `challenged` — a DNS or TLS failure says
// nothing about bot management.
async function fetchProbe(label) {
  try {
    const r = await fetch(URL, { signal: AbortSignal.timeout(30000) })
    const body = (await r.text()).slice(0, 400)
    const walled = r.status === 403 || r.headers.get('cf-mitigated') != null || CHALLENGE.test(body)
    return {
      label,
      outcome: walled ? 'challenged' : 'cleared',
      httpStatus: r.status,
      cfMitigated: r.headers.get('cf-mitigated'),
      bodyHead: body.replace(/\s+/g, ' ').trim().slice(0, 100),
    }
  } catch (e) {
    return { label, outcome: 'error', error: String(e).split('\n')[0].slice(0, 200) }
  }
}

const plain = await fetchProbe('CONTROL A — plain fetch, no browser')
const headless = await browserProbe('CONTROL B — headless Chrome', { headless: true, channel: 'chrome' })
const headed = await browserProbe('QUESTION C — headed Chrome under xvfb', { headless: false, channel: 'chrome' })

for (const r of [plain, headless, headed]) console.log('RESULT ' + JSON.stringify(r))
console.log('---')
console.log(`OUTCOMES plain=${plain.outcome} headless=${headless.outcome} headed=${headed.outcome}`)

// ── Outcome matrix ───────────────────────────────────────────────────────────────────────────────
// Ordered so every inconclusive shape is caught BEFORE any claim about Cloudflare is printed.
let verdict
let decisive
const errored = [plain, headless, headed].filter((r) => r.outcome === 'error')

if (errored.length > 0) {
  verdict = `INCONCLUSIVE — ${errored.map((r) => r.label).join('; ')} errored. This says nothing about the challenge; read the RESULT lines.`
  decisive = false
} else if (plain.outcome === 'cleared') {
  verdict = 'INCONCLUSIVE — the non-browser control was NOT walled, so the contrast the browser probes are read against is missing. A headed pass here would prove nothing about headed-ness.'
  decisive = false
} else if (headless.outcome === 'cleared') {
  verdict = 'ANSWER — headless Chrome CLEARS the challenge from this runner. No xvfb needed; the DeepSeek launch would work as-is. (Diverges from the local measurement — worth re-checking before building on it.)'
  decisive = true
} else if (headed.outcome === 'cleared') {
  verdict = 'ANSWER — xvfb-headed CLEARS the challenge and headless does not. The DeepSeek approach is viable WITH xvfb.'
  decisive = true
} else {
  verdict = 'ANSWER — neither headless nor xvfb-headed clears it from this runner. The DeepSeek approach is NOT viable on GitHub Actions.'
  decisive = true
}

console.log('VERDICT ' + verdict)
// Green = we learned something (including a NOT-viable answer). Red = the instrument had a problem.
process.exit(decisive ? 0 : 1)
