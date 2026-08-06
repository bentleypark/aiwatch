#!/usr/bin/env node
/**
 * #1006 — one-time patch: restore the missing `uptimeSource` provenance on a FROZEN monthly archive.
 *
 * The archive writers built their `ArchiveScoreInput` by hand and never copied `uptimeSource`, so the
 * field `buildMonthlyArchive` reads had no producer. Months written before that fix carry an official
 * uptime with no provenance, and the reports generator's `uptimeSourceLabel` falls back to 'Official'
 * when the key is absent — so a Better Stack figure (the status-page platform's own monitors) publishes
 * as though the provider had declared it.
 *
 * One row contradicts that account and is deliberately not explained away: `fireworks` in the 2026-07
 * archive DOES carry `uptimeSource`, though the worker source that was HEAD when the cron built it
 * (`a70a660`) omits it at both call sites. Provenance in these archives is therefore not fully
 * accounted for, which is why rule 1 below never overwrites a stored value.
 *
 * Why a script and not `/api/admin/rebuild-archive`: that endpoint is NOT idempotent for a frozen
 * month (see `resolveArchiveOfficialUptime`'s docstring, which says to patch the KV entry directly).
 * Worse here specifically — it re-snapshots from TODAY's `services:latest`, and provenance is exactly
 * the thing that has since changed: `51068ff` (merged 2026-08-03) moved fireworks off Better Stack to
 * incident.io, so a rebuild of 2026-07 would overwrite its `platform_avg` with today's `official`.
 *
 * It NEVER writes: it emits the patched document and prints the wrangler commands to run by hand.
 *
 *   node scripts/patch-archive-uptimesource.mjs --period 2026-07
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const NAMESPACE_ID = 'e49508d80bb144e9a7ff872f2be771a4' // STATUS_CACHE (worker/wrangler.toml)

/**
 * The Better Stack roster, parsed from `services.ts` rather than hardcoded here.
 *
 * `platform_avg` is emitted at exactly one place in the worker (`services.ts`, the
 * `betterStackUptime != null` branch), reachable only for a service configured with `betterStackUrl`.
 * So the config IS the predicate. A hardcoded id list in this script would be a second copy of a
 * rotating set — it would read as current long after a service joined or left, and this script's whole
 * job is to assert provenance.
 */
export function betterStackIdsFrom(servicesSrc) {
  const ids = []
  // One SERVICES entry per line in services.ts; `id:` always precedes `betterStackUrl:` within it.
  for (const line of servicesSrc.split('\n')) {
    // A commented-out entry is disabled config, not a roster member — and services.ts really does keep
    // prose about Better Stack next to the entries (see luma's), so both comment forms are excluded.
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
    if (!line.includes('betterStackUrl:')) continue
    const m = /\bid:\s*'([^']+)'/.exec(line)
    if (m) ids.push(m[1])
  }
  return ids
}

/**
 * Classify every service in an archive. Pure, so the whole decision layer is testable without KV.
 *
 * The script only ever ADDS `platform_avg` where today's config can vouch for it. Everything else is
 * reported and left exactly as it is — absent provenance is the pre-existing state, so declining to act
 * is always safe, and there is deliberately no verdict that aborts the run. An earlier draft made the
 * unresolvable cases REFUSALS that killed the whole run; that held four correctly-derivable services
 * hostage to one undecidable one, and (verified) left the 2026-07 archive with no invocation that could
 * complete at all, had its one anomalous row not existed.
 *
 *  1. A service that ALREADY carries `uptimeSource` is never touched — not to "correct" it toward
 *     today's config, not at all. The stored value is the only record of whatever wrote it, and at
 *     least one such row (see the header) was NOT written by `buildMonthlyArchive`. Overwriting it
 *     would destroy the evidence that an unidentified writer exists.
 *  2. Provenance is only added alongside an archived `officialUptime` — the builder gates the two
 *     together (a withheld figure gets no source), so a dangling `platform_avg` beside a null uptime
 *     would claim a measurement the archive does not carry.
 *  3. A NON-Better-Stack service missing the key is left alone, not backfilled to 'official'. The
 *     generator's fallback already renders it 'Official', so the label is unaffected — and a
 *     half-annotated archive (some rows explicit, some inferred) is a worse record than a uniformly
 *     pre-fix one. Same call #1210 made about `countedIncidents`.
 *
 *  `driftIds` cuts ACROSS rules 2 and 3, which is why it is checked before either: a service whose
 *  Better Stack config changed at or after the month may have been a member then and not now, OR the
 *  reverse. Today's roster is silent in BOTH directions, so membership is the one thing that cannot be
 *  inferred for it — it is reported and skipped, never guessed.
 */
export function planPatch(archive, betterStackIds, driftIds = []) {
  const bs = new Set(betterStackIds)
  const drifted = new Set(driftIds)
  const changes = [], skips = []

  for (const [id, s] of Object.entries(archive.services ?? {})) {
    if (s.uptimeSource !== undefined) {
      // Worth printing even when it agrees: a stored value that DISAGREES with today's config is the
      // migration signal, and it must be visible rather than silently honoured.
      const agrees = bs.has(id) === (s.uptimeSource === 'platform_avg')
      skips.push(`${id}: already has uptimeSource='${s.uptimeSource}'${agrees ? '' : ` (today's config says ${bs.has(id) ? 'Better Stack' : 'not Better Stack'} — a source migration; the ARCHIVED value stands)`}`)
      continue
    }
    const hasFigure = s.officialUptime !== null && s.officialUptime !== undefined
    if (!hasFigure) {
      // Rule 2. Only worth a line for a service we'd otherwise have patched; every other no-uptime
      // service is rule 3's business and stays silent.
      if (bs.has(id)) skips.push(`${id}: Better Stack but officialUptime is ${JSON.stringify(s.officialUptime)} — the builder withheld the figure, so its provenance stays absent too`)
      continue
    }
    if (drifted.has(id)) {
      skips.push(`${id}: its Better Stack config CHANGED at or after this month (today's roster says ${bs.has(id) ? 'member' : 'NOT a member'}), so today's config cannot say what it was during the month, in either direction — left as-is; patch it by hand if you establish what it was`)
      continue
    }
    if (!bs.has(id)) continue // rule 3 — not ours to annotate
    changes.push({ id, officialUptime: s.officialUptime, after: 'platform_avg' })
  }
  return { changes, skips }
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

/** `-G`, not `-S`. The pickaxe (`-S`) reports only commits that change the NUMBER of occurrences, so a
 *  single commit that moves one service off Better Stack and another on is net-zero and invisible —
 *  which is precisely the wrong-provenance write this guard exists to stop (the newly-joined service is
 *  in today's roster, was not a member during the month, and would be stamped `platform_avg`). `-G`
 *  matches any commit whose diff touches the string, so a harmless URL edit also excludes that service
 *  from the plan — cheap, now that the consequence is one skipped row rather than a failed run. */
function driftCommits(sinceISO) {
  try {
    const out = execFileSync('git', ['log', `--since=${sinceISO}`, '--format=%h %s', '-G', 'betterStackUrl', '--', 'worker/src/services.ts'], { encoding: 'utf8' })
    return out.split('\n').filter(Boolean).flatMap((l) => {
      const i = l.indexOf(' ')
      // `%h %s` always has one; a spaceless line would slice to a truncated sha and a bogus subject.
      return i === -1 ? [] : [{ sha: l.slice(0, i), subject: l.slice(i + 1) }]
    })
  } catch (err) {
    console.error(`git log failed: ${String(err.stderr ?? err.message).slice(0, 300)}`)
    process.exit(1)
  }
}

/** Service ids whose config line a drift commit actually touched — `planPatch` excludes these from the
 *  plan. Over-inclusive by design: a commit that reformats the file yields extra ids, costing only some
 *  unpatched rows. Failing to READ a commit is the opposite — it would silently shrink the excluded set
 *  and let a service be patched on a roster that may not describe it — so that stops the run. */
function driftServiceIds(commits) {
  const ids = new Set()
  for (const c of commits) {
    let diff
    try {
      diff = execFileSync('git', ['show', c.sha, '--format=', '-U0', '--', 'worker/src/services.ts'], { encoding: 'utf8' })
    } catch (err) {
      console.error(`git show ${c.sha} failed: ${String(err.stderr ?? err.message).slice(0, 300)}`)
      process.exit(1)
    }
    for (const line of diff.split('\n')) {
      if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue
      const m = /\bid:\s*'([^']+)'/.exec(line)
      if (m) ids.add(m[1])
    }
  }
  return [...ids]
}

function main(argv) {
  const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1] }
  const period = flag('--period')
  if (!/^\d{4}-\d{2}$/.test(period ?? '')) {
    console.error('usage: patch-archive-uptimesource.mjs --period YYYY-MM')
    process.exit(2)
  }
  const key = `archive:monthly:${period}`

  let servicesSrc
  try {
    servicesSrc = readFileSync(resolve('worker/src/services.ts'), 'utf8')
  } catch (err) {
    console.error(`cannot read worker/src/services.ts from ${process.cwd()} — run this from the repo root (the git pathspecs below assume it too): ${err.message}`)
    process.exit(1)
  }
  const betterStackIds = betterStackIdsFrom(servicesSrc)
  if (!betterStackIds.length) {
    console.error('parsed 0 Better Stack services from worker/src/services.ts — the config shape changed; refusing rather than patching nothing')
    process.exit(1)
  }
  console.log(`Better Stack roster (today, from services.ts): ${betterStackIds.join(', ')}\n`)

  // Config drift is the one thing the config cannot tell us about itself: `betterStackIdsFrom` reads
  // TODAY's roster, and a service that joined or left in the meantime makes that answer wrong for the
  // month. Rather than gate the run behind an acknowledgement flag, the affected services are simply
  // excluded from the plan and reported — the operator sees the commits AND the rows, and the services
  // whose membership never moved still get patched.
  const drift = driftCommits(`${period}-01`)
  const driftIds = driftServiceIds(drift)
  if (drift.length) {
    console.log(`Better Stack config changed since ${period}-01 — today's roster may not describe ${period}:`)
    for (const c of drift) console.log(`  ${c.sha}  ${c.subject}`)
    console.log(`Services these commits touch are EXCLUDED from the plan below: ${driftIds.join(', ') || '(none)'}\n`)
  }

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

  const { changes, skips } = planPatch(archive, betterStackIds, driftIds)
  for (const s of skips) console.log(`SKIP: ${s}`)
  if (skips.length) console.log('')

  for (const c of changes) {
    console.log(`${c.id} — officialUptime ${c.officialUptime} (unchanged), uptimeSource: (absent) → '${c.after}'`)
  }
  console.log(`\nplanned: ${changes.length} patched · ${skips.length} skipped (left exactly as they are)`)

  if (!changes.length) {
    console.log('Nothing to patch.')
    process.exit(0)
  }

  // Same division as patch-archive-automonitor.mjs (#1210): the decision layer above is pure and
  // CI-gated by `npm run test:scripts`; the irreversible write to a permanent, no-TTL key stays with
  // the operator, whose backup and diff are their own.
  const outDir = process.env.ARCHIVE_PATCH_DIR ?? '.'
  const out = resolve(outDir, `${key.replace(/:/g, '_')}.patched.json`)
  for (const c of changes) archive.services[c.id].uptimeSource = c.after
  writeFileSync(out, JSON.stringify(archive))

  const wrangler = `--config worker/wrangler.toml --namespace-id ${NAMESPACE_ID} --remote`
  console.log(`\nPatched document written to: ${out}`)
  console.log(`\nTo apply, run these yourself (nothing above touched KV):`)
  console.log(`  1. back up:  npx wrangler kv key get ${key} ${wrangler} > ${resolve(outDir, 'archive-before.json')}`)
  console.log(`  2. inspect:  diff <(python3 -m json.tool ${resolve(outDir, 'archive-before.json')}) <(python3 -m json.tool ${out})`)
  console.log(`  3. apply:    npx wrangler kv key put ${key} --path ${out} ${wrangler}`)
  console.log(`  4. verify:   npx wrangler kv key get ${key} ${wrangler} | diff - ${out} && echo OK`)
  console.log(`\nStep 2 must show ONLY added "uptimeSource" keys on the ${changes.length} service(s) above.`)
  process.exit(0)
}

if (process.argv[1] && process.argv[1].endsWith('patch-archive-uptimesource.mjs')) {
  main(process.argv.slice(2))
}
