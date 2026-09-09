#!/usr/bin/env node
/**
 * #965 — one-time patch: null the fabricated `officialUptime` #951 left frozen in the May 2026 archive.
 *
 * `archive:monthly:2026-05` was rebuilt 2026-06-13 — after #586 added `officialUptime` to the archive
 * shape, but before #713 (merged 2026-06-19) removed the incident-derived uptime ESTIMATE. The daily
 * counter stored that estimate without any marker distinguishing it from a real official percentage
 * (`uptimeSource` was not populated at all in this archive — every service, contaminated or not, reads
 * it as absent, so it CANNOT be used as a selector here), so `computeMonthlyOfficialUptime`'s
 * last-non-null-day rule picked up the estimate and published it as though it were official. #951 fixed
 * the code and corrected the June archive the same way this script corrects May.
 *
 * There is no algorithmic predicate for "this officialUptime is fabricated" over the archive's OWN
 * current fields — that is the defect: the archive cannot tell the two apart at read time either. The
 * six services below are a FIXED, MANUALLY-ESTABLISHED list (aiwatch#965), each with its own expected
 * CURRENT value. The guard is not "which services look contaminated" (nothing here can answer that) but
 * "does the archive still hold exactly what the issue found" — if a stored value has drifted from what
 * is expected, that is the signal to stop and look, not to patch through it.
 *
 * It NEVER writes: it emits the patched document and prints the wrangler commands to run by hand.
 *
 *   node scripts/patch-archive-officialuptime-scrub.mjs
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const NAMESPACE_ID = 'e49508d80bb144e9a7ff872f2be771a4' // STATUS_CACHE (worker/wrangler.toml)
export const PERIOD = '2026-05'

/** aiwatch#965's own table — the archived (contaminated) `officialUptime` for each service, as
 *  measured against production when the issue was filed. Not re-derived here; a script that could
 *  re-derive which values are fabricated would BE the fix, and no such derivation exists. */
export const CONTAMINATED = [
  { id: 'stability', archived: 100 },
  { id: 'elevenlabs', archived: 99.21 },
  { id: 'replicate', archived: 99.34 },
  { id: 'characterai', archived: 99.61 },
  { id: 'bedrock', archived: 100 },
  { id: 'azureopenai', archived: 100 },
]

/**
 * Plan the correction. Pure: reads the archive, writes nothing.
 *
 * Returns THREE lists, and `skips`/`refusals` must not share a channel (the automonitor sibling states
 * this rule and this script follows it): `kind: 'skip'` is benign (nothing to do — already fixed, or
 * the service isn't in this archive). `kind: 'refuse'` means the CURRENT stored value does not match
 * the `archived` figure #965 recorded — the archive has changed since the issue was filed in some way
 * this script cannot account for, so it is a reason to stop the WHOLE run and look, not a per-service
 * skip. Writing the other five while one is unaccounted for would leave the archive in a mixed state
 * with a green exit.
 */
export function planScrub(archive) {
  const changes = []
  const skips = []
  const refusals = []
  for (const { id, archived } of CONTAMINATED) {
    const svc = archive.services?.[id]
    if (!svc) {
      skips.push(`${id}: not present in this archive — nothing to patch`)
      continue
    }
    const current = svc.officialUptime
    if (current === null || current === undefined) {
      skips.push(`${id}: officialUptime is already ${JSON.stringify(current)} — already fixed, leaving as-is`)
      continue
    }
    if (current !== archived) {
      refusals.push(`${id}: officialUptime is ${JSON.stringify(current)}, but #965 recorded ${archived} — the archive has changed since the issue was filed; investigate before patching by hand`)
      continue
    }
    changes.push({ id, before: current })
  }
  return { changes, skips, refusals }
}

// ── CLI (below this line: I/O only) ──────────────────────────────────

function kvRaw(...extra) {
  try {
    return execFileSync('npx', ['wrangler', 'kv', 'key', ...extra, '--config', 'worker/wrangler.toml', '--namespace-id', NAMESPACE_ID, '--remote'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    })
  } catch (err) {
    console.error(`wrangler kv ${extra[0]} failed (exit ${err.status ?? '?'}): ${String(err.stderr ?? err.message).slice(0, 600)}`)
    process.exit(1)
  }
}

function parseOrDie(raw, what) {
  try {
    return JSON.parse(raw)
  } catch {
    console.error(`${what} returned non-JSON (${raw.length} bytes). First 200 chars:\n${raw.slice(0, 200)}`)
    process.exit(1)
  }
}

function main() {
  const key = `archive:monthly:${PERIOD}`

  const original = kvRaw('get', key)
  const archive = parseOrDie(original, key)
  if (archive.period !== PERIOD) {
    console.error(`${key} holds period "${archive.period}" — refusing to patch a different month than expected`)
    process.exit(1)
  }
  if (!archive.services || typeof archive.services !== 'object') {
    console.error(`${key} has no services object — refusing`)
    process.exit(1)
  }
  console.log(`${key} — generatedAt ${archive.generatedAt}, ${Object.keys(archive.services).length} services\n`)

  const { changes, skips, refusals } = planScrub(archive)
  for (const s of skips) console.log(`SKIP: ${s}`)
  for (const r of refusals) console.error(`REFUSED: ${r}`)
  if (skips.length || refusals.length) console.log('')

  for (const c of changes) {
    console.log(`${c.id} — officialUptime ${c.before} → null`)
  }
  console.log(`\nplanned: ${changes.length} patched · ${skips.length} skipped · ${refusals.length} refused`)

  // A refusal means a service's stored value could not be accounted for. Writing the others would
  // leave the archive in a mixed state with a green exit, so the whole run stops — nothing written.
  if (refusals.length) {
    console.error(`\nREFUSING THE WHOLE RUN — ${refusals.length} service(s) could not be verified. Nothing written.`)
    process.exit(1)
  }
  if (!changes.length) {
    console.log('Nothing to patch.')
    process.exit(0)
  }

  // Same division as the sibling patch-archive-*.mjs scripts: the decision layer above is pure and
  // CI-gated by `npm run test:scripts`; the irreversible write to a permanent, no-TTL key stays with
  // the operator, whose backup and diff are their own.
  const outDir = process.env.ARCHIVE_PATCH_DIR ?? '.'
  const out = resolve(outDir, `${key.replace(/:/g, '_')}.patched.json`)
  for (const c of changes) archive.services[c.id].officialUptime = null
  writeFileSync(out, JSON.stringify(archive))

  const wrangler = `--config worker/wrangler.toml --namespace-id ${NAMESPACE_ID} --remote`
  console.log(`\nPatched document written to: ${out}`)
  console.log(`\nTo apply, run these yourself (nothing above touched KV):`)
  console.log(`  1. back up:  npx wrangler kv key get ${key} ${wrangler} > ${resolve(outDir, 'archive-before.json')}`)
  console.log(`  2. inspect:  diff <(python3 -m json.tool ${resolve(outDir, 'archive-before.json')}) <(python3 -m json.tool ${out})`)
  console.log(`  3. apply:    npx wrangler kv key put ${key} --path ${out} ${wrangler}`)
  console.log(`  4. verify:   npx wrangler kv key get ${key} ${wrangler} | diff - ${out} && echo OK`)
  console.log(`\nStep 2 must show ONLY "officialUptime" changing to null on the ${changes.length} service(s) above.`)
  process.exit(0)
}

if (process.argv[1] && process.argv[1].endsWith('patch-archive-officialuptime-scrub.mjs')) {
  main()
}
