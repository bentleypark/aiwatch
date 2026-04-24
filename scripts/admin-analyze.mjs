#!/usr/bin/env node
// Operator CLI for POST /api/admin/analyze (#299).
// Forces a Sonnet analysis on a specific active incident when the cron's
// Gemma-first default produces low-signal output.
//
// Usage:
//   ADMIN_API_KEY=... node scripts/admin-analyze.mjs <svcId> <incidentId> [--model sonnet|gemma] [--sticky false]
//
// Examples:
//   node scripts/admin-analyze.mjs chatgpt 01KPNN2V2SMP3TAN3MCJK87W50
//   node scripts/admin-analyze.mjs deepgram gwpqgqbl2rvv --model gemma
//   node scripts/admin-analyze.mjs claude 01KR... --sticky false
//
// Defaults: model=sonnet, sticky=true.
// Requires Node 18+ for built-in fetch.

const WORKER_URL = process.env.WORKER_URL
  ?? 'https://aiwatch-worker.p2c2kbf.workers.dev'

const args = process.argv.slice(2)
if (args.length < 2 || args[0] === '--help' || args[0] === '-h') {
  console.error('Usage: ADMIN_API_KEY=... node scripts/admin-analyze.mjs <svcId> <incidentId> [--model sonnet|gemma] [--sticky false]')
  process.exit(args[0] === '--help' || args[0] === '-h' ? 0 : 2)
}

const [svcId, incidentId, ...rest] = args
const body = { svcId, incidentId }
// Optional flags — strict pair-wise parse. Odd arg count = error up front, so a
// trailing token (e.g. `--model sonnet extra`) can't silently vanish.
if (rest.length % 2 !== 0) {
  console.error(`Flag args must come in --flag value pairs (got ${rest.length} tokens): ${rest.join(' ')}`)
  process.exit(2)
}
for (let i = 0; i < rest.length; i += 2) {
  const key = rest[i]?.replace(/^--/, '')
  const value = rest[i + 1]
  if (!key) {
    console.error(`Flag parse error near: ${rest.slice(i).join(' ')}`)
    process.exit(2)
  }
  if (key === 'model') {
    if (value !== 'sonnet' && value !== 'gemma') {
      console.error(`--model must be 'sonnet' or 'gemma' (got: ${value})`)
      process.exit(2)
    }
    body.model = value
  } else if (key === 'sticky') {
    // Strict allowlist — `--sticky yes` / `--sticky 0` / `--sticky FALSE` would
    // all silently become truthy under a `!== 'false'` check, which is the
    // opposite of what most operators expect. Force explicit true/false.
    if (value !== 'true' && value !== 'false') {
      console.error(`--sticky must be 'true' or 'false' (got: ${value})`)
      process.exit(2)
    }
    body.sticky = value === 'true'
  } else {
    console.error(`Unknown flag: --${key}`)
    process.exit(2)
  }
}

const adminKey = process.env.ADMIN_API_KEY
if (!adminKey) {
  console.error('ADMIN_API_KEY env var is required')
  console.error('Set with: export ADMIN_API_KEY="..." (value stored as Worker secret via `wrangler secret put ADMIN_API_KEY`)')
  process.exit(2)
}

const url = `${WORKER_URL}/api/admin/analyze`
const started = Date.now()

let res
try {
  res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Admin-Key': adminKey,
      'Content-Type': 'application/json',
      // Browser-like UA — `workers.dev` routes reject default fetch UA with Cloudflare error 1010.
      'User-Agent': 'Mozilla/5.0 AIWatch-AdminCLI',
    },
    body: JSON.stringify(body),
  })
} catch (err) {
  console.error(`Network error: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}

const text = await res.text()
let json
try { json = JSON.parse(text) } catch { /* e.g. Cloudflare error 1010 HTML page */ }

const elapsed = Date.now() - started
console.log(`HTTP ${res.status}  (${elapsed}ms)`)

if (json) {
  console.log(JSON.stringify(json, null, 2))
} else {
  // Cloudflare error page or other non-JSON — print raw.
  console.log(text)
}

if (res.status === 401) {
  console.error('\nHint: 401 means the secret is either missing or wrong. Re-check ADMIN_API_KEY.')
} else if (res.status === 404) {
  console.error(`\nHint: 404 scope guard — ${svcId}:${incidentId} is not in current /api/status active incidents.`)
  console.error('Run: curl -s ' + WORKER_URL + '/api/status | jq \'.services[] | select(.incidents[]?.status != "resolved") | {id, incidents: [.incidents[] | select(.status != "resolved") | {id, title}]}\' to list live incidents.')
} else if (res.status === 429) {
  console.error('\nHint: 429 rate-limited — wait 60s and retry (1 req / 60s per svcId+incidentId).')
} else if (res.status === 502) {
  console.error('\nHint: 502 upstream model error — Anthropic API / AI Gateway rejected or returned unparseable response. Check Worker logs.')
} else if (res.status === 503) {
  console.error('\nHint: 503 — ANTHROPIC_API_KEY not configured on Worker.')
}

process.exit(res.ok ? 0 : 1)
