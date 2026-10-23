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
//   add/remove also take [--confirm off] to skip the post-write confirmation (#1740).
//
// Example (the FedRAMP first use):
//   node scripts/suppress-incident.mjs add --scope service-pattern --svc openai --match fedramp \
//     --reason "gov-compliance scope, not general-API availability"
//
// Requires Node 18+ for built-in fetch.

import { adminRequest, parseFlagPairs, printResponse, runMutation } from './operator-admin.mjs'

const PATH = '/api/admin/suppress'
const USAGE = `Usage:
  ADMIN_API_KEY=... node scripts/suppress-incident.mjs list
  ADMIN_API_KEY=... node scripts/suppress-incident.mjs add    --scope service-pattern --svc <id> --match <substr> [--reason "..."]
  ADMIN_API_KEY=... node scripts/suppress-incident.mjs add    --scope incident --incId <id> [--reason "..."]
  ADMIN_API_KEY=... node scripts/suppress-incident.mjs remove (same flags as the matching add)
  add/remove: [--confirm off] skips the post-write confirmation`

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

const parsed = parseFlagPairs(args.slice(1))
if (parsed.error) { console.error(parsed.error); process.exit(2) }
const flags = parsed.flags

const adminKey = process.env.ADMIN_API_KEY
if (!adminKey) {
  console.error('ADMIN_API_KEY env var is required')
  console.error('Set with: export ADMIN_API_KEY="..." (value stored as Worker secret via `wrangler secret put ADMIN_API_KEY`)')
  process.exit(2)
}

if (action === 'list') {
  const started = Date.now()
  let res
  try {
    res = await adminRequest(PATH, adminKey, 'GET')
  } catch (err) {
    console.error(`Network error: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
  printResponse(res, started)
  process.exit(res.ok ? 0 : 1)
}

const scope = flags.scope
if (scope !== 'incident' && scope !== 'service-pattern') {
  console.error(`--scope must be 'incident' or 'service-pattern' (got: ${scope ?? '(none)'})`)
  process.exit(2)
}
if (flags.confirm !== undefined && flags.confirm !== 'off') {
  console.error(`--confirm only takes 'off' (got: ${flags.confirm})`)
  process.exit(2)
}
const body = { action, scope }
if (scope === 'incident') {
  if (!flags.incId) { console.error('--incId is required for --scope incident'); process.exit(2) }
  body.incId = flags.incId
} else {
  if (!flags.svc || !flags.match) { console.error('--svc and --match are required for --scope service-pattern'); process.exit(2) }
  body.svcId = flags.svc
  body.match = flags.match
}
if (flags.reason) body.reason = flags.reason

process.exit(await runMutation(PATH, adminKey, body, flags.confirm,
  'check --scope + required flags (incId, or svc+match) and action (add/remove).'))
