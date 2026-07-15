#!/usr/bin/env node
// Operator CLI for GET/POST /api/admin/suppress (#904).
// Manage the incident-suppression list: hide a correctly-attributed incident from the live list,
// the Score, the monthly accumulator, and rebuilt archives — no deploy, reversible.
//
// Usage:
//   ADMIN_API_KEY=... node scripts/suppress-incident.mjs list
//   ADMIN_API_KEY=... node scripts/suppress-incident.mjs add    --scope service-pattern --svc <id> --match <substr> [--reason "..."]
//   ADMIN_API_KEY=... node scripts/suppress-incident.mjs add    --scope incident --incId <id> [--reason "..."]
//   ADMIN_API_KEY=... node scripts/suppress-incident.mjs remove --scope service-pattern --svc <id> --match <substr>
//   ADMIN_API_KEY=... node scripts/suppress-incident.mjs remove --scope incident --incId <id>
//
// Example (the FedRAMP first use):
//   node scripts/suppress-incident.mjs add --scope service-pattern --svc openai --match fedramp \
//     --reason "gov-compliance scope, not general-API availability"
//
// Requires Node 18+ for built-in fetch.

const WORKER_URL = process.env.WORKER_URL ?? 'https://aiwatch-worker.p2c2kbf.workers.dev'
const USAGE = `Usage:
  ADMIN_API_KEY=... node scripts/suppress-incident.mjs list
  ADMIN_API_KEY=... node scripts/suppress-incident.mjs add    --scope service-pattern --svc <id> --match <substr> [--reason "..."]
  ADMIN_API_KEY=... node scripts/suppress-incident.mjs add    --scope incident --incId <id> [--reason "..."]
  ADMIN_API_KEY=... node scripts/suppress-incident.mjs remove (same flags as the matching add)`

const args = process.argv.slice(2)
const action = args[0]
if (!action || action === '--help' || action === '-h') {
  console.error(USAGE)
  process.exit(action === '--help' || action === '-h' ? 0 : 2)
}
if (!['list', 'add', 'remove'].includes(action)) {
  console.error(`Unknown action: ${action}\n${USAGE}`)
  process.exit(2)
}

// Parse --flag value pairs (strict, like admin-analyze.mjs).
const rest = args.slice(1)
if (rest.length % 2 !== 0) {
  console.error(`Flag args must come in --flag value pairs (got ${rest.length} tokens): ${rest.join(' ')}`)
  process.exit(2)
}
const flags = {}
for (let i = 0; i < rest.length; i += 2) {
  const key = rest[i]?.replace(/^--/, '')
  const value = rest[i + 1]
  if (!key) { console.error(`Flag parse error near: ${rest.slice(i).join(' ')}`); process.exit(2) }
  flags[key] = value
}

const adminKey = process.env.ADMIN_API_KEY
if (!adminKey) {
  console.error('ADMIN_API_KEY env var is required')
  console.error('Set with: export ADMIN_API_KEY="..." (value stored as Worker secret via `wrangler secret put ADMIN_API_KEY`)')
  process.exit(2)
}

let method = 'GET'
let body

if (action !== 'list') {
  const scope = flags.scope
  if (scope !== 'incident' && scope !== 'service-pattern') {
    console.error(`--scope must be 'incident' or 'service-pattern' (got: ${scope ?? '(none)'})`)
    process.exit(2)
  }
  body = { action, scope }
  if (scope === 'incident') {
    if (!flags.incId) { console.error('--incId is required for --scope incident'); process.exit(2) }
    body.incId = flags.incId
  } else {
    if (!flags.svc || !flags.match) { console.error('--svc and --match are required for --scope service-pattern'); process.exit(2) }
    body.svcId = flags.svc
    body.match = flags.match
  }
  if (flags.reason) body.reason = flags.reason
  method = 'POST'
}

const url = `${WORKER_URL}/api/admin/suppress`
const started = Date.now()

let res
try {
  res = await fetch(url, {
    method,
    headers: {
      'X-Admin-Key': adminKey,
      'Content-Type': 'application/json',
      // Browser-like UA — workers.dev routes reject the default fetch UA with Cloudflare error 1010.
      'User-Agent': 'Mozilla/5.0 AIWatch-AdminCLI',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
} catch (err) {
  console.error(`Network error: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}

const text = await res.text()
let json
try { json = JSON.parse(text) } catch { /* e.g. Cloudflare error 1010 HTML page */ }

console.log(`HTTP ${res.status}  (${Date.now() - started}ms)`)
console.log(json ? JSON.stringify(json, null, 2) : text)

if (res.status === 401) {
  console.error('\nHint: 401 means the secret is missing or wrong. Re-check ADMIN_API_KEY.')
} else if (res.status === 400) {
  console.error('\nHint: 400 — check --scope + required flags (incId, or svc+match) and action (add/remove).')
} else if (res.status === 502) {
  console.error('\nHint: 502 — KV read/write failed. Check Worker logs.')
}

process.exit(res.ok ? 0 : 1)
