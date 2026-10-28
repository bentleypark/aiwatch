import { vi } from 'vitest'
import { buildStatusView, parseStatusView, type LeanStatusPayload } from '../../worker/src/status-view'
import { LAST_GOOD_COPY_URL } from '../../worker/src/last-good-copy-path'

const urlOf = (input: RequestInfo | URL) => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

/** #1831 — a page asks the Worker for a `?view=`, which the Worker cuts from the full payload
 *  (worker/src/status-view.ts). Tests keep handing the full payload; this answers the way the Worker
 *  does. A non-2xx, unparseable or service-less body is passed through untouched. */
export async function asWorkerView(input: RequestInfo | URL, res: Response): Promise<Response> {
  const view = parseStatusView(new URL(urlOf(input)).searchParams)
  if (!view || !res.ok) return res
  let payload: LeanStatusPayload
  try {
    payload = await res.clone().json()
  } catch {
    return res
  }
  if (!Array.isArray(payload?.services)) return res
  return new Response(JSON.stringify(buildStatusView(view, payload)), { status: res.status, headers: res.headers })
}

/** A fetch spy whose `mockResolvedValueOnce` answers through `asWorkerView`. */
export function spyFetchAsWorker() {
  const spy = vi.spyOn(globalThis, 'fetch')
  spy.mockResolvedValueOnce = ((res: Response) =>
    spy.mockImplementationOnce((input) => asWorkerView(input, res))) as typeof spy.mockResolvedValueOnce
  return spy
}

// #1683 — spy on fetch with the is-down handler's crowd-report call answered (no reports). Its status
// call stays per-test (`mockResolvedValueOnce`); any other URL falls through to the no-network guard in
// vitest.setup.js and fails the test.
export function spyFetchWithEmptyReportFeed() {
  const guard = globalThis.fetch
  return spyFetchAsWorker().mockImplementation(async (input, init) => {
    if (urlOf(input).includes('/api/report-feed')) {
      return new Response(JSON.stringify({ reports: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (urlOf(input) === LAST_GOOD_COPY_URL) return new Response('', { status: 404 })
    return guard(input, init)
  })
}
