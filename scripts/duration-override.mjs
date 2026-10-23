#!/usr/bin/env node
// Operator CLI for GET/POST /api/admin/duration-override (#1019).
// Pin an incident's duration to an operator-stated value without hiding the incident.
//
// Usage:
//   ADMIN_API_KEY=... node scripts/duration-override.mjs list
//   ADMIN_API_KEY=... node scripts/duration-override.mjs add    --id <incId> --minutes <n> [--reason "..."]
//   ADMIN_API_KEY=... node scripts/duration-override.mjs remove --id <incId>
//   add/remove also take [--confirm off] to skip the post-write confirmation (#1740).
//
// Requires Node 18+ for built-in fetch.

import { adminRequest, parseFlagPairs, printResponse, runMutation } from './operator-admin.mjs'

const PATH = '/api/admin/duration-override'
const USAGE = `Usage:
  ADMIN_API_KEY=... node scripts/duration-override.mjs list
  ADMIN_API_KEY=... node scripts/duration-override.mjs add    --id <incId> --minutes <n> [--reason "..."]
  ADMIN_API_KEY=... node scripts/duration-override.mjs remove --id <incId>
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

if (!flags.id) { console.error('--id is required'); process.exit(2) }
if (flags.confirm !== undefined && flags.confirm !== 'off') {
  console.error(`--confirm only takes 'off' (got: ${flags.confirm})`)
  process.exit(2)
}
const body = { action, id: flags.id }
if (action === 'add') {
  if (!/^\d+(\.\d+)?$/.test(flags.minutes ?? '')) {
    console.error(`--minutes must be a finite number >= 0 (got: ${flags.minutes ?? '(none)'})`)
    process.exit(2)
  }
  body.durationMin = Number(flags.minutes)
  if (flags.reason) body.reason = flags.reason
}

process.exit(await runMutation(PATH, adminKey, body, flags.confirm,
  'check --id, --minutes (add) and action (add/remove).'))
