// #868 — parseUptimeData must handle the NEW Atlassian Statuspage embed format
// (`window.uptimeData = {…}` + a `var uptimeData = window.uptimeData;` alias), which silently broke
// uptime capture for claude.ai / Cursor / Windsurf / Junie / Voyage AI (they dropped from the ranking).
import { describe, it, expect } from 'vitest'
import { parseUptimeData } from '../parsers/statuspage'

// A component with 2 valid days: one clean, one with a minor (partial) outage of 864s.
// weighted = MINOR_WEIGHT(0.3) * 864 = 259.2 over 2 days (172800s) → 99.85%.
const DAYS = '"days":[{"date":"2026-07-01","outages":{"p":0,"m":0}},{"date":"2026-07-02","outages":{"p":864,"m":0}}]'
const OBJ = `{"comp1":{"component":{"code":"comp1","name":"API"},${DAYS}}}`

describe('parseUptimeData embed-format handling (#868)', () => {
  it('NEW format: `window.uptimeData = {…}` + `var uptimeData = window.uptimeData;` alias', () => {
    // The alias line is what the old code wrongly matched (→ JSON.parse("window.upt…") threw).
    const html = `<script>\n  window.uptimeData = ${OBJ};\n  var uptimeData = window.uptimeData;\n</script>`
    const r = parseUptimeData(html, 'comp1')
    expect(r.uptimePercent).toBe(99.85)
    expect(r.dailyImpact['2026-07-02']).toBe('major') // minor/partial outage → orange
  })

  it('NEW format still works when the alias line appears BEFORE the data assignment', () => {
    const html = `<script>\n  var uptimeData = window.uptimeData;\n  window.uptimeData = ${OBJ};\n</script>`
    expect(parseUptimeData(html, 'comp1').uptimePercent).toBe(99.85)
  })

  it('OLD format regression: `var uptimeData = {…}` still parses', () => {
    const html = `<script>var uptimeData = ${OBJ};</script>`
    expect(parseUptimeData(html, 'comp1').uptimePercent).toBe(99.85)
  })

  it('MINIFIED/whitespace-variant: `window.uptimeData={…}` (no spaces) still parses (#868 hardening)', () => {
    const html = `<script>window.uptimeData=${OBJ};var uptimeData=window.uptimeData;</script>`
    expect(parseUptimeData(html, 'comp1').uptimePercent).toBe(99.85)
  })

  it('returns null (no throw) when no uptimeData embed is present', () => {
    expect(parseUptimeData('<html><body>no data here</body></html>', 'comp1')).toEqual({ dailyImpact: {}, uptimePercent: null, windowDays: null, uptimeReported: null, uptimeReportedDays: null })
  })

  it('returns null for a component id not present in the data (no throw)', () => {
    const html = `<script>window.uptimeData = ${OBJ}; var uptimeData = window.uptimeData;</script>`
    expect(parseUptimeData(html, 'missing').uptimePercent).toBeNull()
  })

  it('the alias-only line without a real data object yields null, not a throw', () => {
    // Defensive: if only `var uptimeData = window.uptimeData;` exists (no `{`), skip gracefully.
    const html = `<script>var uptimeData = window.uptimeData;</script>`
    expect(parseUptimeData(html, 'comp1').uptimePercent).toBeNull()
  })
})
