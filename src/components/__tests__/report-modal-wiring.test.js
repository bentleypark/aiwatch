import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { makeLocalStorage } from '../../utils/__tests__/localStorageStub'

// #1369 — the RULE (`hasReportedToday`) is unit-tested in `utils/__tests__/reportGuard.test.js`, and
// the Edge copy of it in `api/_is-down/__tests__/report-guard-sync.test.ts`. This file pins the SPA
// CALL SITES, because a green pure function is not a green call site
// (`feedback_mutation_test_both_directions`), and here that gap is not hypothetical: replacing the
// import in ReportModal.jsx with a local `!!localStorage.getItem(...)` — the shipped #1369 defect,
// verbatim — left `npm run test:src` at 1397/1397 before this file existed. No test in the repo
// referenced ReportModal at all, and the two Playwright specs that open it only walk the happy-path
// submit, never reaching the 'already' state.
//
// The state must be produced by the component's own effect, not by SSR: `state` initialises to 'idle'
// and only becomes 'already' inside `useEffect`, which `renderToStaticMarkup` never runs. So these
// render on the client, through `act`.
//
// `t` is stubbed to return the key, so 'report.already' in the output means the already-reported
// branch rendered and 'report.service' means the input form did.
//
// All FOUR guard call sites are covered, not the two the mount/select paths use: `submit()` re-checks
// the guard before the fetch, and `markReportedToday` on success is the only thing that ever ARMS the
// dashboard guard. Round 2 caught both of those unpinned — deleting either left the whole suite green
// — so the submit-path cases below exist to make each one's removal red.

vi.mock('../../hooks/useLang', () => ({ useLang: () => ({ t: (k) => k, lang: 'en' }) }))
vi.mock('../../utils/analytics', () => ({ trackEvent: vi.fn() }))

const { default: ReportModal } = await import('../ReportModal')

const SERVICES = [
  { id: 'claude', name: 'Claude API' },
  { id: 'openai', name: 'OpenAI API' },
]

const TODAY = '2026-09-09'
const YESTERDAY = '2026-09-08'

let container
let root

async function render(props) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(createElement(ReportModal, { isOpen: true, onClose: () => {}, services: SERVICES, ...props })) })
  // The <dialog> renders into the container; read from the container, not document.body.
  return container
}

/** Which branch is on screen — the two are mutually exclusive in the component. */
function branch(el) {
  const text = el.textContent
  if (text.includes('report.already')) return 'already'
  if (text.includes('report.service')) return 'form'
  return `unrecognized: ${text.slice(0, 80)}`
}

describe('ReportModal call sites read the daily guard (#1369)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorage())
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(Date.parse(`${TODAY}T12:00:00Z`))
  })
  afterEach(async () => {
    if (root) await act(async () => root.unmount())
    container?.remove()
    root = undefined
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // ── ServiceDetails entry point (presetServiceId) — the mount-time effect decides the branch ──

  it('opens into the already-reported state for a report made TODAY', () => {
    localStorage.setItem('aiwatch-reported-claude', TODAY)
    return render({ presetServiceId: 'claude' }).then((el) => expect(branch(el)).toBe('already'))
  })

  it('opens into the FORM for a report made on an earlier day', async () => {
    localStorage.setItem('aiwatch-reported-claude', YESTERDAY)
    expect(branch(await render({ presetServiceId: 'claude' }))).toBe('form')
  })

  it("opens into the FORM for the legacy permanent '1' — the locked-out user self-heals", async () => {
    // THE discriminating case. Under the pre-#1369 presence check this renders 'already', which is
    // the defect: the modal opens locked for a report that may be months old.
    localStorage.setItem('aiwatch-reported-claude', '1')
    expect(branch(await render({ presetServiceId: 'claude' }))).toBe('form')
  })

  it('is per service — a report on claude does not lock openai', async () => {
    localStorage.setItem('aiwatch-reported-claude', TODAY)
    expect(branch(await render({ presetServiceId: 'openai' }))).toBe('form')
  })

  // ── Overview entry point (no preset) — the guard is re-read when the user picks a service ──

  async function pick(el, svcId) {
    const select = el.querySelector('#report-svc')
    expect(select, 'the service dropdown renders when no service is preset').toBeTruthy()
    await act(async () => {
      select.value = svcId
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    return branch(el)
  }

  it('flips to already-reported when the picked service was reported TODAY', async () => {
    localStorage.setItem('aiwatch-reported-claude', TODAY)
    const el = await render({})
    expect(branch(el)).toBe('form') // no preset → starts on the form regardless
    expect(await pick(el, 'claude')).toBe('already')
  })

  it("keeps the form for a picked service whose stored value is the legacy '1'", async () => {
    // The Overview path is the one where the old guard was worst: the form rendered, the user typed a
    // description, and `submit()` short-circuited before the fetch — discarding the input silently.
    localStorage.setItem('aiwatch-reported-claude', '1')
    const el = await render({})
    expect(await pick(el, 'claude')).toBe('form')
  })

  it('keeps the form for a picked service reported on an earlier day', async () => {
    localStorage.setItem('aiwatch-reported-claude', YESTERDAY)
    const el = await render({})
    expect(await pick(el, 'claude')).toBe('form')
  })

  // ── submit() — the pre-flight guard, and the write that arms it ──

  const submitBtn = (el) => [...el.querySelectorAll('button')].find((b) => b.textContent.includes('report.submit'))

  it("arms the guard with today's stamp after a successful submit", async () => {
    // Without `markReportedToday` the dashboard never gates at all: the modal reopens clean on the
    // next visit and the same visitor reports again. That is the OPEN direction failing.
    localStorage.setItem('aiwatch-reported-claude', '1')
    const el = await render({ presetServiceId: 'claude' })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    await act(async () => { submitBtn(el).click() })
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(localStorage.getItem('aiwatch-reported-claude')).toBe(TODAY)
    })
  })

  it('does not POST when the service was already reported today', async () => {
    // `submit()` re-reads the guard because the Overview path can reach this button with a service the
    // mount effect never saw. Dropping that check sends a duplicate the server would discard anyway —
    // but the version of this bug that mattered ran the OTHER way: the old permanent guard discarded
    // a description the user had already typed, before the fetch, with no message.
    const el = await render({})
    await pick(el, 'claude') // guard open at pick time → the form stays, the button enables
    localStorage.setItem('aiwatch-reported-claude', TODAY)
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    await act(async () => { submitBtn(el).click() })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(branch(el)).toBe('already')
  })
})
