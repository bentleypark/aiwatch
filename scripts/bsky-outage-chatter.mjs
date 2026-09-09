#!/usr/bin/env node
// #1374 — does "is X down" chatter actually cluster on Bluesky during a real outage? This counts
// matching posts per UTC day so the series can be set beside AIWatch's own outage-day axis.
// Access path, the 403 that looks like an auth failure, and the 2026-09-09 baseline:
// docs/reference/bluesky-measurement.md.
//
// READ-ONLY. It authenticates and searches; it never creates a record.
//
// Usage:
//   BSKY_IDENTIFIER=you.bsky.social BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
//     node scripts/bsky-outage-chatter.mjs --start 2026-09-01 --end 2026-09-09
//
// Credentials come from the environment. Use an APP PASSWORD (Bluesky Settings → Privacy and
// Security → App Passwords), never the account password: it is individually revocable and cannot
// change the account's email or password. `BSKY_IDENTIFIER` accepts a full handle, an email, or a
// DID — a bare username (no dot) fails with the same 401 as a wrong password, so the script checks
// that shape up front rather than letting the two be indistinguishable.
//
// Flags (all optional):
//   --start / --end  inclusive UTC dates, YYYY-MM-DD (default: the 9 days ending today)
//   --queries        comma-separated search strings (default: the five below)
//   --appview        override the appview host (default: https://api.bsky.app — see APPVIEW below)
//   --json           print the raw per-query/per-day counts instead of a table

import { fileURLToPath } from 'node:url'

// api.bsky.app, NOT public.api.bsky.app. The public host answers `searchPosts` with a 403 even when
// a valid token is supplied, while answering `getProfile` 200 unauthenticated on the same host.
// `https://bsky.social` also serves it. Measured 2026-09-09; see docs/reference/bluesky-measurement.md.
// Do not add a rule here mapping response shape to cause — that claim was made twice and falsified
// twice, and `xrpc` below reports the observation instead.
const APPVIEW = 'https://api.bsky.app'
const PDS = 'https://bsky.social'

const DEFAULT_QUERIES = ['claude down', 'chatgpt down', 'openai down', 'cursor down', 'anthropic outage']

/** Inclusive UTC date range as YYYY-MM-DD strings. */
export function dayRange(start, end) {
  const out = []
  const d = new Date(`${start}T00:00:00Z`)
  const last = new Date(`${end}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || Number.isNaN(last.getTime())) throw new Error(`bad date range: ${start}..${end}`)
  // Inverted is rejected for the same reason unparseable is: an empty day list reads downstream as
  // "no days measured" — `main` would build its probe window from `undefined` and send
  // `undefinedT13:00:00Z`. Reachable from an ordinary typo (`--start` a month ahead, `--end` omitted
  // so it defaults to today).
  if (d > last) throw new Error(`bad date range: ${start} is after ${end}`)
  while (d <= last) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

/** The [since, until) bounds `searchPosts` takes for one whole UTC day. */
export function dayWindow(day) {
  return { since: `${day}T00:00:00Z`, until: `${day}T23:59:59Z` }
}

export function buildSearchUrl(appview, { q, since, until, limit = 100, cursor }) {
  const p = new URLSearchParams({ q, since, until, limit: String(limit) })
  if (cursor) p.set('cursor', cursor)
  return `${appview}/xrpc/app.bsky.feed.searchPosts?${p}`
}

/**
 * An identifier `createSession` can resolve. A bare username is the one shape that fails
 * indistinguishably from a wrong password, so it is rejected before the request rather than after.
 */
export function isResolvableIdentifier(id) {
  return typeof id === 'string' && (id.includes('.') || id.includes('@') || id.startsWith('did:'))
}

export function parseArgs(argv) {
  const args = { queries: DEFAULT_QUERIES, appview: APPVIEW, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--json') args.json = true
    else if (a === '--start') args.start = argv[++i]
    else if (a === '--end') args.end = argv[++i]
    else if (a === '--appview') args.appview = argv[++i]
    else if (a === '--queries') args.queries = argv[++i].split(',').map((s) => s.trim()).filter(Boolean)
  }
  if (!args.end) args.end = new Date().toISOString().slice(0, 10)
  if (!args.start) {
    const d = new Date(`${args.end}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - 8)
    args.start = d.toISOString().slice(0, 10)
  }
  return args
}

/**
 * The counts table. `days` are columns; the last row is the per-day total across queries.
 *
 * Kept pure and separate from the fetching so the shape is testable on its own.
 */
export function formatCell(cell) {
  if (cell == null) return '0'
  if (typeof cell === 'number') return String(cell)
  return cell.capped ? `${cell.n}+` : String(cell.n)
}

export function cellCount(cell) {
  if (cell == null) return 0
  return typeof cell === 'number' ? cell : cell.n
}

export function formatTable(counts, days, queries) {
  const w = 7
  const head = 'query'.padEnd(22) + days.map((d) => d.slice(5).padStart(w)).join('')
  const rows = queries.map((q) => q.padEnd(22) + days.map((d) => formatCell(counts[q]?.[d]).padStart(w)).join(''))
  // A `+` anywhere in the column means at least one query hit the cap, so the column total is a
  // lower bound too — marked rather than left to read as exact.
  const total = 'TOTAL'.padEnd(22) + days.map((d) => {
    const sum = queries.reduce((s, q) => s + cellCount(counts[q]?.[d]), 0)
    const anyCapped = queries.some((q) => counts[q]?.[d]?.capped)
    return `${sum}${anyCapped ? '+' : ''}`.padStart(w)
  }).join('')
  const rule = '='.repeat(head.length)
  return [rule, head, ...rows, total, rule].join('\n')
}

/**
 * One XRPC GET, with 429 backoff.
 *
 * On failure it REPORTS what came back and draws no conclusion about the cause. An earlier version
 * tried to classify the body — HTML meaning an edge block, JSON meaning a real XRPC error — and the
 * rule turned out to be wrong: `api.bsky.app`, the host this script defaults to and the one that
 * works, also answers HTML 403 when the Authorization header is missing. A response-shape-to-cause
 * mapping is a claim that has to be re-verified against every host and every credential state, so
 * there is deliberately none here; the status, the content-type and a body excerpt are enough to
 * act on and cannot go stale.
 *
 * `fetchImpl` is injectable so the failure paths are testable without an account or a network.
 */
export async function xrpc(url, token, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetchImpl(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
    if (res.status === 429 && attempt < 3) {
      await sleep(5000 * (attempt + 1))
      continue
    }
    if (!res.ok) {
      const ct = res.headers.get('content-type') || 'no content-type'
      const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 160)
      throw new Error(`HTTP ${res.status} for ${new URL(url).pathname} [${ct}] ${body}`)
    }
    return res.json()
  }
  throw new Error('unreachable')
}

async function createSession(identifier, password) {
  const res = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  })
  if (!res.ok) throw new Error(`createSession HTTP ${res.status} — check BSKY_IDENTIFIER and the app password`)
  return res.json()
}

/**
 * Count matching posts, paginating until exhausted or `cap` is passed.
 *
 * Returns `{ n, capped }` rather than a bare number: a run that stops at the cap reports a count
 * indistinguishable from a genuine one, and two capped readings compare as "no change" when one
 * could be several times the other — which would defeat keeping a baseline as a control.
 *
 * `n` can OVERSHOOT `cap`, because the API returns fewer than `limit` per page and the loop adds a
 * whole page before testing the cap. Page size varies between requests, so no constant is recorded
 * here. `capped` is therefore the honest signal, not `n >= cap`.
 */
export async function searchCount(appview, token, q, since, until, cap = 1000, deps = {}) {
  let cursor
  let n = 0
  let capped = false
  for (;;) {
    const d = await xrpc(buildSearchUrl(appview, { q, since, until, cursor }), token, deps.fetchImpl, deps.sleep)
    // A 200 whose shape we don't recognise must not read as "zero posts" — that is a silent zero in
    // a measurement whose whole point is that a LOW number is a reportable finding.
    if (!Array.isArray(d.posts)) throw new Error(`searchPosts returned no posts array for "${q}"`)
    n += d.posts.length
    cursor = d.cursor
    if (!cursor || d.posts.length === 0) break
    if (n >= cap) { capped = true; break }
    await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(300)
  }
  return { n, capped }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const identifier = (process.env.BSKY_IDENTIFIER || '').trim()
  const password = (process.env.BSKY_APP_PASSWORD || '').trim()
  if (!identifier || !password) {
    console.error('set BSKY_IDENTIFIER and BSKY_APP_PASSWORD (an APP password, not the account password)')
    process.exit(1)
  }
  if (!isResolvableIdentifier(identifier)) {
    console.error(`BSKY_IDENTIFIER "${identifier.length} chars" looks like a bare username. Use the full`
      + ' handle (name.bsky.social), an email, or a DID — a bare username 401s exactly like a wrong password.')
    process.exit(1)
  }

  const sess = await createSession(identifier, password)
  console.log(`authenticated as ${sess.handle} (${sess.did})\n`)
  const token = sess.accessJwt
  const days = dayRange(args.start, args.end)

  // Instrument check. Without it an empty result and a broken search are byte-identical, and this
  // measurement's whole point is that a LOW number is a finding — so the low number has to be
  // distinguishable from a dead instrument before any of it is reportable.
  const probeDay = days[Math.floor(days.length / 2)]
  const probe = await searchCount(args.appview, token, 'the', `${probeDay}T13:00:00Z`, `${probeDay}T14:00:00Z`, 100)
  console.log(`instrument check — generic query over one hour of ${probeDay}: ${formatCell(probe)} posts`)
  if (probe.n === 0) {
    console.error('INVALID: the control query returned nothing. Search is not working, so no conclusion'
      + ' can be drawn about outage chatter.')
    process.exit(1)
  }
  console.log()

  const counts = {}
  for (const q of args.queries) {
    counts[q] = {}
    for (const day of days) {
      const { since, until } = dayWindow(day)
      counts[q][day] = await searchCount(args.appview, token, q, since, until)
      await new Promise((r) => setTimeout(r, 400))
    }
    console.log(`  ${q.padEnd(20)} ${days.map((d) => formatCell(counts[q][d]).padStart(6)).join('')}`)
  }

  console.log()
  if (args.json) console.log(JSON.stringify(counts, null, 2))
  else console.log(formatTable(counts, days, args.queries))
  console.log('\nThese counts are a LOWER BOUND over the chosen query strings, not a measure of how much'
    + '\noutage talk exists. A low number means "not caught by these queries", not "does not cluster".')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
