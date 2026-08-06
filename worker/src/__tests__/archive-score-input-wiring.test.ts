import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #1006 — source-scan wiring guard, in the repo's established idiom (uptime-archive-wiring.test.ts /
// badge-repo-discovery-wiring.test.ts / ai-usage-wiring.test.ts / growth-outage-axis-wiring.test.ts).
//
// THE BUG THIS EXISTS FOR: `uptimeSource` was declared on `ArchiveScoreInput` and consumed by
// `buildMonthlyArchive`, but both archive writers in index.ts hand-rolled their object literal and
// omitted it — so the field had a declaration and a consumer and no producer. `uptimeSource?:` is
// OPTIONAL, so `tsc` cannot see the omission; that is exactly why it lived long enough to ship a
// 2026-07 archive whose Better Stack rows publish as provider-declared.
//
// Why a source scan and not a behavioural test: there are TWO writers, and only one of them
// (/api/admin/rebuild-archive) has an HTTP harness. The other is the monthly CRON — the path that
// actually wrote the broken archive — and nothing in this repo invokes `scheduled()`, so it has no
// behavioural harness to hang an assertion on. A review agent proved the gap by reverting ONLY the
// cron call site to the pre-fix literal: all 4087 tests and `typecheck:worker` stayed green.
//
// The shared constructor removes DRIFT between the two copies, but nothing makes either site keep
// calling it — that invariant was carried only by a code comment, and a comment is not a mechanism.
//
// Verified by DELETING each asserted line, not commenting it out: these are regex scans, so a
// commented-out line still matches and would NOT go red.
const index = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')

describe('#1006 — both archive writers build ArchiveScoreInput through the shared constructor', () => {
  it('delegates at BOTH call sites (cron + admin rebuild)', () => {
    const calls = index.match(/toArchiveScoreInput\(/g) ?? []
    expect(calls, 'expected exactly 2 delegating call sites — the monthly cron and /api/admin/rebuild-archive').toHaveLength(2)
  })

  it('leaves NO hand-rolled ArchiveScoreInput literal behind', () => {
    // Keyed on the CONSTRUCTION shape `{ id: <x>, aiwatchScore: ... }` — a fresh object with its own
    // `id`. That is what an ArchiveScoreInput literal looks like and what both pre-fix copies were.
    // A bare `aiwatchScore:` scan would be wrong: index.ts carries ~8 of them on the /api/status
    // response path, which SPREAD onto an existing service (`{ ...svc, aiwatchScore: s.score }`) and
    // are a different type entirely.
    //
    // What this pattern deliberately does NOT catch: shorthand (`{ id, aiwatchScore:`), a reordered or
    // spread-prefixed literal, a quoted key. Those all evade it — and none of them matter, because the
    // count assertion above catches any of the two writers dropping the constructor. The residual gap
    // is a THIRD hand-rolled writer added later: the count stays 2 and this regex misses it.
    const literals = index.match(/\{\s*id:\s*\w+(\.\w+)?\s*,\s*aiwatchScore:/g) ?? []
    expect(literals, 'an ArchiveScoreInput is being assembled inline in index.ts — build it with toArchiveScoreInput (monthly-archive.ts) instead, or every field added to the interface has to be remembered at each site').toHaveLength(0)
  })
})
