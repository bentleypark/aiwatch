import { afterEach } from 'vitest'

// #1683 — no unit test reaches the network. The is-down handler's report-feed call sits in a
// try/catch, so an unmocked call there was a silent real request to the production worker that
// timed tests out at random. A test that needs `fetch` stubs it (vi.spyOn / vi.stubGlobal); any call
// that falls through to here fails the test running when the call is made.
const unmocked = []

globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  unmocked.push(url)
  throw new Error(`unmocked fetch: ${url}`)
}

globalThis.__drainUnmockedFetches = () => unmocked.splice(0)

afterEach(() => {
  const urls = globalThis.__drainUnmockedFetches()
  if (urls.length > 0) throw new Error(`test reached the network (mock these fetch calls): ${urls.join(', ')}`)
})
