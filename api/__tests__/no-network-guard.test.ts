import { describe, it, expect } from 'vitest'

const URL_ = 'https://aiwatch-worker.p2c2kbf.workers.dev/api/report-feed?svc=claude'

describe('#1683 — the unit suite cannot reach the network', () => {
  it('an unmocked fetch rejects and is recorded', async () => {
    const drain = (globalThis as { __drainUnmockedFetches?: () => string[] }).__drainUnmockedFetches
    expect(drain, 'vitest.setup.js is not loaded').toBeTypeOf('function')
    await expect(fetch(URL_)).rejects.toThrow(`unmocked fetch: ${URL_}`)
    expect(drain!()).toEqual([URL_])
  })

  // The is-down handler swallows its report-feed failure, so the rejection alone failed nothing.
  it.fails('an unmocked fetch whose rejection the caller swallows still fails the test', async () => {
    await fetch(URL_).catch(() => {})
  })
})
