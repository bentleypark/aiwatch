// #1886 — the SPA's browser floor is a decision, not a toolchain default.
import { describe, it, expect } from 'vitest'
import config, { BROWSER_FLOOR, serviceWorkerBuildConfig } from '../../vite.config.js'

describe('browser floor', () => {
  it("matches Tailwind v4's compatibility floor", () => {
    expect(BROWSER_FLOOR).toEqual(['chrome111', 'edge111', 'firefox128', 'safari16.4', 'ios16.4'])
  })

  it('is what the SPA build targets, for JS and CSS', () => {
    expect(config.build.target).toBe(BROWSER_FLOOR)
    expect(config.build.cssTarget).toBe(BROWSER_FLOOR)
  })

  it('is what the separate service-worker build targets', () => {
    expect(serviceWorkerBuildConfig('dist', 'v').build.target).toBe(BROWSER_FLOOR)
  })
})
