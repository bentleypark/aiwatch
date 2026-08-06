#!/usr/bin/env node
/**
 * #1210 — one-time patch: recompute a FROZEN monthly archive's downtime display stats with the
 * autoMonitor exclusion that `aggregateIncidentDurations` applies from the next build onward.
 *
 * Why a script and not `/api/admin/rebuild-archive`: that endpoint is NOT idempotent for a frozen
 * month — it re-snapshots `score`/`grade`/`scoreConfidence` from TODAY's `services:latest`
 * (`resolveArchiveOfficialUptime`'s docstring says so and tells you to patch the KV entry directly),
 * regenerates the AI `narrative` over an operator-reviewed draft, and recomputes `predictionAccuracy`
 * from a rolling corpus. Sharper still: it rebuilds incidents from `incidents:monthly:{period}`, which
 * carries a 60d TTL — rebuild a month after that lapses and the incident data is simply gone.
 *
 * It is a DERIVATION, not a re-estimate: an auto-monitor entry carries `autoMonitor: true` (absent
 * means false) and every entry carries its final `durationMin`, so the new figures come out of the
 * stored `incidentList`. The guard below refuses unless the stored figures are exactly reproducible
 * from that list, so we never overwrite a number we cannot account for.
 *
 * It NEVER writes: it emits the patched document and prints the wrangler commands to run by hand.
 *
 *   node scripts/patch-archive-automonitor.mjs --period 2026-07
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const NAMESPACE_ID = 'e49508d80bb144e9a7ff872f2be771a4' // STATUS_CACHE (worker/wrangler.toml)

/** Sum/max/count the entries that COUNT toward downtime, excluding `autoMonitor`.
 *  Mirrors `aggregateIncidentDurations`' post-#1210 counted set. It deliberately does NOT re-implement
 *  `isNonReliabilityAdvisory` — `assertPatchable` refuses any service where that exclusion also fired,
 *  so a duplicated title classifier (which would drift from the worker's copy) is never needed. */
export function recompute(list, { excludeAutoMonitor = true } = {}) {
  let total = 0, longest = 0, counted = 0
  for (const e of list) {
    if (excludeAutoMonitor && e.autoMonitor) continue
    counted++
    const d = typeof e.durationMin === 'number' && e.durationMin > 0 ? e.durationMin : 0
    total += d
    if (d > longest) longest = d
  }
  return {
    totalDowntimeMin: total > 0 ? total : null,
    longestIncidentMin: longest > 0 ? longest : null,
    avgResolutionMin: counted > 0 && total > 0 ? Math.round(total / counted) : null,
    counted,
  }
}

/** Fail-closed gate, exact rather than inferential.
 *
 *  Two things must hold before we may overwrite a service's three downtime figures:
 *
 *  1. The list is the FULL population — `incidentList.length === incidents`. This is the same predicate
 *     `aggregateIncidentDurations` branches on, so the script and the worker agree by construction. On
 *     the truncated branch the stored figures came from the pre-summed accumulator, not the list, and
 *     recomputing from a capped list would silently DEFLATE a permanent record.
 *  2. The stored triple is exactly reproducible by summing the list with NO exclusions. If it is not,
 *     some other exclusion produced it (the #1021 advisory titles) and this script cannot reproduce
 *     that without duplicating the title classifier — so it refuses instead of guessing.
 *
 *  An earlier version inferred (2) by testing `round(total/length) === storedAvg`. That is not sound:
 *  `round(T/N) === round(T/(N-1))` collides routinely at small counted means, so a service whose
 *  advisory filter HAD fired could pass and then be written with the advisory re-added. It also never
 *  checked `longestIncidentMin`, which the script overwrites.
 *
 *  Returns `null` to proceed, or `{ kind, msg }` — `kind: 'skip'` is benign (nothing to do),
 *  `kind: 'refuse'` means we could not account for the stored value. They must not share a channel:
 *  a skip that printed as a refusal would fail the run for a healthy service.
 */
export function assertPatchable(id, s) {
  const list = s.incidentList ?? []
  if (!list.length) return { kind: 'skip', msg: `${id}: no incidentList` }

  if (typeof s.incidents !== 'number') {
    return { kind: 'refuse', msg: `${id}: incidents is ${JSON.stringify(s.incidents)}, not a number — cannot establish the list is the full population` }
  }
  if (list.length !== s.incidents) {
    return { kind: 'refuse', msg: `${id}: incidentList ${list.length} != incidents ${s.incidents} — TRUNCATED, so the stored aggregates came from the accumulator, not this list` }
  }
  // S5 — a ZERO-duration excluded entry moves neither total nor longest, so two of the three
  // comparisons below are blind to it and only the rounded average could catch it (and can collide).
  // Refuse rather than claim a soundness we don't have. Costs nothing on the real target: the 2026-07
  // archive carries no zero-duration entry on any of its 45 services.
  if (list.some((e) => e.autoMonitor && !(typeof e.durationMin === 'number' && e.durationMin > 0))) {
    return { kind: 'refuse', msg: `${id}: an EXCLUDED entry has a zero/absent durationMin — it moves neither total nor longest, so the reproducibility check above cannot see it` }
  }

  const already = recompute(list)
  if (s.totalDowntimeMin === already.totalDowntimeMin
    && s.longestIncidentMin === already.longestIncidentMin
    && s.avgResolutionMin === already.avgResolutionMin) {
    return { kind: 'skip', msg: `${id}: already patched (stored figures already match the filtered recompute)` }
  }

  const unfiltered = recompute(list, { excludeAutoMonitor: false })
  if (s.totalDowntimeMin !== unfiltered.totalDowntimeMin
    || s.longestIncidentMin !== unfiltered.longestIncidentMin
    || s.avgResolutionMin !== unfiltered.avgResolutionMin) {
    return { kind: 'refuse', msg: `${id}: stored (${s.totalDowntimeMin}/${s.longestIncidentMin}/${s.avgResolutionMin}) is not reproducible from the unfiltered list (${unfiltered.totalDowntimeMin}/${unfiltered.longestIncidentMin}/${unfiltered.avgResolutionMin}) — another exclusion produced it; refusing` }
  }
  return null
}

/** Classify every service in an archive into changes / skips / refusals. Pure, so the whole decision
 *  layer is testable without touching KV. */
export function planPatch(archive) {
  const changes = [], skips = [], refusals = []
  for (const [id, s] of Object.entries(archive.services ?? {})) {
    const list = s.incidentList ?? []
    const flagged = list.filter((e) => e.autoMonitor).length
    if (!flagged) continue

    const verdict = assertPatchable(id, s)
    if (verdict?.kind === 'refuse') { refusals.push(verdict.msg); continue }
    if (verdict?.kind === 'skip') { skips.push(verdict.msg); continue }

    changes.push({
      id, flagged, total: list.length,
      before: { totalDowntimeMin: s.totalDowntimeMin, longestIncidentMin: s.longestIncidentMin, avgResolutionMin: s.avgResolutionMin, countedIncidents: s.countedIncidents },
      after: recompute(list),
    })
  }
  return { changes, skips, refusals }
}

// ── CLI (below this line: I/O only) ──────────────────────────────────

function kv(...extra) {
  return execFileSync('npx', ['wrangler', 'kv', 'key', ...extra, '--config', 'worker/wrangler.toml', '--namespace-id', NAMESPACE_ID, '--remote'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
}

/** wrangler failures and non-JSON output (a Cloudflare error page, an auth prompt, an empty read) must
 *  name themselves — a bare `SyntaxError: Unexpected end of JSON input` tells the operator nothing about
 *  a script that is about to overwrite a permanent key. Same shape as suppress-incident.mjs' tolerant
 *  parse (that one wraps an HTTP response, not a CLI, so only the shape carries over). */
function kvRaw(...extra) {
  try {
    return kv(...extra)
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

function main(argv) {
  const pIdx = argv.indexOf('--period')
  const period = pIdx === -1 ? undefined : argv[pIdx + 1]
  if (!/^\d{4}-\d{2}$/.test(period ?? '')) {
    console.error('usage: patch-archive-automonitor.mjs --period YYYY-MM')
    process.exit(2)
  }
  const key = `archive:monthly:${period}`

  const original = kvRaw('get', key)
  const archive = parseOrDie(original, key)
  if (archive.period !== period) {
    console.error(`${key} holds period "${archive.period}" — refusing to patch a different month than requested`)
    process.exit(1)
  }
  if (!archive.services || typeof archive.services !== 'object') {
    console.error(`${key} has no services object — refusing`)
    process.exit(1)
  }
  console.log(`${key} — generatedAt ${archive.generatedAt}, ${Object.keys(archive.services).length} services\n`)

  const { changes, skips, refusals } = planPatch(archive)

  for (const s of skips) console.log(`SKIP: ${s}`)
  for (const r of refusals) console.error(`REFUSED: ${r}`)
  if (skips.length || refusals.length) console.log('')

  for (const c of changes) {
    console.log(`${c.id} — ${c.flagged} of ${c.total} entries flagged autoMonitor`)
    for (const f of ['totalDowntimeMin', 'longestIncidentMin', 'avgResolutionMin']) {
      console.log(`   ${f.padEnd(20)} ${String(c.before[f]).padStart(7)}  →  ${String(c.after[f]).padStart(7)}`)
    }
    console.log(`   incidents / countedIncidents / uptime / officialUptime / monthlyScore / incidentList: untouched`)
  }
  console.log(`\nplanned: ${changes.length} patched · ${skips.length} skipped · ${refusals.length} refused`)
  if (archive.narrative) {
    console.log(`NOTE: this archive carries a baked AI narrative drafted from the PRE-patch figures — hand-review it before publishing.`)
  }

  // A refusal means a service's stored numbers could not be accounted for. Writing the others would
  // leave the archive in a mixed state with a green exit, so the whole run stops.
  if (refusals.length) {
    console.error(`\nREFUSING THE WHOLE RUN — ${refusals.length} service(s) could not be verified. Nothing written.`)
    process.exit(1)
  }
  if (!changes.length) {
    console.log('Nothing to patch.')
    process.exit(0)
  }
  if (!changes.length) {
    console.log('Nothing to patch.')
    process.exit(0)
  }

  // The script does NOT write. It emits the patched document and prints the two commands the operator
  // runs by hand.
  //
  // Earlier revisions wrote to KV directly, and every round of review found new defects in that ~70-line
  // half — a three-way read-back, a retry loop, a sleep, a size check, a relocated backup — none of it
  // CI-gatable, because it is all I/O. The decision layer above (`recompute` / `assertPatchable` /
  // `planPatch`) is pure and covered by `npm run test:scripts`; this was the only untested surface, and
  // it guarded the one irreversible action in the repo (a permanent, no-TTL key). Handing the write to
  // the operator deletes the whole class: the backup is their own `kv key get > before.json` in a
  // location they chose, verification is a `diff` they can read, and there is no path where a script
  // decides on its own that a permanent record should be overwritten.
  const outDir = process.env.ARCHIVE_PATCH_DIR ?? '.'
  const out = resolve(outDir, `${key.replace(/:/g, '_')}.patched.json`)
  for (const c of changes) {
    const s = archive.services[c.id]
    s.totalDowntimeMin = c.after.totalDowntimeMin
    s.longestIncidentMin = c.after.longestIncidentMin
    s.avgResolutionMin = c.after.avgResolutionMin
    // Deliberately NOT setting `countedIncidents`: it would be set on the flagged services only, and a
    // service excluded by the #1021 advisory rule instead (junie, 2026-07) would keep an absent field
    // that the schema reads as "nothing was excluded". A uniformly pre-#1210 archive is honest; a
    // half-annotated one is a false negative on the exact question the field answers.
  }
  writeFileSync(out, JSON.stringify(archive))

  const wrangler = `--config worker/wrangler.toml --namespace-id ${NAMESPACE_ID} --remote`
  console.log(`\nPatched document written to: ${out}`)
  console.log(`\nTo apply, run these yourself (nothing above touched KV):`)
  console.log(`  1. back up:  npx wrangler kv key get ${key} ${wrangler} > ${resolve(outDir, 'archive-before.json')}`)
  console.log(`  2. inspect:  diff <(python3 -m json.tool ${resolve(outDir, 'archive-before.json')}) <(python3 -m json.tool ${out})`)
  console.log(`  3. apply:    npx wrangler kv key put ${key} --path ${out} ${wrangler}`)
  console.log(`  4. verify:   npx wrangler kv key get ${key} ${wrangler} | diff - ${out} && echo OK`)
  console.log(`\nKeep archive-before.json until the patched archive is confirmed correct — \`incidents:monthly:${period}\` (the only other copy of this data) expires 60 days after the month.`)
  process.exit(0)
}

if (process.argv[1] && process.argv[1].endsWith('patch-archive-automonitor.mjs')) {
  main(process.argv.slice(2))
}
