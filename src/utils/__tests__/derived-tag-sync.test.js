// #1292 — the `derived: 'status_history'` rule is applied in THREE runtimes and cannot be a single
// import: the worker bundle (`worker/src/score.ts`), the SPA bundle (`src/utils/*`) and the Edge
// functions (`api/_is-down/*`) do not share a module graph, and pulling worker code into the SPA
// bundle for one string literal is not worth the build coupling.
//
// So it is a MIRROR, pinned here — the same treatment `service-groups.ts` gets against
// `SERVICE_CATEGORIES` (aiwatch#1068). Without this, "the three agree" is an assertion in a comment;
// rounds 5, 6 and 7 each found a consumer that did not, so the assertion had to become a check.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const TAG = "'status_history'"

// Files that APPLY the rule. The list is the point; the per-file "guard token" that used to sit
// beside each entry was DELETED in round 12 rather than strengthened. It was decoration: `'continue'`
// occurs 17× in monthly-archive.ts and 9× in rss.ts, `'filter'` 3× in recovery.js, and two entries
// (`carriesRecoveryTime`, `isDailyRecordIncident`) were satisfied by the guard's own DECLARATION. All
// of the work was being done by `toContain(TAG)` below. Enforcement that the file actually BRANCHES on
// the tag in code now lives in one place — derived-consumer-registry.test.js — where the check is
// comment- and declaration-proof and the list is derived rather than hand-written.
const APPLIERS = [
  'worker/src/score.ts',                  // Score: MTTR sample + Recovery default
  'worker/src/incident-history.ts',       // the permanent RAG corpus
  'worker/src/monthly-archive.ts',        // published "avg recovery"
  'worker/src/rss.ts',                    // /feed resolved items
  'src/utils/recovery.js',                // dashboard Recovery card
  'src/utils/incidentSort.js',            // date precision
  'src/utils/incidentGrouping.js',        // never flap-grouped
  'api/_is-down/html-template.ts',        // Edge: date precision + avg recovery
  'api/_is-down/incident-grouping.ts',    // Edge: never flap-grouped
  'api/is-down-group.ts',                 // family page: "resolved after" phrasing
  'worker/src/ai-analysis.ts',            // the LLM's historical grounding
  'worker/src/growth-series.ts',          // outage-day axis, no TTL
  'worker/src/alerts.ts',                 // cannot silence a degraded alert nor caption 🟢 Recovered
  'worker/src/recovery-mark.ts',          // no recovered: marker, so no "Recently Resolved" banner
]

// Files that FORWARD the tag across a boundary. They must not test its value — they must not DROP it.
// Every guard above is silently bypassed for anything that round-trips through one of these, which is
// exactly how the archive path was missed.
const FORWARDERS = [
  ['worker/src/monthly-archive.ts', 'incidents:monthly write + computeMonthlyScore read'],
  ['src/utils/archiveMerge.js', 'archive entry → live incident shape'],
  ['worker/src/index.ts', '/api/v1/status/:id projection'],
]

describe('#1292 — every runtime applies the derived-incident rule', () => {
  it.each(APPLIERS)('%s still references the tag', (file) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf-8')
    expect(src, `${file} no longer references ${TAG} — the mirror was dropped`).toContain(TAG)
  })

  it('spells the tag identically everywhere — a typo would silently disable one runtime', () => {
    for (const file of APPLIERS) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf-8')
      const spellings = [...src.matchAll(/'status[_-]?history'/gi)].map((m) => m[0])
      expect(new Set(spellings), `${file} spells the tag inconsistently`).toEqual(new Set([TAG]))
    }
  })

  it.each(FORWARDERS)('%s forwards `derived` across the boundary (%s)', (file) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf-8')
    // The `derived?: 'status_history'` alternative was REMOVED in round 12: it is a type DECLARATION,
    // and monthly-archive.ts carries one, so deleting both the write and the read left this green —
    // the identical mechanism that let round 10 ship two unenforced guards.
    // Both halves of the pair are required: a forwarder that keeps the tag but drops the day publishes
    // the anchor's date, which is the round-9 defect.
    expect(src, `${file} stopped forwarding \`derived\` — every downstream guard is now bypassed`)
      .toMatch(/derived: (inc|i|e|archIncident)\.derived/)
    expect(src, `${file} forwards \`derived\` but drops \`derivedDay\` — the date reverts to the anchor`)
      .toMatch(/derivedDay: (inc|i|e|archIncident)\.derivedDay/)
  })
})
