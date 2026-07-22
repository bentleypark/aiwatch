import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { URL as NodeURL, fileURLToPath } from 'node:url'
import { MOCK_SERVICES, MOCK_AI_ANALYSIS, MOCK_RECENTLY_RECOVERED, REF } from '../usePolling'
import { baselineHoursFrom, computePredictionOutcome } from '../../utils/predictionAccuracy'
import { parseDurationToMin } from '../../utils/recovery'
import en from '../../locales/en'

// The dashboard's dev fallback is THREE hand-maintained fixtures that reference each other by id:
// `MOCK_SERVICES[].incidents[].id` ← `MOCK_AI_ANALYSIS[svc][].incidentId` and ← `MOCK_RECENTLY_RECOVERED[svc][]`.
// Nothing checked those references, so a fixture could be internally impossible — an analysis for an
// incident that does not exist, a recovery marker on an incident that is still open, two fixtures on
// two different clocks — and the only symptom was a WRONG-LOOKING SCREEN. That is the worst possible
// failure mode for this file, because its entire job is to be the thing you look at when verifying a
// UI change: you cannot tell a product bug from a fixture ghost, and the person doing the
// verification ends up debugging the fixture instead of the feature.
//
// Where a rule restates logic the app already owns, it CALLS the app's function (`baselineHoursFrom`,
// `computePredictionOutcome`, `parseDurationToMin`) rather than re-deriving it. A reimplemented copy
// drifts from the real one, and then the lint rejects fixtures the UI renders perfectly well — which
// is the same class of false signal this file exists to remove, pointed the other way.

const svcById = new Map(MOCK_SERVICES.map((s) => [s.id, s]))
const incidentsOf = (svcId) => svcById.get(svcId)?.incidents ?? []
const findIncident = (svcId, incId) => incidentsOf(svcId).find((i) => i.id === incId)
const allAnalyses = Object.entries(MOCK_AI_ANALYSIS).flatMap(([svcId, arr]) => arr.map((a) => ({ svcId, a })))
// `monitoring` counts as finished: AnalysisModal's own `hasActiveInc` excludes it alongside
// `resolved`, so "mitigated, still monitoring, recovery marker written" is a state the UI supports.
const FINISHED = ['resolved', 'monitoring']

describe('the corpus these rules read is non-empty', () => {
  // Every rule below is a loop over the fixtures, so its PASSING STATE IS ITS DEFAULT: empty out the
  // fixture and the rule goes green while checking nothing. Measured — deleting the bodies of
  // MOCK_AI_ANALYSIS and MOCK_RECENTLY_RECOVERED left every other test in this file passing. This
  // block is what makes a green run mean "checked", so it must fail on exactly that mutation.
  it('MOCK_SERVICES carries services, and some of them carry incidents', () => {
    expect(MOCK_SERVICES.length).toBeGreaterThan(0)
    expect(MOCK_SERVICES.filter((s) => (s.incidents ?? []).length > 0).length).toBeGreaterThan(0)
  })

  it('MOCK_AI_ANALYSIS carries analyses, including a resolved one', () => {
    expect(allAnalyses.length).toBeGreaterThan(0)
    // The `resolvedAt` rules — grading, baseline, and "incident must be finished" — need a resolved
    // analysis to have anything to read.
    expect(allAnalyses.filter(({ a }) => a.resolvedAt).length).toBeGreaterThan(0)
  })

  it('MOCK_RECENTLY_RECOVERED carries markers', () => {
    expect(Object.values(MOCK_RECENTLY_RECOVERED).flat().length).toBeGreaterThan(0)
  })
})

describe('MOCK_SERVICES internal shape', () => {
  it('has no duplicate service ids', () => {
    const ids = MOCK_SERVICES.map((s) => s.id)
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
  })

  it('has no duplicate incident ids within a service', () => {
    for (const svc of MOCK_SERVICES) {
      const ids = (svc.incidents ?? []).map((i) => i.id)
      expect({ svc: svc.id, dupes: ids.filter((id, i) => ids.indexOf(id) !== i) }).toEqual({ svc: svc.id, dupes: [] })
    }
  })

  it('gives every incident a startedAt the UI can parse', () => {
    // `new Date(undefined)` is NaN, and `NaN >= cutoff` is false with no warning — so a NaN startedAt
    // drops a RESOLVED incident from ServiceDetails' 7-day Incident History window and from
    // `computeRecoveryStats`, with nothing logged either time. (An unresolved one still renders: the
    // filter is `status !== 'resolved' || startedAt >= cutoff`.)
    for (const svc of MOCK_SERVICES) {
      for (const inc of svc.incidents ?? []) {
        expect({ svc: svc.id, inc: inc.id, startedAt: Number.isFinite(new Date(inc.startedAt).getTime()) })
          .toEqual({ svc: svc.id, inc: inc.id, startedAt: true })
      }
    }
  })

  it('gives every incident a status the locale can render', () => {
    // Incidents.jsx renders `t('incidents.status.' + incident.status)` raw, so an unknown value paints
    // the untranslated i18n key on screen. The allowed set is derived from the locale map, not copied,
    // so adding a status there is all it takes to allow it here.
    const known = Object.keys(en).filter((k) => k.startsWith('incidents.status.')).map((k) => k.slice('incidents.status.'.length))
    expect(known.length).toBeGreaterThan(0)
    for (const svc of MOCK_SERVICES) {
      for (const inc of svc.incidents ?? []) {
        expect({ svc: svc.id, inc: inc.id, status: inc.status }).toEqual({ svc: svc.id, inc: inc.id, status: expect.stringMatching(new RegExp(`^(${known.join('|')})$`)) })
      }
    }
  })

  it('keeps every timeline in order and at or after the incident start', () => {
    for (const svc of MOCK_SERVICES) {
      for (const inc of svc.incidents ?? []) {
        const stamps = (inc.timeline ?? []).map((e) => new Date(e.at).getTime())
        const started = new Date(inc.startedAt).getTime()
        const ordered = stamps.every((t, i) => Number.isFinite(t) && t >= started && (i === 0 || t >= stamps[i - 1]))
        expect({ svc: svc.id, inc: inc.id, ordered }).toEqual({ svc: svc.id, inc: inc.id, ordered: true })
      }
    }
  })

  it('gives every resolved incident a resolution instant and a parseable duration', () => {
    // `getResolvedTime` reads `resolvedAt` and falls back to the terminal `stage: 'resolved'` timeline
    // entry; with neither it returns null and `getContextualTime` falls through to the incident's
    // START — so a resolved row shows a "Started" stamp where every sibling shows "Resolved". And
    // `computeRecoveryStats` filters on `parseDurationToMin(duration) > 0`,
    // whose regex REQUIRES a minutes segment — so a duration written `'1h'` parses to 0 and the
    // incident vanishes from the ServiceDetails Recovery card with nothing to show for it.
    for (const svc of MOCK_SERVICES) {
      for (const inc of (svc.incidents ?? []).filter((i) => i.status === 'resolved')) {
        const hasInstant = !!inc.resolvedAt || (inc.timeline ?? []).some((e) => e.stage === 'resolved')
        expect({ svc: svc.id, inc: inc.id, hasInstant, durationMin: parseDurationToMin(inc.duration) > 0 })
          .toEqual({ svc: svc.id, inc: inc.id, hasInstant: true, durationMin: true })
      }
    }
  })
})

describe('MOCK_AI_ANALYSIS references resolve', () => {
  it('keys a real service', () => {
    for (const svcId of Object.keys(MOCK_AI_ANALYSIS)) {
      expect({ svcId, known: svcById.has(svcId) }).toEqual({ svcId, known: true })
    }
  })

  it('points every incidentId at an incident that service actually carries', () => {
    // A cause of the defect this file was written for: `together`'s analysis referenced
    // `together-mock-1`, which existed in no service.
    for (const { svcId, a } of allAnalyses) {
      expect({ svcId, incidentId: a.incidentId, found: !!findIncident(svcId, a.incidentId) })
        .toEqual({ svcId, incidentId: a.incidentId, found: true })
    }
  })

  it('never reuses an incidentId within one service', () => {
    // AnalysisModal buckets by `incidentId` and `continue`s on a hit, so a second analysis carrying an
    // id already seen is DISCARDED — the modal's incident count silently drops and nothing errors.
    // The `the fixture source itself` scan cannot see this: these are array elements, not object keys.
    for (const [svcId, analyses] of Object.entries(MOCK_AI_ANALYSIS)) {
      const ids = analyses.map((a) => a.incidentId)
      expect({ svcId, dupes: ids.filter((id, i) => ids.indexOf(id) !== i) }).toEqual({ svcId, dupes: [] })
    }
  })

  it('never marks an analysis resolved while its incident is still in progress', () => {
    for (const { svcId, a } of allAnalyses.filter(({ a }) => a.resolvedAt)) {
      const inc = findIncident(svcId, a.incidentId)
      expect({ svcId, incidentId: a.incidentId, found: !!inc, finished: FINISHED.includes(inc?.status) })
        .toEqual({ svcId, incidentId: a.incidentId, found: true, finished: true })
    }
  })

  it('marks the analysis of a resolved incident as resolved too', () => {
    // The inverse, and a one-line edit away: flip an incident to `resolved` and forget its analysis,
    // and AnalysisModal keeps rendering the LIVE `Est. Recovery` line on a finished incident — plus,
    // once the service itself reads operational, the amber "부분 이슈 / Isolated issue" badge, whose
    // `isolatedModelIssue` condition includes `analyses.some(a => !a.resolvedAt)`.
    for (const { svcId, a } of allAnalyses) {
      const inc = findIncident(svcId, a.incidentId)
      if (inc?.status !== 'resolved') continue
      expect({ svcId, incidentId: a.incidentId, resolvedAt: !!a.resolvedAt }).toEqual({ svcId, incidentId: a.incidentId, resolvedAt: true })
    }
  })

  it('gives a resolved analysis a baseline the real grader accepts', () => {
    // Asks the REAL `baselineHoursFrom`, which falls back to parsing the `estimatedRecovery` display
    // string — so `'30m–1h'` with no numeric field is legitimately gradeable. A stricter local copy
    // (`firstEstimatedRecoveryHours ?? estimatedRecoveryHours`) would false-fail those. What it still
    // catches is the real defect: `estimatedRecovery: 'Resolved'` parses to 0 hours → null baseline →
    // `computePredictionOutcome` bails and the card degrades to the raw string.
    for (const { svcId, a } of allAnalyses.filter(({ a }) => a.resolvedAt)) {
      expect({ svcId, incidentId: a.incidentId, baseline: baselineHoursFrom(a) != null })
        .toEqual({ svcId, incidentId: a.incidentId, baseline: true })
    }
  })

  it('puts every timestamp of a grading pair on the live clock', () => {
    // The rule with the sharpest teeth. MOCK_SERVICES runs on two clocks — `ago` (frozen REF) and
    // `agoNow` (live) — and the app compares an analysis's timestamps against its incident's. Mix the
    // two and nothing errors: the card renders a wrong NUMBER, thousands of hours and climbing a day
    // per day, whether the incident is resolved or still open. Every reference-existence rule above
    // stays green through all of it.
    //
    // Checked on BOTH ends. Windowing only the incident leaves the mirror-image defect — a live-clock
    // incident with a REF-anchored `resolvedAt` — reachable, and it lands in the one place the
    // duration rule below cannot reach (an analysis whose incident declares no duration).
    const MAX_AGE_MIN = 30 * 24 * 60
    // The threshold only separates the clocks while REF is more than that far back; assert it rather
    // than assume it, so moving REF forward fails here instead of quietly emptying this rule.
    expect(Date.now() - REF.getTime()).toBeGreaterThan(MAX_AGE_MIN * 60_000)
    const live = (iso) => {
      const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
      return Number.isFinite(min) && min >= 0 && min < MAX_AGE_MIN
    }
    for (const { svcId, a } of allAnalyses) {
      const inc = findIncident(svcId, a.incidentId)
      const stamps = [inc?.startedAt, a.analyzedAt, a.resolvedAt].filter(Boolean)
      const ordered = !a.resolvedAt || new Date(a.resolvedAt).getTime() >= new Date(inc?.startedAt).getTime()
      expect({ svcId, incidentId: a.incidentId, liveClock: stamps.every(live), ordered })
        .toEqual({ svcId, incidentId: a.incidentId, liveClock: true, ordered: true })
    }
  })

  it('grades a resolved analysis to the duration its incident declares', () => {
    // The tighter half: given both ends on the live clock, the DERIVED actual must still match what
    // the incident says about itself, or the card contradicts the row above it.
    //
    // Only incidents that declare a duration can be checked this way, and only `resolved` ones are
    // required to (see the resolution-instant rule). A `monitoring` incident with an analysis is a
    // legitimate fixture state with `duration: null` — folding that into this rule would fail it under
    // a message about durations, which is the false-signal class this file exists to remove. Those
    // pairs are covered by the rule above, which windows every timestamp on both ends.
    for (const { svcId, a } of allAnalyses.filter(({ a }) => a.resolvedAt)) {
      const inc = findIncident(svcId, a.incidentId)
      const declaredMin = parseDurationToMin(inc?.duration)
      if (declaredMin === 0) continue
      const outcome = computePredictionOutcome(a, inc)
      // Generous tolerance: the point is to catch a contradiction, not to force the declared duration
      // and the derived one to agree to the minute.
      const agrees = !!outcome && Math.abs(outcome.actualMin - declaredMin) <= Math.max(10, declaredMin * 0.5)
      expect({ svcId, incidentId: a.incidentId, actualMin: outcome?.actualMin ?? null, declaredMin, agrees })
        .toEqual({ svcId, incidentId: a.incidentId, actualMin: outcome?.actualMin ?? null, declaredMin, agrees: true })
    }
  })
})

describe('MOCK_RECENTLY_RECOVERED references resolve', () => {
  it('keys a real service and names incidents that service carries', () => {
    for (const [svcId, incIds] of Object.entries(MOCK_RECENTLY_RECOVERED)) {
      expect({ svcId, known: svcById.has(svcId) }).toEqual({ svcId, known: true })
      for (const incId of incIds) {
        expect({ svcId, incId, found: !!findIncident(svcId, incId) }).toEqual({ svcId, incId, found: true })
      }
    }
  })

  it('never carries an empty marker list', () => {
    // Overview and ServiceDetails both gate the "Recovered" badge on `!!recentlyRecovered[svc.id]`,
    // and `!![]` is true — so emptying a service's list (the natural way to switch the state off while
    // keeping the key) leaves the badge lit with no row behind it.
    for (const [svcId, incIds] of Object.entries(MOCK_RECENTLY_RECOVERED)) {
      expect({ svcId, count: incIds.length > 0 }).toEqual({ svcId, count: true })
    }
  })

  it('never marks an incident recovered while it is still in progress', () => {
    // An incident cannot be simultaneously in progress and recently recovered. Crafting that state
    // puts a "Recently Resolved" banner above an "Investigating" row and reads as a product bug.
    for (const [svcId, incIds] of Object.entries(MOCK_RECENTLY_RECOVERED)) {
      for (const incId of incIds) {
        const status = findIncident(svcId, incId)?.status
        expect({ svcId, incId, status, finished: FINISHED.includes(status) }).toEqual({ svcId, incId, status, finished: true })
      }
    }
  })
})

describe('the fixture source itself', () => {
  // A duplicate key in an object literal is not a runtime error — the later one silently wins, so the
  // entry you just added disappears and the imported object looks perfectly fine. ESLint would catch
  // it via `no-dupe-keys`, but this repo's flat config never spreads `js.configs.recommended`, so that
  // rule is off (verified by linting a literal with a duplicate key: clean). Hence a source-text scan.
  //
  // Read relative to THIS module, not the cwd: `npm run test:src` happens to run from the repo root,
  // but an IDE or subdirectory runner does not, and the failure would be a confusing ENOENT.
  //
  // `NodeURL`, not the global `URL` — this is the footgun the rest of the comment exists for.
  // `import.meta.url` IS a `file:` URL here, but the config's `environment: 'happy-dom'` replaces
  // globalThis.URL with happy-dom's implementation, which resolves a relative reference against the
  // DOCUMENT base and throws the file: base away. Measured under this exact config:
  //   new URL('../usePolling.js', import.meta.url)     → 'http://localhost:3000/src/hooks/usePolling.js'
  //   new NodeURL('../usePolling.js', import.meta.url) → 'file:///…/src/hooks/usePolling.js'
  // The first makes readFileSync throw `The URL must be of scheme file`, and its http path happens to
  // look plausible, so the mistake reads as a path bug rather than an environment one.
  const source = readFileSync(fileURLToPath(new NodeURL('../usePolling.js', import.meta.url)), 'utf8')

  /**
   * Keys declared at the top level of an object literal, by brace-matching from its `{`.
   *
   * Matching on the `identifier:` SHAPE rather than on line indentation is what makes this work for a
   * one-line literal (`MOCK_RECENTLY_RECOVERED`) as well as a block one: an indent-anchored pattern
   * matches nothing at all on a single line, and "matches nothing" is indistinguishable from "found
   * no duplicates".
   *
   * Comments are skipped because an identifier in one reads as a key (`// Graded: …` → a `Graded`
   * key). Strings are skipped for a different reason — a `{` or `[` inside one would desync `depth`.
   */
  const topLevelKeys = (declaration) => {
    const start = source.indexOf(declaration)
    if (start === -1) throw new Error(`missing declaration: ${declaration}`)
    let depth = 0
    const keys = []
    for (let i = start + declaration.length - 1; i < source.length; i++) {
      const c = source[i]
      const two = source.slice(i, i + 2)
      if (two === '//') { i = source.indexOf('\n', i); if (i === -1) break; continue }
      if (two === '/*') { const end = source.indexOf('*/', i); if (end === -1) break; i = end + 1; continue }
      if (c === '"' || c === "'" || c === '`') {
        const quote = c
        const from = i + 1
        for (i++; i < source.length && source[i] !== quote; i++) if (source[i] === '\\') i++
        // A quoted key (`'some-key':`) is still a key. Without this its quotes are consumed as a
        // plain string and the key vanishes from the parse — reported as a missing key on valid JS.
        if (depth === 1 && /^\s*:/.test(source.slice(i + 1))) keys.push(source.slice(from, i))
        continue
      }
      if (c === '{' || c === '[') depth++
      else if (c === '}' || c === ']') { depth--; if (depth === 0) break }
      else if (depth === 1 && /[A-Za-z0-9_$]/.test(c)) { // depth 1 = directly inside this literal
        const rest = source.slice(i)
        const m = rest.match(/^([A-Za-z0-9_$]+)\s*:/)
        if (m) { keys.push(m[1]); i += m[0].length - 1 }
        else i += (rest.match(/^[A-Za-z0-9_$]+/) ?? [''])[0].length - 1
      }
    }
    return keys
  }

  it.each([
    ['export const MOCK_AI_ANALYSIS = {', MOCK_AI_ANALYSIS],
    ['export const MOCK_RECENTLY_RECOVERED = {', MOCK_RECENTLY_RECOVERED],
  ])('%s parses to exactly the keys the module exports', (declaration, imported) => {
    const keys = topLevelKeys(declaration)
    // Comparing the PARSED keys against the IMPORTED ones does both jobs at once: a duplicate key
    // makes the parsed list longer than the imported one, and a parse that matched nothing makes it
    // shorter. So the rule cannot go vacuous — an under-reporting scan fails rather than passing.
    expect(keys.slice().sort()).toEqual(Object.keys(imported).sort())
  })
})
