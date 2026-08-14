#!/usr/bin/env node
// #998 — ad-hoc GA4 Data API CLI query tool. There is no official "GA4 CLI"; this signs a service-
// account JWT by hand (Node's built-in crypto, no deps) and calls the Data API's runReport directly.
// Setup + what's already provisioned: docs/reference/ga4-cli-access.md.
//
// Usage:
//   node scripts/ga4-report.mjs --dimensions hostName,testDataFilterName --metrics sessions --start 2026-07-14 --end today
//
// Flags (all optional, defaults cover the common "how much local/preview traffic hit prod GA4" case):
//   --dimensions  comma-separated GA4 dimension apiNames (default: hostName)
//   --metrics     comma-separated GA4 metric apiNames (default: sessions)
//   --start       GA4 date string, e.g. 2026-07-14 or NdaysAgo (default: 30daysAgo)
//   --end         GA4 date string, e.g. today (default: today)
//   --limit       max rows (default: 50) — the report is TRUNCATED silently by the API past this;
//                 formatTable prints a "(showing N of M rows)" line when that happens, so raise this
//                 rather than trust a table that looks complete
//   --key         path to the service-account key JSON (default: the ga4-reporter key under ~/.config/gcloud)
//   --property    GA4 numeric property ID (default: 529375750, the AIWatch property)
//   --json        print the raw API response instead of a table

import { readFileSync } from 'node:fs'
import { createSign } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const DEFAULT_KEY_PATH = `${process.env.HOME}/.config/gcloud/legacy_credentials/ga4-reporter@aiwatch-ga4-10072.iam.gserviceaccount.com/adc.json`
const DEFAULT_PROPERTY_ID = '529375750' // AIWatch GA4 property (account 145080382)

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function getAccessToken(keyPath) {
  let sa
  try {
    sa = JSON.parse(readFileSync(keyPath, 'utf8'))
  } catch (err) {
    throw new Error(`could not read/parse service-account key at ${keyPath} (${err.message}) — see docs/reference/ga4-cli-access.md's provisioning section`)
  }
  if (!sa.private_key || !sa.client_email) {
    throw new Error(`${keyPath} is valid JSON but not a service-account key (missing private_key/client_email) — see docs/reference/ga4-cli-access.md's provisioning section`)
  }
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  // analytics.readonly is deliberately the only scope requested — this tool only ever reads reports.
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }
  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(claims)))}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  const signature = signer.sign(sa.private_key)
  const jwt = `${signingInput}.${b64url(signature)}`

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`token exchange failed: ${JSON.stringify(body)}`)
  return body.access_token
}

async function runReport(token, propertyId, { dimensions, metrics, startDate, endDate, limit }) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate, endDate }],
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
      orderBys: [{ metric: { metricName: metrics[0] }, desc: true }],
      limit,
    }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`runReport failed: ${JSON.stringify(body)}`)
  return body
}

export function parseArgs(argv) {
  const args = {
    dimensions: ['hostName'], metrics: ['sessions'], startDate: '30daysAgo', endDate: 'today',
    limit: 50, keyPath: DEFAULT_KEY_PATH, propertyId: DEFAULT_PROPERTY_ID, json: false,
  }
  const FLAGS_WITH_VALUE = new Set(['--dimensions', '--metrics', '--start', '--end', '--limit', '--key', '--property'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (FLAGS_WITH_VALUE.has(a) && argv[i + 1] === undefined) {
      throw new Error(`${a} needs a value`)
    }
    if (a === '--dimensions') args.dimensions = argv[++i].split(',')
    else if (a === '--metrics') args.metrics = argv[++i].split(',')
    else if (a === '--start') args.startDate = argv[++i]
    else if (a === '--end') args.endDate = argv[++i]
    else if (a === '--limit') {
      const n = Number(argv[++i])
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--limit must be a positive integer, got ${argv[i]}`)
      args.limit = n
    }
    else if (a === '--key') args.keyPath = argv[++i]
    else if (a === '--property') args.propertyId = argv[++i]
    else if (a === '--json') args.json = true
    else throw new Error(`unknown flag: ${a} (see the usage comment at the top of this script)`)
  }
  return args
}

export function formatTable(report) {
  const dimNames = report.dimensionHeaders?.map((h) => h.name) ?? []
  const metNames = report.metricHeaders?.map((h) => h.name) ?? []
  const lines = [[...dimNames, ...metNames].join('\t')]
  for (const row of report.rows ?? []) {
    const dimVals = row.dimensionValues.map((v) => v.value)
    const metVals = row.metricValues.map((v) => v.value)
    lines.push([...dimVals, ...metVals].join('\t'))
  }
  if (!report.rows?.length) lines.push('(no rows)')
  // A truncated report looks IDENTICAL to a complete one otherwise — rows are ordered by the first
  // metric descending, so the cut silently drops the low end, not a random sample.
  else if (typeof report.rowCount === 'number' && report.rowCount > report.rows.length) {
    lines.push(`(showing ${report.rows.length} of ${report.rowCount} rows — raise --limit to see the rest)`)
  }
  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const token = await getAccessToken(args.keyPath)
  const report = await runReport(token, args.propertyId, args)
  console.log(args.json ? JSON.stringify(report, null, 2) : formatTable(report))
}

// Only run when invoked directly (not when imported for its pure helpers, e.g. by a test). Compares
// real filesystem paths rather than raw URL strings — a `file://${process.argv[1]}` string comparison
// (this repo's own #1150 regression, pinned in review-loop-gate.test.mjs / step35-verify-gate.test.mjs)
// never matches once the path percent-encodes (a space, `#`, or non-ASCII character), which fails
// OPEN here: the script would print nothing and exit 0, indistinguishable from "zero rows found".
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.cause ? `${err.message}\ncause: ${err.cause.message}` : err.message)
    process.exit(1)
  })
}
