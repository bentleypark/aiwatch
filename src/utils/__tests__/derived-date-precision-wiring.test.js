// #1292 — every render of an INCIDENT's own timestamp must pass BOTH `dayOnly` and `day`.
//
// A `status_history`-derived incident's `startedAt` is AIWatch's own anchor inside the day, not a
// provider-published instant, so printing it at minute precision asserts a window the provider's own
// page contradicts — and `dayOnly` alone still formats that anchor, which lands on the wrong DATE for
// a viewer far enough from the page. `day` is what makes the render read the stated day instead. `formatDate`'s `{ dayOnly }` and `getContextualTime`'s flag are both unit-tested —
// but the WIRING is a per-call-site prop pass, and one site was missed on the first pass (Overview's
// `title=` tooltip, where `ctx.dayOnly` was already in scope on the line above). Its visible cell
// escaped only because an unrelated `.split(' ').slice(0, 2)` truncation happened to drop the time.
//
// So this scans the source instead of trusting the sweep. Group-range renders (`group.rangeStart` /
// `rangeEnd`) are deliberately out of scope: a group needs ≥2 same-(day, title) incidents and a
// derived one is emitted once per (resource, day), so it can never form one.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
// Every .jsx under src/, not just src/pages: a component can render an incident timestamp too, and
// scoping this to one directory made the scan blind to exactly the files nobody thought to list.
const JSX_FILES = (function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(path.join(dir, e.name), acc); continue }
    if (e.name.endsWith('.jsx')) acc.push(path.join(dir, e.name))
  }
  return acc
})(SRC)
// EVERY `formatDate(` call, then subtract the one shape that is provably safe. Keying on the
// receiver name instead (`ctx.date` / `incident.startedAt`) went blind the moment a variable was
// renamed — verified by mutation — because an unmatched call is an absent call, not a failing one.
// CALLS only — `function formatDate(iso, lang)` is a declaration, and a file that defines its own
// local formatter (IncidentTimeline.jsx does) would otherwise be reported for its own signature.
const ANY_FORMAT_DATE = /(?<!function\s)formatDate\(([^)]*)\)/g
// A GROUP range never carries a derived incident: grouping needs >=2 same-(day, normalized-title)
// rows and a derived incident is emitted once per (resource, day). Pinned by the grouping tests.
const GROUP_RANGE_ARG = /^\s*group\.range(Start|End)\b/
// A TIMELINE STEP's `at` is not the incident's own timestamp — it is a provider-published update time
// from `inc.timeline`, and a synthesized incident's timeline is always empty (pinned below), so no
// step of one can ever be rendered. Carved out structurally, by the ARGUMENT, for the same reason the
// group range is: a per-file exemption list is the hand-written list this whole scan replaces.
const TIMELINE_STEP_ARG = /^\s*at\s*,/

describe('#1292 — incident timestamps are never rendered at minute precision unguarded', () => {
  const files = JSX_FILES.map((f) => path.relative(SRC, f))

  it('finds the call sites it is meant to guard (the scan itself is not vacuous)', () => {
    const total = files.reduce((n, f) => n + [...fs.readFileSync(path.join(SRC, f), 'utf-8')
      .matchAll(ANY_FORMAT_DATE)].filter((m) => !GROUP_RANGE_ARG.test(m[1]) && !TIMELINE_STEP_ARG.test(m[1])).length, 0)
    expect(total, 'no incident-date renders found — the regex has drifted from the source').toBeGreaterThan(3)
  })

  // Per FILE, not just globally: a receiver rename in one page (`incident` → `inc`) would blank that
  // file's matches while the global count stayed above the floor, leaving every call site in it
  // unguarded and the suite green — the exact silent-pass this test exists to prevent.
  it.each(['pages/Incidents.jsx', 'pages/ServiceDetails.jsx', 'pages/Overview.jsx'])('%s passes dayOnly everywhere', (file) => {
    const src = fs.readFileSync(path.join(SRC, file), 'utf-8')
    const calls = [...src.matchAll(ANY_FORMAT_DATE)].filter((m) => !GROUP_RANGE_ARG.test(m[1]) && !TIMELINE_STEP_ARG.test(m[1]))
    expect(calls.length, `${file}: no incident-date render found — this scan has gone blind`).toBeGreaterThan(0)
    expect(calls.map((m) => m[0]).filter((c) => !c.includes('dayOnly')),
      `${file} renders an incident timestamp without dayOnly`).toEqual([])
    expect(calls.map((m) => m[0]).filter((c) => !/\bday:/.test(c)),
      `${file} passes dayOnly but not the day — the anchor would still pick the date`).toEqual([])
  })

  it('scans EVERY .jsx under src/, so a new one cannot slip past the hard-coded list', () => {
    const listed = ['pages/Incidents.jsx', 'pages/ServiceDetails.jsx', 'pages/Overview.jsx']
    const unlisted = files.filter((f) => !listed.includes(f))
    const offenders = unlisted.filter((f) => [...fs.readFileSync(path.join(SRC, f), 'utf-8').matchAll(ANY_FORMAT_DATE)]
      .filter((m) => !GROUP_RANGE_ARG.test(m[1]) && !TIMELINE_STEP_ARG.test(m[1])).some((m) => !m[0].includes('dayOnly') || !/\bday:/.test(m[0])))
    expect(offenders, 'a page outside the list renders an incident timestamp without dayOnly + day').toEqual([])
  })
})
