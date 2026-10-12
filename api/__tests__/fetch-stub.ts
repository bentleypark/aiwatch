import { vi } from 'vitest'

// #1683 — spy on fetch with the is-down handler's crowd-report call answered (no reports). Its status
// call stays per-test (`mockResolvedValueOnce`); any other URL falls through to the no-network guard
// in vitest.setup.js and fails the test.
export function spyFetchWithEmptyReportFeed() {
  const guard = globalThis.fetch
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/api/report-feed')) {
      return new Response(JSON.stringify({ reports: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return guard(input, init)
  })
}
