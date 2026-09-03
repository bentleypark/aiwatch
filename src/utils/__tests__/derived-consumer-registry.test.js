// #1292 — every consumer of an incident's measured fields must be CLASSIFIED, not remembered.
//
// A `status_history`-derived incident is a new KIND of incident in a shared array: its timestamp is
// AIWatch's own anchor and its duration is a day's downtime, not a time to recover. Eight review
// rounds each found another consumer that assumed otherwise — and every one was the SECOND consumer
// on a path a previous round had just fixed (the RAG corpus guarded, the prompt fallback not; the SPA
// grouping guarded, the Edge grouping not; the average guarded, the total it shares a loop with
// broken). A hand-written list of guarded files reproduces that failure, because the files it omits
// are exactly the ones nobody thought of.
//
// So the LIST IS DERIVED: every file that reads an incident's measured fields or iterates `.incidents`
// must appear in one of the registries below. A new consumer fails CI until someone classifies it,
// which is the only shape of this check that would have caught rounds 5 through 8.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const ROOTS = ['worker/src', 'src', 'api']
// Any receiver, optional-chained or not. An earlier form named the receivers it expected
// (`incident|inc|i|e`) and so was blind to `rec.startedAt`, `a?.resolvedAt`, and every file under
// `src/hooks/` — the same shape of omission the registry exists to make impossible.
const CONSUMER = /\.incidents\b|\bincidents\s*[.[]|\??\.(?:duration|durationMin|startedAt|resolvedAt)\b/

/** Applies the rule: reads `derived` and changes behaviour. */
const APPLIERS = {
  'worker/src/score.ts': 'excludes from the MTTR sample AND the Recovery default (carriesRecoveryTime)',
  'worker/src/incident-history.ts': 'never enters the no-TTL RAG corpus (buildHistoryRecord returns null)',
  'worker/src/monthly-archive.ts': 'kept out of countedCount (the published "avg recovery"), kept in totalMinutes',
  'worker/src/archive-patch.ts': '#1295 — the tag is the removal key: only a `status_history` row can be a duplicate of a feed row, so it decides what leaves a frozen archive',
  'worker/src/rss.ts': 'never emitted as a /feed resolved item — it was never announced as active',
  'worker/src/ai-analysis.ts': 'excluded from findSimilarIncidents, the LLM recovery-estimate grounding',
  'worker/src/growth-series.ts': 'not counted as an incident START on the outage-day axis',
  'worker/src/alerts.ts': 'cannot silence a real degraded alert, nor caption a 🟢 Recovered',
  'worker/src/recovery-mark.ts': 'isMarkableOnStatusEdge refuses one, so no recovered: marker and no "Recently Resolved" banner',
  'worker/src/utils.ts': 'incidentDay — the one place the derived day is preferred over the anchor',
  'src/utils/recovery.js': 'excluded from the dashboard Recovery card',
  'src/utils/incidentSort.js': 'getContextualTime flags dayOnly so the anchor is never minute-precise',
  'src/utils/incidentGrouping.js': 'never flap-grouped (a group range carries no dayOnly)',
  'api/_is-down/html-template.ts': 'date precision + excluded from the "average recovery time" line',
  'api/_is-down/incident-grouping.ts': 'never flap-grouped — SSR mirror of the SPA rule',
  'api/is-down-group.ts': 'says "down Xh that day", not "resolved after Xh"',
}

/** Carries the tag across a boundary. Must not test it — must not DROP it. */
const FORWARDERS = {
  'worker/src/index.ts': 'persists on /api/v1/status/:id; skips permanently-absent KV probes on /feed',
  'src/utils/archiveMerge.js': 'archive entry → live incident shape',
}

/** Cannot be reached by a derived incident, or reads nothing it could get wrong. Each reason is a
 *  property of the CODE, not a recollection — if one stops holding, its file moves to APPLIERS. */
const SAFE = {
  // Producers — they build incidents from an upstream payload; a derived one never flows back in.
  'worker/src/parsers/betterstack.ts': 'PRODUCES them; the tag is stamped here',
  'worker/src/parsers/instatus.ts': 'producer — parses an upstream payload',
  'worker/src/parsers/onlineornot.ts': 'producer — parses an upstream payload',
  'worker/src/parsers/incident-io.ts': 'producer — parses an upstream payload',
  'worker/src/parsers/statuspage.ts': 'producer — parses an upstream payload',
  'worker/src/parsers/aws.ts': 'producer — parses an upstream payload',
  'worker/src/parsers/aistudio.ts': 'producer — parses an upstream payload',
  'worker/src/parsers/gcloud.ts': 'producer — parses an upstream payload',
  'worker/src/parsers/flashduty.ts': 'producer — parses an upstream payload',
  'worker/src/xai-regions.ts': 'xAI-only region collapsing; xAI is not a BetterStack service',
  'worker/src/services.ts': 'the orchestrator that CREATES them and computes the claim set',
  'worker/src/types.ts': 'declares the Incident shape, including the derived tag itself',

  // Active-only — every synthesized incident is `resolved` by construction (today is excluded).
  'worker/src/daily-summary.ts': 'reads only the first non-resolved incident',
  'worker/src/ext-claude.ts': 'projects ACTIVE incidents only',
  'worker/src/statusline.ts': 'reads the first non-resolved incident',
  'worker/src/fallback.ts': 'gates on non-resolved incidents',
  'worker/src/incident-text.ts': 'skips resolved — a cause must be live',
  'worker/src/upstream-link.ts': 'consumes incident-text.ts causal incidents, which skip resolved',
  'worker/src/platform-monitor.ts': 'active incidents only',
  'worker/src/report.ts': 'active incidents only',
  'src/utils/liveIncident.js': 'the shared "still carrying a live incident?" predicate',
  'src/utils/regionStatus.js': 'active incidents only',
  'src/utils/constants.js': 'active incidents only',
  'api/_is-down/region-status.ts': 'active incidents only',
  'api/is-down.ts': 'active-only for the verdict; the AI card joins incidents BY ID and a synthesized one is never analyzed, so it never matches',

  // Read a count, an id or a title — never a duration-as-recovery or a minute-precise timestamp.
  'worker/src/suppression.ts': 'matches by id/title to hide an entry',
  'worker/src/withdrawn.ts': 'tombstones keyed on the alerted:new marker, which synthesis never writes — so it can never be tombstoned',
  'worker/src/overrides.ts': 'operator-pinned durations keyed on an explicit incident id an operator typed; it corrects a duration, never reads one as a recovery time',
  'worker/src/alert-feed.ts': 'membership test by incident id against the alerted set; synthesis never alerts',
  'worker/src/upstream-feed.ts': 'non-carded upstream feeds; never sees a service incident list',
  'worker/src/withdrawal-log.ts': 'rows render from an incidents:withdrawn tombstone, which is keyed on the alerted:new marker synthesis never writes',
  'worker/src/probe-archival.ts': 'the incidentWindows param that would read a duration is passed by NO production caller (TODO #132) — wiring it means classifying this file again',
  'src/utils/predictionAccuracy.js': 'every entry point returns early without an ai:analysis, and a synthesized incident is never analyzed',
  'src/locales/en.js': 'a flat key→string copy map; the match is a dotted i18n KEY, not a field read',
  'src/locales/ko.js': 'a flat key→string copy map; the match is a dotted i18n KEY, not a field read',
  'api/_is-down/upstream-note.ts': 'renders UpstreamLink records built by upstream-link.ts, which sources causal incidents from incident-text.ts — resolved skipped',
  'worker/src/monthly-narrative.ts': 'names the divisor without asserting a cause for the excluded rows',
  'worker/src/weekly-briefing.ts': 'labels the figure "incident records", not events',
  'src/utils/calendar.js': 'dailyImpact drives the calendar for these services; day cells carry no time',
  'src/utils/recoveredGrouping.js': 'a rows EXISTENCE comes from the recovered: KV marker, and isMarkableOnStatusEdge (recovery-mark.ts) refuses to write one for a derived incident — so no row is ever built',
  'src/components/IncidentTimeline.jsx': 'renders the timeline it is given; the note prop covers the empty case',
  'src/components/AnalysisModal.jsx': 'renders an AI analysis, which a synthesized incident never has',
  'src/components/RecentUserReports.jsx': 'user-submitted reports, not provider incidents',
  'src/components/Sidebar.jsx': 'active incident count only',
  'src/components/Topbar.jsx': 'active incident count only',
  'src/components/SkeletonUI.jsx': 'loading placeholder — renders no real incident data',
  'src/pages/Settings.jsx': 'subscription toggles keyed on service id',
  'src/pages/Uptime.jsx': 'uptime figures, not incident measurements',
  'worker/src/parse-failure-log.ts': '#1234 — counts SOURCE-READ failures by reason; stores strings and integers and reads no incident field. Matches only through a doc mention of gcloud\'s incidents.json endpoint',
  'api/_is-down/seo-content.ts': 'static per-service SEO copy',
  'api/_methodology/html-template.ts': 'static prose describing the Score',

  // Guarded at the render layer, pinned separately by derived-date-precision-wiring.test.js.
  'src/pages/Incidents.jsx': 'passes dayOnly + the derived note; pinned by the precision-wiring scan',
  'src/pages/ServiceDetails.jsx': 'passes dayOnly + the derived note; pinned by the precision-wiring scan',
  'src/pages/Overview.jsx': 'passes dayOnly; pinned by the precision-wiring scan',
}

function consumers() {
  const found = []
  for (const root of ROOTS) {
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(rel); continue }
        if (!/\.(ts|js|jsx)$/.test(e.name) || e.name.includes('.test.')) continue
        if (CONSUMER.test(fs.readFileSync(path.join(ROOT, rel), 'utf-8'))) found.push(rel)
      }
    }
    walk(root)
  }
  return found.sort()
}

describe('#1292 — every incident-field consumer is classified', () => {
  const all = consumers()

  it('finds the consumers (the scan is not vacuous)', () => {
    // Pinned at the count the widened detector finds, not a loose floor: the failure this whole file
    // guards against is the SCAN going quiet, and a floor of 40 stays green while a narrowed regex
    // drops 30 files. A legitimate change moves this number in the same diff.
    expect(all.length, 'the detector drifted — it no longer matches what it did when this was pinned').toBe(72)
  })

  it('leaves none unclassified', () => {
    const known = new Set([...Object.keys(APPLIERS), ...Object.keys(FORWARDERS), ...Object.keys(SAFE)])
    const unclassified = all.filter((f) => !known.has(f))
    expect(unclassified,
      'a new consumer of incident measurements appeared. Classify it: does it apply the derived rule, ' +
      'forward the tag, or is it safe by construction? Rounds 5-8 of #1292 were all files nobody classified.',
    ).toEqual([])
  })

  it('lists no file that is no longer a consumer', () => {
    const stale = [...Object.keys(APPLIERS), ...Object.keys(FORWARDERS), ...Object.keys(SAFE)]
      .filter((f) => !all.includes(f))
    expect(stale, 'a registry entry no longer reads incident fields — remove it so the list stays honest').toEqual([])
  })

  it('gives every entry a reason', () => {
    for (const [file, why] of Object.entries({ ...APPLIERS, ...FORWARDERS, ...SAFE })) {
      expect(why.length, `${file} has no stated reason`).toBeGreaterThan(20)
    }
  })

  it('every APPLIER branches on the tag in CODE, not in a comment or a type', () => {
    // Round 10's version of this looked for the token `derived` and was satisfied by the file's own
    // `derived?: 'status_history'` interface DECLARATION — deleting two real guards left the suite
    // green. Round 12 found the replacement was WEAKER still: it matched `status_history|derivedDay`
    // anywhere in the file, so a doc comment satisfied it (worker/src/utils.ts, recovery-mark.ts and
    // index.ts each qualified on prose alone).
    //
    // So match a COMPARISON against the tag. A declaration (`derived?: 'status_history'`) has no
    // operator; a comment has no code. Strip line comments first so a commented-out guard cannot
    // stand in for a live one.
    const BRANCHES_ON_TAG = /derived\s*(===|!==|==|!=)\s*['"`]status_history['"`]|['"`]status_history['"`]\s*(===|!==|==|!=)\s*\w+\.derived|carriesRecoveryTime|isDailyRecordIncident|isMarkableOnStatusEdge|incidentDay/
    for (const file of Object.keys(APPLIERS)) {
      const code = fs.readFileSync(path.join(ROOT, file), 'utf-8')
        .replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')
      expect(code, `${file} is registered as applying the rule but never BRANCHES on the tag in code`)
        .toMatch(BRANCHES_ON_TAG)
    }
  })
})
