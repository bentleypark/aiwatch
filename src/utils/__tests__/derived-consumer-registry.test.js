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
//
// #1384 — a SECOND axis, same file list, same mechanism. `retainedBridge` (services.ts
// `mergeRetainedIncidentHistory`) marks an incident forwarded from AIWatch's own prior collection
// under a retiring status-page source, during a finite migration bridge — real timestamps, unlike
// `status_history`'s synthetic anchor, but NOT evidence about what the CURRENT source is reporting
// right now. Nine consecutive PR review rounds (4 through 9 of #1384) each found one more consumer
// that treated a stale bridged ghost as fresh/current — a false "New Incident" push, a false public
// withdrawal, a re-lit "Recently Resolved" banner, a permanently-blocked fallback recommendation —
// before this registry existed to make the search exhaustive instead of round-by-round. The
// `status_history` axis above is a DIFFERENT question (precision: is this timestamp exact, or a
// day-bucket?) from this one (freshness: is this incident evidence about THIS cycle's source?) — a
// file can be classified differently on each axis, and most are, which is why this is a second set of
// registries over the SAME file list rather than a shared one.
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
  'src/utils/calendar.js': 'incidentLocalDay uses derivedDay (noon-UTC anchor), never the synthetic startedAt, when painting a status_history incident onto the calendar (#1400)',
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
  'worker/src/parsers/rootly.ts': 'producer — parses an upstream payload (#1381)',
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

// ── #1384 retainedBridge axis — same file list, different question (see header) ──────────────────

/** Applies the rule: excludes a `retainedBridge` incident from a "fresh/current/should-I-act-on-this"
 *  judgment, while still letting DISPLAY/SCORE surfaces show it normally (that is the bridge's whole
 *  point — KNOWN LIMIT 1 in services.ts). Each entry names which round of #1384 review found it. */
const RB_APPLIERS = {
  'worker/src/monthly-archive.ts': 'prunePhantomIncidents: counted in liveIds (guard 2, protects its OWN row) but excluded from oldestLiveStart (guard 3, cannot vouch for OTHER rows) — round 4 then round 5',
  'worker/src/ai-analysis.ts': 'refreshOrReanalyze excludes it from the active-incident set — no recurring re-analysis on a frozen snapshot — round 6',
  'worker/src/rss.ts': 'buildFeedWithMeta never emits it as an active RSS/Slack item — round 6',
  'worker/src/alerts.ts': 'buildIncidentAlerts excludes it from the NEW-incident trigger only, not the RESOLVED branch — round 7',
  'worker/src/report.ts': 'reportWindowFloor excludes it from the Math.min earliest-active-start computation — round 8',
  'worker/src/withdrawn.ts': 'withdrawalHold excludes it from its "incident running" check — round 9',
  'worker/src/recovery-mark.ts': 'isMarkableOnStatusEdge refuses one — no re-lit "Recently Resolved" banner on every unrelated recovery — round 9 (structural pass)',
  'worker/src/fallback.ts': 'hasActiveIncident excludes it — a stale ghost cannot permanently block a fallback recommendation — round 9 (structural pass)',
  'worker/src/ext-claude.ts': 'activeIncidents excludes it from the popup\'s "current issue" list — round 9 (structural pass)',
  'worker/src/incident-text.ts': 'causalIncidents excludes it — a stale ghost cannot lend its text to an upstream-attribution claim about right now — round 9 (structural pass)',
  'api/is-down.ts': 'the inline Alternatives fallback-candidate filter excludes it — the Edge\'s own copy of fallback.ts\'s check — round 9 (structural pass)',
}

/** Carries the tag across a boundary. Must not test it — must not DROP it, where dropping would hide
 *  the incident from a surface that legitimately wants to keep showing it (display/score). */
const RB_FORWARDERS = {
  'worker/src/index.ts': '/api/status serializes the whole Incident (including the tag) for SPA/is-down display — the accepted KNOWN LIMIT 1 surface; the judgment call sites this file feeds already route through the now-fixed functions above',
  'src/utils/archiveMerge.js': 'archive entry → live incident shape — moot in practice: a MonthlyIncidentEntry (the archive shape) never carries the tag in the first place (see the SAFE reason on archive-patch.ts below), so there is nothing to forward or drop',
}

/** Cannot make a wrong "is this fresh" judgment, or reads nothing it could get wrong. Each reason is
 *  a property of the CODE, not a recollection — if one stops holding, its file moves to RB_APPLIERS. */
const RB_SAFE = {
  // Producers + the creator/declarer — retainedBridge is stamped ONLY inside
  // mergeRetainedIncidentHistory (services.ts); no parser ever produces it, and xAI has no migration bridge.
  'worker/src/parsers/betterstack.ts': 'producer — parses an upstream payload, never stamps retainedBridge',
  'worker/src/parsers/instatus.ts': 'producer — parses an upstream payload, never stamps retainedBridge',
  'worker/src/parsers/onlineornot.ts': 'producer — parses an upstream payload, never stamps retainedBridge',
  'worker/src/parsers/incident-io.ts': 'producer — parses an upstream payload, never stamps retainedBridge',
  'worker/src/parsers/statuspage.ts': 'producer — parses an upstream payload, never stamps retainedBridge',
  'worker/src/parsers/aws.ts': 'producer — parses an upstream payload, never stamps retainedBridge',
  'worker/src/parsers/aistudio.ts': 'producer — parses an upstream payload, never stamps retainedBridge',
  'worker/src/parsers/gcloud.ts': 'producer — parses an upstream payload, never stamps retainedBridge',
  'worker/src/parsers/flashduty.ts': 'producer — parses an upstream payload, never stamps retainedBridge',
  'worker/src/parsers/rootly.ts': 'producer — parses an upstream payload, never stamps retainedBridge',
  'worker/src/xai-regions.ts': 'xAI-only region collapsing; xAI has no migration bridge configured',
  'worker/src/services.ts': 'the orchestrator that STAMPS the tag in mergeRetainedIncidentHistory — the source of truth, not a consumer of it',
  'worker/src/types.ts': 'declares the Incident shape, including the retainedBridge tag itself',

  // Durable-archive consumers — MonthlyIncidentEntry/MonthlyIncidents never carry the tag: the write
  // path (monthly-archive.ts accumulateMonthlyIncidents) constructs the stored record via an explicit
  // field allowlist that does not include it, and the type declares no such field. Nothing to forward.
  'worker/src/archive-patch.ts': 'operates on the durable MonthlyIncidentEntry shape, which never carries retainedBridge (field-allowlist write in monthly-archive.ts)',
  'worker/src/growth-series.ts': 'operates on the durable MonthlyIncidents shape, which never carries retainedBridge (same field-allowlist reason)',
  'worker/src/monthly-narrative.ts': 'svc.incidents here is a COUNT (a number), not the live array — durable report data',
  'worker/src/weekly-briefing.ts': 'parseMonthlyIncidents reads the durable MonthlyIncidentEntry[] shape, which never carries retainedBridge',

  // Display/Score surfaces where showing a retainedBridge incident IS the intended behavior — KNOWN
  // LIMIT 1 (services.ts) documents this as the accepted trade, not an oversight.
  'worker/src/score.ts': 'intentionally SCORES it — the bridge exists specifically to keep contributing it to the rolling window (KNOWN LIMIT 1)',
  'worker/src/daily-summary.ts': 'reads the first non-resolved incident for DISPLAY in the daily Discord summary — showing it as ongoing is the accepted trade, not a freshness bug (verified live, round 7/8 sweeps)',
  'worker/src/statusline.ts': 'reads the first non-resolved incident for DISPLAY on the CLI status line — same accepted trade as daily-summary.ts',
  'src/utils/liveIncident.js': 'the shared SPA "still carrying a live incident?" display predicate — no push/alert capability lives in the frontend',
  'src/utils/regionStatus.js': 'active-incidents-only DISPLAY helper — matches the accepted KNOWN LIMIT 1 trade',
  'src/utils/constants.js': 'active-incidents-only DISPLAY helper — matches the accepted KNOWN LIMIT 1 trade',
  'api/_is-down/region-status.ts': 'Edge SSR mirror of regionStatus.js — same DISPLAY reasoning',
  'src/components/Sidebar.jsx': 'active incident COUNT for display only — showing it counted is the accepted trade',
  'src/components/Topbar.jsx': 'active incident COUNT for display only — showing it counted is the accepted trade',
  'src/utils/calendar.js': 'real, exact timestamps paint the correct calendar day already — displaying it is the accepted trade, not a freshness concern',
  'worker/src/utils.ts': 'incidentDay prefers derivedDay only for status_history — a retainedBridge incident has a real startedAt, so ordinary day-bucketing is already correct',

  // Precision-only concern (status_history axis), unrelated to freshness — a retainedBridge incident
  // carries a REAL, exact timestamp, so these files' existing dayOnly/precision logic already treats
  // it correctly as an ordinary incident; there is no freshness judgment in any of them to guard.
  'src/utils/recovery.js': 'excludes status_history by derived tag only — a retainedBridge incident has a real recovery time and is correctly included',
  'src/utils/incidentSort.js': 'dayOnly / same-day-order logic keys on derived === status_history only — a real timestamp needs no such handling',
  'src/utils/incidentGrouping.js': 'flap-grouping precision logic keys on derived === status_history only — a real timestamp needs no such handling',
  'api/_is-down/html-template.ts': 'isDailyRecordIncident keys on derived === status_history only — a real timestamp needs no such handling',
  'api/_is-down/incident-grouping.ts': 'same-day-order precision logic keys on derived === status_history only — a real timestamp needs no such handling',
  'api/is-down-group.ts': 'day-bucket formatting keys on derived === status_history only — a real timestamp needs no such handling',
  'src/pages/Incidents.jsx': 'passes dayOnly, computed from derived === status_history only — moot for a real timestamp',
  'src/pages/ServiceDetails.jsx': 'passes dayOnly, computed from derived === status_history only — moot for a real timestamp',
  'src/pages/Overview.jsx': 'passes dayOnly, computed from derived === status_history only — moot for a real timestamp',

  // Id/title-keyed operator actions and downstream-of-an-already-fixed-gate reads — none make an
  // independent freshness judgment of their own.
  'worker/src/suppression.ts': 'matches by id/title, which a retainedBridge entry carries normally — not a freshness judgment',
  'worker/src/overrides.ts': 'operator-pinned durations keyed on an explicit incident id an operator typed — not a freshness judgment',
  'worker/src/alert-feed.ts': 'only relays alerts buildIncidentAlerts already decided to send — inherits that fix, no independent leak (verified round 8)',
  'worker/src/upstream-feed.ts': 'non-carded upstream feeds; never sees a service incident list',
  'worker/src/withdrawal-log.ts': 'rows render from a tombstone that only exists because withdrawalHold (now fixed) let the withdrawal through',
  'worker/src/probe-archival.ts': 'the incidentWindows param that would read anything is passed by NO production caller (TODO #132)',
  'worker/src/upstream-link.ts': 'consumes incident-text.ts\'s causalIncidents, which already excludes retainedBridge before this file sees it',
  'worker/src/incident-history.ts': 'both callers already gate it before calling buildHistoryRecord — recovery-mark.ts\'s isMarkableOnStatusEdge refuses it, and alerts.ts\'s alerted:res: path only ever processes ids legitimately tracked start-to-finish',
  'src/utils/predictionAccuracy.js': 'every entry point returns early without an ai:analysis — ai-analysis.ts (fixed) never analyzes a retainedBridge incident, so one is never present',
  'src/components/AnalysisModal.jsx': 'renders an AI analysis, which a retainedBridge incident never has (ai-analysis.ts excludes it from analysis entirely)',
  'src/utils/recoveredGrouping.js': 'a row\'s existence comes from the recovered: KV marker, which recovery-mark.ts (now fixed) refuses to write for a retainedBridge incident',

  // Reads nothing that could be wrong either way.
  'worker/src/platform-monitor.ts': 'reads Atlassian\'s OWN meta-status response, not our Incident type at all — a structural regex match, not a real consumer',
  'worker/src/parse-failure-log.ts': 'counts SOURCE-READ failures by reason; reads no incident field at all',
  'src/locales/en.js': 'a flat key→string copy map; the match is a dotted i18n KEY, not a field read',
  'src/locales/ko.js': 'a flat key→string copy map; the match is a dotted i18n KEY, not a field read',
  'api/_is-down/seo-content.ts': 'static per-service SEO copy, no logic',
  'api/_methodology/html-template.ts': 'static prose describing the Score, no logic',
  'api/_is-down/upstream-note.ts': 'renders UpstreamLink records sourced from incident-text.ts\'s causalIncidents, already excluded there',
  'src/components/IncidentTimeline.jsx': 'renders whatever timeline it is given; an empty one (every retainedBridge incident\'s) is already handled as the empty case',
  'src/components/RecentUserReports.jsx': 'user-submitted reports, not provider incidents',
  'src/components/SkeletonUI.jsx': 'loading placeholder — renders no real incident data',
  'src/pages/Settings.jsx': 'subscription toggles keyed on service id',
  'src/pages/Uptime.jsx': 'uptime figures, not incident measurements',
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
    // 72 → 73: #1381 added worker/src/parsers/rootly.ts, a producer (classified SAFE alongside the
    // other parsers). Moving it in the same diff is the point — the number is the scan's own health.
    expect(all.length, 'the detector drifted — it no longer matches what it did when this was pinned').toBe(73)
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

describe('#1384 — every incident-field consumer is classified for retainedBridge too', () => {
  // Same file list as the #1292 describe above (`consumers()` answers one question — "does this file
  // read an incident's measured fields" — that both axes key off). Recomputed here rather than shared
  // so a future split of the two describes stays possible without coupling them.
  const all = consumers()

  it('classifies every file the #1292 scan finds — same list, no drift between the two axes', () => {
    // If this ever fails while the #1292 "finds the consumers" test above still passes at 73, the
    // count didn't change but a file moved in/out — impossible today (both axes scan identically),
    // kept as a canary in case that ever stops being true.
    expect(all.length).toBe(73)
  })

  it('leaves none unclassified for retainedBridge', () => {
    const known = new Set([...Object.keys(RB_APPLIERS), ...Object.keys(RB_FORWARDERS), ...Object.keys(RB_SAFE)])
    const unclassified = all.filter((f) => !known.has(f))
    expect(unclassified,
      'a new consumer of incident measurements appeared. Classify it for retainedBridge too: does it ' +
      'need to exclude a stale bridged ghost from a freshness judgment, forward the tag, or is it safe ' +
      'by construction? Rounds 4-9 of #1384 were all files nobody classified — this gate exists so a ' +
      'tenth round is never needed.',
    ).toEqual([])
  })

  it('lists no retainedBridge registry entry that is no longer a consumer', () => {
    const stale = [...Object.keys(RB_APPLIERS), ...Object.keys(RB_FORWARDERS), ...Object.keys(RB_SAFE)]
      .filter((f) => !all.includes(f))
    expect(stale, 'a registry entry no longer reads incident fields — remove it so the list stays honest').toEqual([])
  })

  it('gives every retainedBridge entry a reason', () => {
    for (const [file, why] of Object.entries({ ...RB_APPLIERS, ...RB_FORWARDERS, ...RB_SAFE })) {
      expect(why.length, `${file} has no stated reason`).toBeGreaterThan(20)
    }
  })

  it('every RB_APPLIER branches on retainedBridge in CODE, not in a comment or the type declaration', () => {
    // Mirrors the #1292 BRANCHES_ON_TAG guard above and the same failure it prevents: a declaration
    // (`retainedBridge?: true` in types.ts) has no operator, and a comment has no code, so strip line
    // comments first and require a real member-access reference — `.retainedBridge` (bare or optional
    // — `?.retainedBridge` contains this substring too) — which only appears where code actually reads
    // the field off an incident, never in a type position.
    const BRANCHES_ON_TAG = /\.retainedBridge\b/
    for (const file of Object.keys(RB_APPLIERS)) {
      const code = fs.readFileSync(path.join(ROOT, file), 'utf-8')
        .replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')
      expect(code, `${file} is registered as applying the retainedBridge rule but never reads the field in code`)
        .toMatch(BRANCHES_ON_TAG)
    }
  })
})
