import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { REPORT_GUARD_CLIENT_JS, renderCTA } from '../html-template'
import { getSEOContent } from '../seo-content'
import { extractInlineScripts } from '../../_shared/csp-hash'
// @ts-expect-error — JS module, no types
import { hasReportedToday as spaHas, markReportedToday as spaMark } from '../../../src/utils/reportGuard.js'
// @ts-expect-error — JS module, no types
import { makeLocalStorage, makeThrowingLocalStorage } from '../../../src/utils/__tests__/localStorageStub.js'

// #1369 — "has this browser already reported this service TODAY?" is answered independently on two
// surfaces: the Edge is-down page (inline browser source, no bundle) and the SPA ReportModal (an
// import). They share no module, so the rule is duplicated deliberately — the same way
// hasLiveIncident, SERVICE_SITE_URL and incident-grouping already are, and every one of those ships a
// lockstep test because "deliberate duplicate" and "silent drift" look identical in a diff.
//
// This test EXECUTES the shipped Edge source (`REPORT_GUARD_CLIENT_JS`, the exact string interpolated
// into the page's <script>) rather than a TypeScript twin of it. A twin would have stayed green
// through the original defect: what shipped stored `'1'` forever, and only running the shipped text
// can tell you that.
//
// The drift to fear is the UTC/local one. `worker/src/report.ts` `reportDateKey` is
// `toISOString().slice(0, 10)`; a copy "fixed" to a local date (`toLocaleDateString`, or a
// `getFullYear()/getMonth()` build-up) disagrees with the server — and with the other copy — for part
// of every day in every non-UTC timezone, which is silent everywhere the developer happens to sit.

/** The shipped Edge snippet, executed. Its functions close over the ambient `localStorage`/`Date`. */
function loadEdgeGuard(): {
  reportGuardKey: (svc: string) => string
  reportGuardDay: () => string
  reportGuardHasToday: (svc: string) => boolean
  reportGuardMarkToday: (svc: string) => void
} {
  return new Function(
    `${REPORT_GUARD_CLIENT_JS}\nreturn {reportGuardKey,reportGuardDay,reportGuardHasToday,reportGuardMarkToday}`,
  )()
}

// The timezone is pinned, not inherited. Every UTC-vs-local assertion below is VACUOUS on a UTC
// runner — and CI is UTC (`ubuntu-latest`, no `TZ` set in any workflow), so the one drift this file
// exists to catch would have passed there while failing on a Seoul laptop. Node re-reads `process.env.TZ`
// on assignment, so setting it here binds the whole file regardless of where it runs.
process.env.TZ = 'Asia/Seoul'

const T = (iso: string) => Date.parse(iso)

describe('report guard Edge↔SPA parity (#1369)', () => {
  let edge: ReturnType<typeof loadEdgeGuard>

  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorage())
    vi.useFakeTimers()
    vi.setSystemTime(T('2026-09-09T12:00:00Z'))
    edge = loadEdgeGuard()
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  const cases: Array<[string, string | null]> = [
    ['nothing stored', null],
    ["today's UTC stamp — the only value that gates", '2026-09-09'],
    ['yesterday — the rollover the server does on its own', '2026-09-08'],
    ['a month ago', '2026-08-09'],
    ["the legacy permanent value '1'", '1'],
    ['empty string', ''],
    ['a future date', '2099-01-01'],
    ['garbage', 'yes'],
  ]

  it.each(cases)('%s — both copies agree', (_label, stored) => {
    if (stored !== null) localStorage.setItem('aiwatch-reported-claude', stored)
    expect(edge.reportGuardHasToday('claude')).toBe(spaHas('claude'))
  })

  it('pins the DIRECTION, not just agreement — today gates, an earlier day and the legacy value do not', () => {
    // Two copies wrong in the SAME way would satisfy the parity assertion above on its own. This is
    // the assertion the original defect fails: with `!!getItem(k)` both sides return true for '1'.
    localStorage.setItem('aiwatch-reported-claude', '2026-09-09')
    expect(edge.reportGuardHasToday('claude')).toBe(true)
    expect(spaHas('claude')).toBe(true)

    for (const stale of ['2026-09-08', '1']) {
      localStorage.setItem('aiwatch-reported-claude', stale)
      expect(edge.reportGuardHasToday('claude')).toBe(false)
      expect(spaHas('claude')).toBe(false)
    }
  })

  it('writes the same key and the same value, so a report on either surface is seen by the other', () => {
    edge.reportGuardMarkToday('claude')
    expect(localStorage.getItem('aiwatch-reported-claude')).toBe('2026-09-09')
    expect(spaHas('claude')).toBe(true) // Edge report → dashboard sees it

    localStorage.clear()
    spaMark('claude')
    expect(edge.reportGuardHasToday('claude')).toBe(true) // dashboard report → Edge page sees it
    expect(edge.reportGuardKey('claude')).toBe('aiwatch-reported-claude')
  })

  it('rolls over at UTC midnight on both copies, not local midnight', () => {
    edge.reportGuardMarkToday('claude')
    expect(edge.reportGuardHasToday('claude')).toBe(true)
    expect(spaHas('claude')).toBe(true)

    vi.setSystemTime(T('2026-09-10T00:00:01Z'))
    expect(edge.reportGuardDay()).toBe('2026-09-10')
    expect(edge.reportGuardHasToday('claude')).toBe(false)
    expect(spaHas('claude')).toBe(false)
  })

  it('both stamp the UTC day for a time that is already tomorrow locally in UTC+9', () => {
    // 2026-09-09T23:30Z is 2026-09-10 08:30 in Seoul. A local-date copy would stamp '2026-09-10'
    // and disagree with the server for the rest of the UTC day.
    vi.setSystemTime(T('2026-09-09T23:30:00Z'))
    edge.reportGuardMarkToday('claude')
    expect(localStorage.getItem('aiwatch-reported-claude')).toBe('2026-09-09')
    localStorage.clear()
    spaMark('claude')
    expect(localStorage.getItem('aiwatch-reported-claude')).toBe('2026-09-09')
  })

  it('degrades to OPEN on both copies when localStorage throws (private mode)', () => {
    vi.stubGlobal('localStorage', makeThrowingLocalStorage())
    expect(edge.reportGuardHasToday('claude')).toBe(false)
    expect(spaHas('claude')).toBe(false)
    expect(() => edge.reportGuardMarkToday('claude')).not.toThrow()
    expect(() => spaMark('claude')).not.toThrow()
  })
})

// Executing the exported constant proves the RULE. It does not prove the PAGE gates on it — the
// constant could be interpolated and never consulted. These run the page: the rendered markup goes
// into a document, the page's own inline script executes against it, and the FAB is read the way a
// visitor sees it.
//
// This is deliberately behavioural rather than a `toContain` over the source. Two rounds of review
// broke string assertions here: `toContain('reportGuardHasToday(svc)')` over the whole page is
// satisfied by the guard's own `function reportGuardHasToday(svc){...}` declaration, and cutting the
// guard source out first still leaves the page's one-line wrapper `function reported(){return
// reportGuardHasToday(svc)}` — so deleting both `if(reported())` call sites kept every assertion
// green while the FAB gated on nothing. A source pin is a hand-written parser for a language that
// always wins (memory `feedback_pin_the_decision_not_the_spelling`); running the script ends that
// class of hole instead of patching it a third time.
describe('the is-down page gates its FAB on the guard (#1369)', () => {
  const html = renderCTA(getSEOContent('claude-api')!, 'down', 'is-claude-api-down', 'claude')

  /** Render the CTA into the document and execute its inline script, as a browser would. Scripts
   *  injected via innerHTML never run, so the page's own script is executed explicitly. */
  function bootPage(stored: string | null) {
    vi.stubGlobal('localStorage', makeLocalStorage())
    if (stored !== null) localStorage.setItem('aiwatch-reported-claude', stored)
    document.body.innerHTML = html
    const scripts = extractInlineScripts(html)
    expect(scripts.length, 'renderCTA emits exactly one executable inline script').toBe(1)
    new Function(scripts[0])()
    const fab = document.getElementById('report-open') as HTMLButtonElement
    const modal = document.getElementById('report-modal') as HTMLElement
    expect(fab, 'the FAB is in the rendered markup').toBeTruthy()
    return { fab, modal }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T('2026-09-09T12:00:00Z'))
  })
  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('disables the FAB on load for a report made TODAY, and says so', () => {
    const { fab } = bootPage('2026-09-09')
    expect(fab.disabled).toBe(true)
    // The label has to say "today" — the SPA's `report.already` copy promises a daily reset, and this
    // surface was the one that did not.
    expect(fab.textContent).toContain('Already reported today')
  })

  it('leaves the FAB live for a report made on an earlier day', () => {
    const { fab } = bootPage('2026-09-08')
    expect(fab.disabled).toBe(false)
    expect(fab.textContent).not.toContain('Already reported')
  })

  it("leaves the FAB live for the legacy permanent '1', and the modal opens", () => {
    // The self-heal path: every browser locked out by the old guard holds `'1'`, and must be able to
    // report again with no migration.
    const { fab, modal } = bootPage('1')
    expect(fab.disabled).toBe(false)
    expect(modal.hidden).toBe(true)
    fab.click()
    expect(modal.hidden).toBe(false)
  })

  it('opens the modal when nothing is stored', () => {
    const { fab, modal } = bootPage(null)
    fab.click()
    expect(modal.hidden).toBe(false)
  })

  it('refuses to open the modal if the guard closed after load', () => {
    // Pins the CLICK-handler branch specifically. The load-time check cannot cover it: when the guard
    // is already closed at load the FAB is disabled, so the click path never runs. Reporting in
    // another tab is the real-world version of this.
    const { fab, modal } = bootPage('1')
    localStorage.setItem('aiwatch-reported-claude', '2026-09-09')
    fab.click()
    expect(modal.hidden).toBe(true)
    expect(fab.disabled).toBe(true)
  })

  it('arms the guard with today\'s stamp after a successful submit', () => {
    // Pins `reportGuardMarkToday` at the call site. Without it the FAB re-enables on the next load
    // and the same visitor is counted again — the open direction failing, rather than the closed one.
    const { fab, modal } = bootPage(null)
    fab.click()
    expect(modal.hidden).toBe(false)
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
    vi.stubGlobal('fetch', fetchMock)
    ;(document.getElementById('report-submit') as HTMLButtonElement).click()
    return vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(localStorage.getItem('aiwatch-reported-claude')).toBe('2026-09-09')
      expect(fab.disabled).toBe(true)
    })
  })
})
