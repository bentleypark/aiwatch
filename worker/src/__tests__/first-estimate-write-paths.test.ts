import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// #1003 — source-scan invariant, in the repo's sync-test idiom (feed-slug-sync / api-tier-sync).
//
// The bug this PR fixes was not in a helper — it was in ONE of the write paths to
// `ai:analysis:{svcId}:{incId}`: the re-analysis overwrite replaced the original recovery estimate
// with a hindsight-inflated one, and resolution then graded the incident against that. The helpers
// are unit-tested, but a NEW write path added later that forgets to pin the baseline would silently
// reintroduce the bug with every other test still green — the "fix the called path, not the tested
// twin" failure mode.
//
// So `putAnalysis` is the single chokepoint, and this test enforces it structurally: an analysis-key
// write anywhere else fails CI. Unlike counting the *safe* construct (which only fires when an author
// already did the right thing), this fires on the *unsafe* one.

const SRC = join(__dirname, '..')
const read = (f: string) => readFileSync(join(SRC, f), 'utf8')

/** A KV write keyed by `key`, in every form the codebase can express one:
 *    kvPut(kv, <key>, …)   kv.put(<key>, …)   env.STATUS_CACHE.put(<key>, …)
 *  NOTE: no lookbehind excluding `kv` — `kv.put(...)` is the single most likely shape for a new
 *  write inside ai-analysis.ts (where the binding IS named `kv`), so excluding it would blind the
 *  guard to the very regression it exists to catch. */
const KV_WRITE = (key: string) =>
  new RegExp(String.raw`(?:kvPut\(\s*[\w.!]+\s*,\s*${key}\s*,|\.put\(\s*${key}\s*,)`)

/** The analysis KV key, however it is spelled: the `analysisKey()` helper or a raw template literal. */
const ANALYSIS_KEY = String.raw`(?:analysisKey\([^)]*\)|\`ai:analysis:[^\`]*\`)`

/**
 * Every KV write to an analysis key in one file, in both forms it can take:
 *   a) inline    — `kvPut(kv, analysisKey(a, b), …)` / `kv.put(\`ai:analysis:${'$'}{a}:${'$'}{b}\`, …)`
 *   b) via a var — `const k = analysisKey(a, b)` … `kvPut(kv, k, …)`
 * For (b) the search is scoped to the assignment's own block (by indentation), so an unrelated `key`
 * variable in another function can't false-positive.
 */
function analysisKeyWrites(src: string): string[] {
  const hits: string[] = []
  const lines = src.split('\n')

  // Inline form, matched on the source with line breaks collapsed — a write wrapped across lines
  // (`kvPut(\n  kv, analysisKey(a, b), …)`) is still a write, and a line-by-line scan would miss it.
  const flat = src.replace(/\s*\n\s*/g, ' ')
  const inline = flat.match(new RegExp(KV_WRITE(ANALYSIS_KEY).source, 'g')) ?? []
  hits.push(...inline.map(m => `inline: ${m.trim()}`))

  lines.forEach((line, i) => {

    const assign = line.match(/^(\s*)const (\w+) = (?:analysisKey\(|`ai:analysis:)/)
    if (!assign) return
    const [, indent, name] = assign
    for (let j = i + 1; j < lines.length; j++) {
      const cur = lines[j]
      if (cur.trim() === '') continue
      const curIndent = cur.match(/^\s*/)![0].length
      if (curIndent < indent.length) break // left the block the variable lives in
      if (KV_WRITE(name).test(cur)) hits.push(`L${j + 1}: ${cur.trim()}`)
    }
  })
  return hits
}

/** Every worker source module, recursively (a NEW module — including one under `parsers/` — is exactly
 *  how this invariant would get bypassed). Tests themselves are excluded. */
function workerModules(dir = SRC, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.isDirectory()) return e.name === '__tests__' ? [] : workerModules(join(dir, e.name), `${prefix}${e.name}/`)
    return e.name.endsWith('.ts') ? [`${prefix}${e.name}`] : []
  })
}

describe('#1003 — ai:analysis writes are funnelled through putAnalysis', () => {
  // A source-scan guard is worthless if it can't actually see a violation, so prove it on synthetic
  // sources before trusting it on the real ones. Every bypass shape must be caught.
  it('the scanner detects every form of a direct analysis-key write', () => {
    const bypasses = [
      // inline, via the kvPut helper
      'await kvPut(kv, analysisKey(svc.id, inc.id), JSON.stringify(result), { expirationTtl: 3600 })',
      // inline, straight on the binding — the likeliest shape for a new write in ai-analysis.ts
      'await kv.put(analysisKey(svc.id, inc.id), JSON.stringify(result), { expirationTtl: 3600 })',
      'await env.STATUS_CACHE.put(analysisKey(svc.id, inc.id), JSON.stringify(result), { expirationTtl: 3600 })',
      // a raw template literal, sidestepping the analysisKey() helper entirely
      'await kvPut(kv, `ai:analysis:${svc.id}:${inc.id}`, JSON.stringify(result), { expirationTtl: 3600 })',
    ]
    for (const line of bypasses) {
      expect(analysisKeyWrites(`async function f(kv, env, svc, inc, result) {\n  ${line}\n}`), line).toHaveLength(1)
    }
    // …and via a variable, in both spellings
    const viaVar = `
      async function f(kv, svc, inc, result) {
        const k = analysisKey(svc.id, inc.id)
        await kv.put(k, JSON.stringify(result), { expirationTtl: 3600 })
      }`
    expect(analysisKeyWrites(viaVar)).toHaveLength(1)

    // …and wrapped across lines, which a line-by-line scan would sail straight past
    const wrapped = `
      async function f(kv, svc, inc, result) {
        await kvPut(
          kv,
          analysisKey(svc.id, inc.id),
          JSON.stringify(result),
          { expirationTtl: 3600 },
        )
      }`
    expect(analysisKeyWrites(wrapped).length).toBeGreaterThan(0)
  })

  it('the scanner does not flag an unrelated key variable in another block', () => {
    const clean = `
      async function a(kv, svc, inc) {
        const key = analysisKey(svc.id, inc.id)
        const raw = await kv.get(key)
        return raw
      }
      async function b(kv) {
        const key = 'cooldown:x'
        await kvPut(kv, key, '1', { expirationTtl: 300 })
      }`
    expect(analysisKeyWrites(clean)).toEqual([])
  })

  it('no module writes an analysis key directly — putAnalysis is the only door', () => {
    // Sweeps EVERY worker module, so a brand-new one can't quietly add an unpinned write.
    for (const file of workerModules()) {
      const offenders = analysisKeyWrites(read(file))
      // ai-analysis.ts's ONE legitimate analysis-key write is the one inside `putAnalysis` itself.
      const allowed = file === 'ai-analysis.ts' ? 1 : 0
      expect(
        offenders.length,
        `${file} writes an analysis key outside putAnalysis:\n  ${offenders.join('\n  ')}\n`
        + 'That path would drop the #1003 scoring baseline — route it through putAnalysis.',
      ).toBe(allowed)
    }
  })

  it('a raw model result is never serialized into KV', () => {
    // `attempt.result` is the raw model output; persisting it directly is how the baseline gets
    // overwritten. It must reach KV only as putAnalysis's `analysis` argument.
    for (const file of ['ai-analysis.ts', 'index.ts']) {
      expect(read(file), `${file} serializes a raw model result into KV — pass it to putAnalysis instead`)
        .not.toMatch(/JSON\.stringify\(\s*attempt\.result\s*\)/)
    }
  })

  it('the /feed projection carries the baseline field', () => {
    // index.ts rebuilds `RssAiAnalysis` field-by-field (unlike the /api/status paths, which push the
    // parsed analysis wholesale) — so a dropped field here silently un-scores the Slack feed.
    expect(read('index.ts')).toMatch(/firstEstimatedRecoveryHours: a\.firstEstimatedRecoveryHours/)
  })

  it('the SPA and Edge mirrors of the scoring baseline exist and prefer the first estimate', () => {
    // Three codebases score predicted-vs-actual off the same data; each needs its own baseline helper.
    // Pin their existence so a rewrite that reverts one to the current estimate has to delete an
    // assertion to go green.
    expect(read('incident-history.ts')).toMatch(/export function scoringBaselineHours/)
    const spa = readFileSync(join(SRC, '../../src/utils/predictionAccuracy.js'), 'utf8')
    expect(spa).toMatch(/export function baselineHoursFrom/)
    expect(spa).toMatch(/firstEstimatedRecoveryHours/)
    const isDown = readFileSync(join(SRC, '../../api/_is-down/html-template.ts'), 'utf8')
    expect(isDown).toMatch(/function scoringBaselineEn/)
    expect(isDown).toMatch(/firstEstimatedRecoveryHours/)
  })
})
