#!/usr/bin/env node
/**
 * #1295 — one-time prune: remove `status_history`-derived day-totals that were banked into
 * `incidents:monthly:{period}` on a day the accumulator ALREADY held a feed-published row for, from
 * the same resource.
 *
 * Why these exist: #1292's live claim-walk asks what the BetterStack feed says NOW, and BetterStack
 * removes its monitor items retroactively — so a day banked from RSS in early August read as
 * unspoken-for weeks later and got synthesized on top. Both rows are `resolved`, so
 * `prunePhantomIncidents` never touches either.
 *
 * The guard in `accumulateMonthlyIncidents` (`derivedDayAlreadyBankedFromFeed`) stops NEW ones. The
 * accumulator is additive, so it cannot remove what is already banked — hence this script, the same
 * shape #934/#940 needed.
 *
 * It removes only the SYNTHESIZED side of a collision. The feed row is what the provider published and
 * what every earlier month counted; the day-total is the redundant copy.
 *
 * It NEVER writes. Like `patch-archive-automonitor.mjs` (#1210), the decision layer here is pure and
 * CI-gated by `npm run test:scripts`, and the irreversible action is handed to the operator with the
 * exact commands — an I/O half is untestable and this key has no second copy.
 *
 *   node scripts/prune-monthly-derived-dupes.mjs --period 2026-08
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const NAMESPACE_ID = 'e49508d80bb144e9a7ff872f2be771a4' // STATUS_CACHE (worker/wrangler.toml)

/** The TTL `accumulateIncidentsOnlyIfChanged` writes this key with (`expirationTtl: 60 * 86400`).
 *  Pinned against the worker source by the test beside this file. */
export const ACCUMULATOR_TTL_SECONDS = 60 * 86400

const HALF_DAY_MS = 12 * 3_600_000

/**
 * MIRROR of `derivedDayAlreadyBankedFromFeed` (`worker/src/monthly-archive.ts`). A node script cannot
 * import the worker's TypeScript, so the rule is duplicated and pinned by the test beside this file —
 * the treatment `service-groups.ts` gets. Keep the two in lockstep: this decides what to DELETE from a
 * permanent record, so a rule that drifts wider than the worker's deletes rows the worker would keep.
 *
 * The window is `anchor ± 12h`: a derived entry's `startedAt` is local midnight plus twelve hours, so
 * on a 24-hour day that is exactly its local day, with no timezone lookup. It is NOT the local day
 * across a DST transition — see the worker copy for the bound. Matching is by ANCHORED resource name,
 * because the stored entry carries no resource field: only `derived`/`derivedDay` were added in #1292.
 */
export function collidesWithFeedRow(entries, derivedEntry, resource) {
  if (!resource) return false
  const anchor = Date.parse(derivedEntry.startedAt)
  if (Number.isNaN(anchor)) return false
  // ANCHORED, not containment — BetterStack resource names nest, and this half DELETES from a
  // permanent record, so it must never be wider than the worker's guard. Feed titles are written
  // `${component} — down|recovered`.
  const needle = resource.toLowerCase() + ' — '
  const dayStart = anchor - HALF_DAY_MS
  const dayEnd = anchor + HALF_DAY_MS
  return entries.some((e) => {
    if (e === derivedEntry || e.derived) return false
    const from = Date.parse(e.startedAt)
    if (Number.isNaN(from)) return false
    // The row's INTERVAL, not its start instant — a feed row can open before the local day and end
    // inside it. Unresolved rows collapse to their start.
    const to = Date.parse(e.resolvedAt ?? '')
    const until = Number.isNaN(to) ? from : Math.max(from, to)
    if (until < dayStart || from >= dayEnd) return false
    return (e.title ?? '').toLowerCase().startsWith(needle)
  })
}

/** The resource a synthesized row names. Its title is `"<resource> — recovered"`, written by
 *  `parseBetterStackDowntimeIncidents` from the resource's `public_name` — the one suffix this script
 *  strips, and only off rows it has already confirmed are `derived`. */
export function resourceOfDerived(entry) {
  const m = /^(.*) — recovered$/.exec(entry.title ?? '')
  return m ? m[1] : null
}

/**
 * Can this service's stored aggregates be re-derived from its stored list? If not, we cannot subtract
 * a row without inventing a number, so the service is refused rather than guessed at.
 *
 * `count`/`totalMinutes` deliberately keep counting entries the 200-row detail cap dropped
 * (`accumulateMonthlyIncidents`), so a truncated service is exactly the case this cannot verify.
 */
export function assertPrunable(id, svc) {
  const list = svc.incidents ?? []
  const ids = svc.incidentIds ?? []
  const durations = svc.durations ?? {}
  if (list.length !== ids.length) {
    return `${id}: detail list (${list.length}) != incidentIds (${ids.length}) — the row cap truncated it, so the aggregates cannot be re-derived`
  }
  if (svc.count !== ids.length) {
    return `${id}: count ${svc.count} != incidentIds ${ids.length}`
  }
  const sum = ids.reduce((n, i) => n + (durations[i] ?? 0), 0)
  if (svc.totalMinutes !== sum) {
    return `${id}: totalMinutes ${svc.totalMinutes} != sum(durations) ${sum}`
  }
  return null
}

/** Pure planner: which synthesized rows are redundant, and what the aggregates become without them. */
export function planPrune(doc) {
  const changes = []
  const refusals = []
  for (const [id, svc] of Object.entries(doc.services ?? {})) {
    const list = svc.incidents ?? []
    const dupes = list.filter((e) =>
      e.derived === 'status_history' && collidesWithFeedRow(list, e, resourceOfDerived(e)))
    if (dupes.length === 0) continue

    const refusal = assertPrunable(id, svc)
    if (refusal) { refusals.push(refusal); continue }

    const drop = new Set(dupes.map((e) => e.id))
    const kept = list.filter((e) => !drop.has(e.id))
    const keptIds = (svc.incidentIds ?? []).filter((i) => !drop.has(i))
    const durations = Object.fromEntries(
      Object.entries(svc.durations ?? {}).filter(([i]) => !drop.has(i)))
    changes.push({
      id,
      removed: [...drop],
      before: { count: svc.count, totalMinutes: svc.totalMinutes, longestMinutes: svc.longestMinutes },
      after: {
        count: keptIds.length,
        totalMinutes: keptIds.reduce((n, i) => n + (durations[i] ?? 0), 0),
        longestMinutes: Math.max(0, ...keptIds.map((i) => durations[i] ?? 0)),
      },
      kept,
      keptIds,
      durations,
      // Rebuilt from what survives — a date whose only row was a removed duplicate is no longer a date
      // this service had an incident on.
      dates: [...new Set(kept.map((e) => (e.derivedDay ?? (e.startedAt ?? '').slice(0, 10))))].sort(),
    })
  }
  return { changes, refusals }
}

/** Apply a plan to the document, in place. Separated from `planPrune` so the decision is inspectable
 *  before anything is mutated, and so the test can assert the two halves independently. */
export function applyPlan(doc, changes) {
  for (const c of changes) {
    const s = doc.services[c.id]
    s.count = c.after.count
    s.totalMinutes = c.after.totalMinutes
    s.longestMinutes = c.after.longestMinutes
    s.incidents = c.kept
    s.incidentIds = c.keptIds
    s.durations = c.durations
    s.dates = c.dates
  }
  return doc
}

/** `wrangler kv key get`, with the failure named. Lifted from `patch-archive-automonitor.mjs` (#1210). */
function kvRaw(key) {
  try {
    return execFileSync('npx', [
      'wrangler', 'kv', 'key', 'get', key,
      '--config', 'worker/wrangler.toml', '--namespace-id', NAMESPACE_ID, '--remote',
    ], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    console.error(`wrangler kv key get failed (exit ${err.status ?? '?'}): ${String(err.stderr ?? err.message).slice(0, 600)}`)
    process.exit(1)
  }
}

/** JSON.parse, with the payload named on failure. Lifted from the same precedent. */
function parseOrDie(raw, what) {
  try {
    return JSON.parse(raw)
  } catch {
    console.error(`${what} returned non-JSON (${raw.length} bytes). First 200 chars:\n${raw.slice(0, 200)}`)
    process.exit(1)
  }
}

/**
 * The four commands the operator runs, as data.
 *
 * Pure and exported because this is where every #1295 review round found a defect: a missing TTL, then
 * a flag that does not exist, then a backup filename shared with two other scripts. All three were
 * facts encoded in a printed string that no test could adjudicate, so each one
 * cost a review round to find and a round to re-break. The commands are now pinned by
 * `prune-monthly-derived-dupes.test.mjs`.
 *
 * `--ttl` (not `--expiration-ttl`, which wrangler's strict parser rejects) reproduces the
 * `expirationTtl: 60 * 86400` the worker writes this key with — a bare put would make a TTL'd key
 * permanent. The backup name is derived from the KV key because all three ops scripts default to the
 * same directory and the #1210 pair already own `archive-before.json`.
 */
export function applyCommands(key, outPath, outDir) {
  const wrangler = `--config worker/wrangler.toml --namespace-id ${NAMESPACE_ID} --remote`
  const backup = resolve(outDir, `${key.replace(/:/g, '-')}-before.json`)
  return [
    `  1. back up:  npx wrangler kv key get ${key} ${wrangler} > ${backup}`,
    `  2. inspect:  diff <(python3 -m json.tool ${backup}) <(python3 -m json.tool ${outPath})`,
    `  3. apply:    npx wrangler kv key put ${key} --path ${outPath} ${wrangler} --ttl ${ACCUMULATOR_TTL_SECONDS}`,
    `  4. verify:   npx wrangler kv key get ${key} ${wrangler} | diff - ${outPath} && echo OK`,
  ]
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const period = arg('--period')
  if (!period || !/^\d{4}-\d{2}$/.test(period)) {
    console.error('usage: node scripts/prune-monthly-derived-dupes.mjs --period YYYY-MM')
    process.exit(2)
  }
  const key = `incidents:monthly:${period}`
  // Read it here rather than taking a path: an operator-created dump of the production accumulator in
  // the repo root is not covered by any .gitignore pattern, and `--remote` is not optional — without
  // it wrangler reads the LOCAL Miniflare store and the plan comes out empty and plausible.
  //
  // Diagnostics follow `patch-archive-automonitor.mjs` (#1210): wrangler failures and non-JSON output
  // (a Cloudflare error page, an auth prompt, an empty read) must name themselves, because a bare
  // `SyntaxError` tells the operator nothing about a script that is about to overwrite a key with no
  // second copy. The shape check is this script's own addition: a payload that parses but carries no
  // `services` reports "Nothing to prune" and exits 0 — a plausible wrong answer, which is exactly what
  // a local-store read looks like.
  const doc = parseOrDie(kvRaw(key), `wrangler kv key get ${key}`)
  if (!doc || typeof doc !== 'object' || !doc.services || typeof doc.services !== 'object') {
    console.error(`${key} parsed but carries no \`services\` object — refusing to plan against it.`)
    console.error(`A LOCAL (non---remote) read looks exactly like this. Nothing written.`)
    process.exit(1)
  }
  const { changes, refusals } = planPrune(doc)

  for (const r of refusals) console.error(`REFUSED  ${r}`)
  if (refusals.length) {
    console.error(`\nREFUSING THE WHOLE RUN — ${refusals.length} service(s) could not be verified. Nothing written.`)
    process.exit(1)
  }
  if (!changes.length) {
    console.log('Nothing to prune.')
    process.exit(0)
  }
  for (const c of changes) {
    console.log(`${c.id}: -${c.removed.length} synthesized duplicate(s) | count ${c.before.count} → ${c.after.count} | downtime ${c.before.totalMinutes}m → ${c.after.totalMinutes}m`)
  }

  const outDir = process.env.ARCHIVE_PATCH_DIR ?? '.'
  const out = resolve(outDir, `${key.replace(/:/g, '-')}.patched.json`)
  writeFileSync(out, JSON.stringify(applyPlan(doc, changes)))

  console.log(`\nPatched document written to: ${out}`)
  console.log(`\nBEFORE APPLYING: deploy the guard first (\`npm run deploy:worker\`). Until it is live the`)
  console.log(`removed ids are absent from incidentIds while /api/status still carries those synthesized`)
  console.log(`incidents, so the next */5 cron re-banks every one of them within five minutes.`)
  console.log(`\nThis key has a CONCURRENT WRITER — accumulateIncidentsOnlyIfChanged rewrites it on the */5`)
  console.log(`cron whenever the incident payload changed, unlike the frozen archive:monthly key #1210`)
  console.log(`patches. Step 3 writes back a whole document planned from the snapshot above, so anything`)
  console.log(`the cron banked in between is reverted; re-run this script and apply promptly. For the same`)
  console.log(`reason step 4 can differ for benign reasons — read it as "did my rows go", not byte equality.`)
  console.log(`\nTo apply, run these yourself (nothing above touched KV):`)
  for (const line of applyCommands(key, out, outDir)) console.log(line)
  console.log(`\n\`--remote\` is not optional: without it wrangler writes the LOCAL Miniflare store and the`)
  console.log(`read-back still matches. Keep that -before.json until confirmed — this key is the ONLY copy`)
  console.log(`of the month's incident data until the archive is built on the 1st.`)
  process.exit(0)
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2))
