#!/usr/bin/env -S npx tsx
/**
 * #1295 — one-time patch: correct a FROZEN monthly archive whose incident figures were built from the
 * accumulator BEFORE the `status_history` duplicate guard shipped.
 *
 * `archive:monthly:2026-08` was built in the `00:00-00:15 UTC` window on the 1st, hours before the
 * guard deployed, so the duplicated rows froze into a permanent, TTL-less key. The accumulator has
 * since been pruned (`prune-monthly-derived-dupes.mjs`); this applies the same correction to the copy
 * the reports site publishes.
 *
 * **TypeScript, not `.mjs`, on purpose.** Every figure is produced by the functions that built the
 * archive — see `worker/src/archive-patch.ts`. A node-side mirror of `computeMonthlyScore` was the
 * first design and was abandoned: a drifting mirror would publish a wrong score into a permanent
 * record with nothing to catch it. The cost is that this runs under `tsx` rather than plain node.
 *
 * It NEVER writes KV. Like `patch-archive-automonitor.mjs` (#1210) it emits the patched document and
 * prints the commands the operator runs, so the one irreversible action stays in human hands.
 *
 *   npx tsx scripts/patch-archive-derived-dupes.ts --period 2026-08
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
// DEFAULT import, not named or namespace. The root package is `"type": "module"` while `worker/` has
// its own package.json with no `type`, so everything under it is CJS. From an ESM file here, a named
// import fails outright and a namespace import yields `{ default, 'module.exports' }` — the functions
// live on `default`, which is what a default import binds. Verified by inspecting the live shape, not
// assumed.
import archivePatch from '../worker/src/archive-patch'


/** `wrangler kv key get`, with the failure named. Same shape as `patch-archive-automonitor.mjs`. */
function kvRaw(key: string): string {
  try {
    return execFileSync('npx', [
      'wrangler', 'kv', 'key', 'get', key,
      '--config', 'worker/wrangler.toml', '--namespace-id', archivePatch.NAMESPACE_ID, '--remote',
    ], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    const e = err as { status?: number; stderr?: string; message?: string }
    console.error(`wrangler kv key get failed (exit ${e.status ?? '?'}): ${String(e.stderr ?? e.message).slice(0, 600)}`)
    process.exit(1)
  }
}

function parseOrDie(raw: string, what: string): Record<string, unknown> {
  try {
    return JSON.parse(raw)
  } catch {
    console.error(`${what} returned non-JSON (${raw.length} bytes). First 200 chars:\n${raw.slice(0, 200)}`)
    process.exit(1)
  }
}

function main(argv: string[]): void {
  const i = argv.indexOf('--period')
  const period = i >= 0 ? argv[i + 1] : undefined
  if (!period || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    console.error('usage: npx tsx scripts/patch-archive-derived-dupes.ts --period YYYY-MM')
    process.exit(2)
  }
  const key = `archive:monthly:${period}`
  const archive = parseOrDie(kvRaw(key), `wrangler kv key get ${key}`)
  if (!archive.services || typeof archive.services !== 'object') {
    console.error(`${key} parsed but carries no \`services\` object — refusing to plan against it.`)
    console.error('A LOCAL (non---remote) read looks exactly like this. Nothing written.')
    process.exit(1)
  }

  const { changes, refusals } = archivePatch.planArchivePatch(archive, archivePatch.monthWindow(period))
  for (const r of refusals) console.error(`REFUSED  ${r}`)
  if (refusals.length) {
    console.error(`\nREFUSING THE WHOLE RUN — ${refusals.length} service(s) could not be verified. Nothing written.`)
    process.exit(1)
  }
  if (!changes.length) {
    console.log('Nothing to patch.')
    process.exit(0)
  }
  for (const c of changes) {
    const moved = (Object.keys(c.before) as (keyof typeof c.before)[])
      .filter((k) => c.before[k] !== c.after[k])
      .map((k) => `${k} ${String(c.before[k])}→${String(c.after[k])}`)
    console.log(`${c.id}: -${c.removed.length} duplicate(s) | ${moved.join(' | ')}`)
  }

  const outDir = process.env.ARCHIVE_PATCH_DIR ?? '.'
  const out = resolve(outDir, `${key.replace(/:/g, '-')}.patched.json`)
  const backup = resolve(outDir, `${key.replace(/:/g, '-')}-before.json`)
  writeFileSync(out, JSON.stringify(archivePatch.applyArchivePatch(archive, changes)))

  console.log(`\nPatched document written to: ${out}`)
  console.log('\nThe archive also carries a `narrative` generated from the PRE-patch figures:')
  console.log('`monthly-narrative.ts` builds its Observations from `incidents` / `countedIncidents` /')
  console.log('`avgResolutionMin`, and the reports site consumes it as an operator-reviewed draft. This')
  console.log('patch does not touch it — re-read it, or null it, before publishing the month.')
  console.log('\nThis key is PERMANENT and has no TTL — the apply command below deliberately sets none.')
  console.log('`--remote` is not optional: without it wrangler writes the LOCAL Miniflare store and')
  console.log('the read-back still matches.')
  console.log('\nTo apply, run these yourself (nothing above touched KV):')
  for (const line of archivePatch.applyCommands(key, out, backup)) console.log(line)
  process.exit(0)
}

// No main-module guard. Nothing imports this file — it is only ever executed — so a guard buys
// nothing and is pure failure surface: two rounds of it shipped a silent exit-0 (a path with a space,
// then a symlinked parent), and a silent exit-0 here leaves a STALE `.patched.json` on disk that the
// operator's step 3 would apply to a permanent key.
main(process.argv.slice(2))
