// #1390 — `buildCalendarFromIncidents` decides whether to supplement the calendar with individual
// incidents by asking whether `dailyImpact` already accounts for every day. That answer is a PROPERTY
// OF THE PAYLOAD (`service.dailyImpactComplete`), not of the window length — but it only reaches the
// function as a 5th positional argument, and dropping it at a call site silently restores the old
// `days === 30` derivation with every unit test still green.
//
// Round 1 of #1390's review named this as the gap: `calendar.test.js` proves the function, and nothing
// proved the three call sites. `Overview.jsx` is the load-bearing one — it hardcodes `days = 30` for
// every service regardless of `calendarDays`, which is why six services beyond perplexity were affected.
//
// Same mechanism and same reason as `derived-date-precision-wiring.test.js`: scan the source rather
// than trust a sweep, because the failure is a per-call-site argument pass.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const JSX_FILES = (function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__') walk(p, acc); continue }
    if (/\.(jsx|js)$/.test(e.name) && !e.name.includes('.test.')) acc.push(p)
  }
  return acc
})(SRC)

/** Every `buildCalendarFromIncidents(...)` call in src/, with its argument list. */
function calendarCalls() {
  const out = []
  for (const file of JSX_FILES) {
    const code = fs.readFileSync(file, 'utf-8')
    for (const m of code.matchAll(/buildCalendarFromIncidents\(([^)]*)\)/g)) {
      // The declaration in calendar.js itself is `export function buildCalendarFromIncidents(` — no
      // preceding `=` or `{`, and it is the only match in that file.
      if (file.endsWith('utils/calendar.js')) continue
      out.push({ file: path.relative(SRC, file), args: m[1] })
    }
  }
  return out
}

describe('#1390 — every calendar call site passes the provenance flag', () => {
  const calls = calendarCalls()

  it('finds the call sites (the scan is not vacuous)', () => {
    // Pinned, not a floor: the failure this guards is the scan going quiet. A legitimate new render
    // moves this number in the same diff.
    expect(calls.length, 'the scan drifted — it no longer finds what it did when this was pinned').toBe(3)
    expect(calls.map((c) => c.file).sort()).toEqual(['pages/Overview.jsx', 'pages/Overview.jsx', 'pages/ServiceDetails.jsx'])
  })

  it('passes dailyImpactComplete at every one', () => {
    for (const { file, args } of calls) {
      expect(args, `${file}: buildCalendarFromIncidents(${args}) drops the provenance flag, so this ` +
        'call silently falls back to the days === 30 derivation #1390 replaced')
        .toMatch(/dailyImpactComplete/)
    }
  })
})

// #1390 — the same class, one file over: a resolved incident with no duration must not render as
// "Ongoing". `incidentDurationText` holds that rule; reverting either Incidents.jsx row to the raw
// `incident.duration ?? t('incidents.duration.ongoing')` leaves incidentSort.test.js green.
describe('#1390 — no render bypasses incidentDurationText for an incident duration', () => {
  it('no file falls back straight from a duration to the ongoing label', () => {
    const offenders = []
    for (const file of JSX_FILES) {
      const code = fs.readFileSync(file, 'utf-8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')
      if (/\.duration\s*\?\?\s*t\(\s*['"]incidents\.duration\.ongoing['"]/.test(code)) offenders.push(path.relative(SRC, file))
    }
    expect(offenders, 'an incident duration is rendered with a raw ongoing fallback — a RESOLVED ' +
      'incident with no duration would read as still running. Route it through incidentDurationText.')
      .toEqual([])
  })

  it('the scan would catch the pattern it was written for', () => {
    // Without this the assertion above passes on a regex that matches nothing.
    const sample = "{incident.duration ?? t('incidents.duration.ongoing')}"
    expect(/\.duration\s*\?\?\s*t\(\s*['"]incidents\.duration\.ongoing['"]/.test(sample)).toBe(true)
  })
})
